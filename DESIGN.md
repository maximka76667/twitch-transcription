# Twitch Live Transcription — Design Notes

## Goal

Learn MLOps by building a live speech-to-text pipeline for Twitch streams, using
real Kafka, Terraform, and AWS rather than easier local substitutes.

"Video-to-text" here means **audio** transcription (speech-to-text), not OCR /
reading on-screen text.

## Current architecture (built, working)

```
streamlink (--twitch-low-latency)
  -> ffmpeg (segments audio into fixed-length 16kHz mono WAV chunks)
  -> ingest.py (reads completed chunk files, publishes bytes to Kafka, deletes file)
  -> Kafka topic "audio-chunks" (apache/kafka:3.9.0, KRaft mode, single broker)
  -> transcriber.py (Kafka consumer group "asr-workers", faster-whisper on in-memory buffer)
  -> Kafka topic "transcripts"
  -> api.py (Kafka consumer group "api-workers", FastAPI, pushes to open websockets)
  -> browser (ws://.../ws/transcripts/{streamer_id})
```

All 4 pieces (`kafka`, `ingest`, `transcriber`, `api`) run as services in one
`docker-compose.yml`, each with its own Dockerfile (different dependencies:
streamlink+ffmpeg vs faster-whisper vs fastapi/uvicorn). `transcriber.py` is
both a consumer (of `audio-chunks`) and a producer (of `transcripts`) — a
standard consume-transform-produce stream processor, not a layering mistake;
what to avoid is bundling in something on a different scaling axis, like the
websocket-serving API (see `api.py` below).

`api.py` also exposes `POST /watch`, `DELETE /watch/{streamer_id}`, and
`GET /transcripts/{streamer_id}/recent` as stubs (HTTP 501) — reserved for
the orchestrator/multi-streamer and scrollback-history work described under
"Planned" below, not implemented yet.

### ASR model

- `faster-whisper` (CTranslate2), model size `small`
  (`Systran/faster-whisper-small` on Hugging Face), `device="cpu"`,
  `compute_type="int8"`, `language="en"` pinned explicitly.
- CTranslate2 is inference-only — fine-tuning later must happen on the
  original `transformers` Whisper checkpoint, then get converted to CT2 for
  serving. Two different formats for train vs serve.

### Chunking

- Fixed-length chunks via ffmpeg's `segment` muxer. Tried 15s -> 5s -> 3s ->
  1s. 1s was too short (no context for the model, fixed per-call inference
  overhead dominates). Settled around 3-4s as a reasonable latency/accuracy
  tradeoff for a fixed-window (non-streaming) approach.
- Known limitation: fixed cuts occasionally slice mid-word/mid-sentence at
  chunk boundaries, and trailing silence in a chunk can cause Whisper to
  hallucinate a short filler word (observed consistently, e.g. a stray "You").

### Latency sources (identified, partially tuned)

1. Chunk fill time — dominant, inherent to fixed-window batching. Only a real
   streaming/VAD-based ASR approach (e.g. whisper_streaming / WhisperLive
   style) removes this floor; not built, deferred.
2. Twitch/HLS CDN buffer — mitigated with streamlink's `--twitch-low-latency`.
3. Polling interval in the transcriber loop — reduced to 0.5s.
4. Model inference time on CPU — real tradeoff against model size.

Client-side idea (not built): delay video playback by a few seconds on the
frontend so captions land in sync — same trick broadcast TV closed captions
use. Lives entirely in the future frontend, doesn't affect backend design.

### Kafka specifics

- Real Apache Kafka, not Redpanda or another substitute. Official
  `apache/kafka` image, **KRaft mode** (no Zookeeper needed in modern Kafka).
- Single broker locally, replication factor 1 (no fault tolerance — fine for
  dev, would need multiple brokers + replication factor 3 in production).
- Topic `audio-chunks`: partition count is the ceiling on consumer
  parallelism within a group. Partition count can only be **increased**,
  never decreased (partitions are separate physical logs; shrinking would
  break the key->partition hash mapping for existing data).
