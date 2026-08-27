# twitch-transcription

Live speech-to-text pipeline for a Twitch stream (streamlink -> ffmpeg -> Kafka
-> faster-whisper -> Kafka -> websocket API -> React frontend). See
`DESIGN.md` for architecture details and rationale.

## Layout

```
backend/    Kafka + ingest + transcriber + api services (Docker Compose)
frontend/   React (Vite) app that displays live subtitles
```

## Architecture

```mermaid
flowchart LR
    USER(["User's browser"])
    API["api.py"]
    REDISQ[("Redis: job queue")]
    ING["ingest.py<br/>worker pool"]
    TWITCH["Twitch"]
    TRX["transcriber.py<br/>faster-whisper (ML model)"]

    subgraph KAFKA [Kafka]
        direction LR
        T1[("Kafka: audio-chunks")]
        T2[("Kafka: transcripts")]
    end

    USER -- "1. POST /watch" --> API
    API -- "2. RPUSH ingest-jobs" --> REDISQ
    REDISQ -- "3. BLPOP ingest-jobs" --> ING
    TWITCH -- "4. streamlink/ffmpeg" --> ING
    ING -- "5. produce audio-chunks" --> T1
    T1 -- "6. consume audio-chunks" --> TRX
    TRX -- "7. produce transcripts" --> T2
    T2 -- "8. consume transcripts" --> API
    API -- "9. websocket /ws/transcripts/{id}" --> USER
```

## Backend

### Requirements

- Docker Desktop (or Docker Engine + Compose plugin)

### Configuration

`CHUNK_SECONDS` (audio chunk length in seconds) is set in
`backend/docker-compose.yml` and must match on both `ingest` and
`transcriber`. There's no `STREAMER_ID` to configure — `ingest` runs as a
generic worker pool and is told which streamer to handle at runtime via the
frontend's **Watch** button (`POST /watch`), not an env var.

### Python environment

From `backend/`:

```
python -m venv venv
venv\Scripts\pip install confluent-kafka streamlink faster-whisper fastapi "uvicorn[standard]" redis pydantic
```

(`venv/Scripts/...` on Windows; `venv/bin/...` on macOS/Linux.)

### Start

From `backend/`:

```
docker compose up --build
```

`--build` is only needed after changing `ingest.py`, `transcriber.py`,
`api.py`, or a `Dockerfile.*`. On later runs without code changes,
`docker compose up` alone is enough.

Runs in the foreground; `Ctrl+C` stops it. To run in the background instead:

```
docker compose up --build -d
```

### View logs

If running in the foreground, logs from all 4 services (`kafka`, `ingest`,
`transcriber`, `api`) print directly to the terminal.

If running detached (`-d`), or to view logs later:

```
docker compose logs -f
```

Transcribed text is printed by the `transcriber` service. To follow just that:

```
docker compose logs -f transcriber
```

Other services: `docker compose logs -f ingest` / `docker compose logs -f api`
/ `docker compose logs -f kafka`.

### Stop

Pause (keeps containers, resume instantly with `docker compose start`):

```
docker compose stop
```

Full teardown (removes containers; images stay cached, so the next
`docker compose up` doesn't need to rebuild unless code changed):

```
docker compose down
```

## Kubernetes (k3d)

Alternative to Docker Compose — runs the same 5 services (kafka, redis,
ingest, transcriber, api) as a local Kubernetes cluster instead. Manifests
live in `k8s/`.

### Requirements

- Docker Desktop (or Docker Engine)
- [k3d](https://k3d.io/) — lightweight local Kubernetes via Docker
- `kubectl`

### Create the cluster

One-time, or after a full teardown (`k3d cluster delete`):

```
k3d cluster create twitch-transcription -p "8000:8000@loadbalancer"
```

The port mapping keeps `api` reachable at `localhost:8000`, matching the
`api` Service's `type: LoadBalancer` in `k8s/05-api.yaml`, so the frontend
needs no changes.

### Build and import images

From `backend/`, build each image, then hand them into the cluster (k3d
can't see your regular Docker images otherwise):

```
docker build -f Dockerfile.ingest -t twitch-transcription-ingest:local .
docker build -f Dockerfile.transcriber -t twitch-transcription-transcriber:local .
docker build -f Dockerfile.api -t twitch-transcription-api:local .

k3d image import twitch-transcription-ingest:local twitch-transcription-transcriber:local twitch-transcription-api:local -c twitch-transcription
```

### Deploy

From the repo root:

```
kubectl apply -f k8s/
```

### Check status

```
kubectl get pods -n twitch-transcription -w
```

(`Ctrl+C` to stop watching once everything shows `Running`.)

```
kubectl logs -f -n twitch-transcription deployment/transcriber
```

Swap `deployment/transcriber` for `deployment/ingest` / `deployment/api` /
`deployment/kafka` / `deployment/redis` for other services.

### After changing backend code

Unlike Compose, Kubernetes won't notice an image's contents changed just
because you rebuilt it with the same tag — rebuild, re-import, then force
the affected Deployment to roll new pods:

```
docker build -f Dockerfile.<service> -t twitch-transcription-<service>:local .
k3d image import twitch-transcription-<service>:local -c twitch-transcription
kubectl rollout restart deployment/<service> -n twitch-transcription
```

### Stop / resume

Pause the cluster (frees CPU/RAM, keeps all state — no rebuild/reimport/
reapply needed on resume):

```
k3d cluster stop twitch-transcription
k3d cluster start twitch-transcription
```

Full teardown (deletes the cluster entirely; next `k3d cluster create` starts
from scratch):

```
k3d cluster delete twitch-transcription
```

## Frontend

### Requirements

- Node.js + npm

### Start

From `frontend/`:

```
npm install
npm run dev
```

Opens on `http://localhost:5173` by default. Requires the backend `api`
service to be reachable at `ws://localhost:8000` (i.e. the backend stack
already running via `docker compose up`).

In the page, type the `STREAMER_ID` configured on the `ingest` service (e.g.
`dead_oryx`) and click **Watch** to open the websocket and start receiving
live transcript lines.

Stop the dev server with `Ctrl+C`.