- Partition sizing lesson: partition count should track desired *worker*
  parallelism, not number of users/streams. Kafka only guarantees ordering
  **within a key**, not globally — many different keys (users/streams) can
  safely share a partition without breaking correctness.
- `__consumer_offsets` — Kafka's internal topic (50 partitions, default),
  stores every consumer group's committed offsets automatically. This is
  what replaced the hand-rolled `next_index` bookkeeping from the very first
  local-file prototype.
- `ingest.py`, `transcriber.py`, and `api.py` all take `KAFKA_BOOTSTRAP` as an
  env var (`localhost:29092` for host-run, `kafka:9092` inside the Docker
  network).

### Containerization gotchas hit

- `docker-compose up`'s `depends_on` only waits for a container to *start*,
  not for Kafka to actually be ready to accept connections — ingest/
  transcriber/api log transient `Connection refused` on startup; librdkafka
  retries automatically and it self-heals within a few seconds. Not a bug.
- Python buffers stdout when it's not attached to a real terminal (i.e.
  always, inside a container) — `print()` output can sit invisible and never
  reach `docker logs` until the buffer flushes. Fixed with
  `ENV PYTHONUNBUFFERED=1` in all three Dockerfiles.

## Scaling notes (system-design thinking exercise, not a build target)

Two very different scaling problems depending on the scenario:

- **Many viewers, few actual streams** (the realistic Twitch case): only need
  to transcribe each unique stream once, then fan out the resulting text to
  many viewers — a pub/sub/broadcast problem, decoupled from ASR compute.
- **Many *unique* concurrent streams** (e.g. 1M distinct streamers): ASR GPU
  compute becomes the dominant bottleneck by far (rough estimate: tens of
  thousands of GPUs for ~1M concurrent real-time streams), ahead of ingest
  bandwidth (~100 Gbps range) and Kafka throughput. Kafka itself is the most
  "solved" layer of the four at that scale, provided partitions/brokers are
  sized for real throughput and payloads are compressed.

Concrete near-term actionable takeaway (not yet implemented): the pipeline
currently sends **raw WAV** bytes as Kafka message payloads. Switching to a
compressed codec (e.g. Opus) would cut payload size ~10-20x — worth doing
even at current small scale, not just a hypothetical optimization.

Partition/consumer-group semantics confirmed by testing:
- Same group, more consumers than partitions: extra consumers sit idle
  (viable as hot standby/failover, not parallelism).
- Different groups reading the same topic: each group gets its own
  independent full copy of every message (fan-out, not load-balancing).

## Planned: website / live display (partially built)

- **Live subtitles**: built. `api.py` consumes the `transcripts` topic and
  pushes each line to connected clients via `GET /ws/transcripts/{streamer_id}`.
  Still missing: the actual frontend (React) to connect to it.
- **5-minute scrollback history**: not built. `GET /transcripts/{streamer_id}/recent`
  exists as a stub (501) on `api.py`. Lightweight, text-only, cheap (KBs).
  Either kept client-side (simple array) or server-side (e.g. Redis) if new
  viewers should see recent history instead of a blank screen on join.
- **Multi-streamer / "paste a URL"**: not built. `POST /watch` and
  `DELETE /watch/{streamer_id}` exist as stubs (501) on `api.py`, reserved
  for the orchestrator that will dedup and spin up/tear down a per-stream
  `ingest` instance on demand (see k3s Job plan below).

## Planned: correction / retraining feedback loop (not built)

Trigger: a user reading the scrollback history selects a wrong line and
submits a correction (wrong text + corrected text). This needs to be paired
with the *actual audio* for that segment to be useful as training data.

Design:

1. `transcriber.py` additionally caches each chunk's raw audio in **Redis**,
   keyed by `chunk_id`, with a **TTL of ~10 minutes** (5-minute visible
   history window + safety buffer). Chosen deliberately to match the UI's
   visible window — a user can't flag anything they can't see, so audio
   doesn't need to outlive that window. Redis TTL gives automatic expiry for
   free, instead of hand-rolling cleanup again.
2. `transcripts` messages carry `chunk_id` so the frontend can reference the
   exact chunk when submitting a correction.
3. New **corrections API** (small HTTP service, e.g. FastAPI):
   `POST /corrections` with `{chunk_id, wrong_text, corrected_text}` — looks
   up the audio in Redis by `chunk_id`, bundles it with the correction, and
   publishes to a new Kafka topic `transcript-corrections`.
4. New **corrections consumer**: persists the full
   `(audio, wrong_text, corrected_text)` triple to durable storage (S3) —
   this copy intentionally outlives the Redis TTL since it's now confirmed
   valuable training data.
5. **Retraining is batched, not per-correction** — triggered on a schedule
   (e.g. nightly/weekly) or once enough corrections accumulate. Fine-tuning
   (LoRA/PEFT, not full fine-tune) happens on the original `transformers`
   Whisper checkpoint, then gets converted to CTranslate2 for serving.
6. **Eval gate before promotion**: a newly fine-tuned checkpoint must be
   evaluated against a held-out general validation set (not just the
   corrections) before replacing the production model — guards against
   catastrophic forgetting from a small, narrow correction dataset. This
   train -> register -> eval-gate -> deploy -> monitor -> retrain loop is
   the actual "ops" of the MLOps story for this project.

This phase adds two new services (corrections API, corrections consumer)
plus Redis, on top of the existing 4. It's gated behind the website existing
first, since there's no UI to trigger a correction without one.

## Planned: Terraform / AWS deployment (not started)

- Self-hosted Kafka on EC2 to start (MSK considered too costly to leave
  running continuously; revisit later if needed).
- **k3s** (lightweight single-node Kubernetes) on that same EC2 box, replacing
  ECS as the container orchestration layer — chosen over managed EKS because
  EKS's control plane alone costs ~$73/mo, on top of node costs, which blows
  the budget for a solo/portfolio deployment. k3s is free software on a box
  already being paid for either way, so this swap doesn't change the cost
  estimate. Also more representative of real MLOps tooling than ECS
  (k8s-native patterns like KServe/Kubeflow-style model serving), which
  matters for the CV-driven goal of this project.
  - `transcriber` (faster-whisper workers) runs as a k8s **Deployment**.
  - Orchestrator spins up/tears down an `ingest` instance (and, if needed, a
    dedicated `transcriber`) per active stream as a k8s **Job**,
    created/deleted via the Kubernetes API instead of ECS `RunTask`/`StopTask`.
- S3 for audio archive, transcript archive, and the training dataset store.
- VPC, IAM, security groups via Terraform. Terraform also provisions the EC2
  box k3s runs on; Ansible (or a simpler deploy script) handles installing
  k3s and keeping it configured, since the box is long-lived (not
  destroyed/recreated per session).
- GPU instances avoided initially — CPU int8 inference has been acceptable
  so far; revisit only if throughput actually demands it.
- Core infra (Kafka broker, orchestrator API, website, k3s control plane)
  runs continuously, same as any real product's backend — no teardown
  between sessions once real users exist. Cost is instead managed via
  right-sized/spot instances for the always-on pieces, and scale-to-zero for
  per-stream `ingest`/`transcriber` Jobs (no pods running for a channel
  nobody's currently watching).

## Explicit non-goals

- Not solving for literal 1M-independent-concurrent-stream hyperscale — that
  was a system-design reasoning exercise to understand bottlenecks
  (partitions vs users, lag-based autoscaling, multi-cluster sharding), not
  something this project needs to actually provision for.
- Continuous scraping of arbitrary Twitch channels has ToS implications —
  fine for personal/own-channel/short test use, not intended as an
  always-on scraper for arbitrary channels.
