import io
import json
import os
import time

from confluent_kafka import TIMESTAMP_NOT_AVAILABLE, Consumer, Producer
from faster_whisper import WhisperModel
from prometheus_client import Counter, Histogram, start_http_server

TOPIC = "audio-chunks"
TRANSCRIPTS_TOPIC = "transcripts"
CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS", "3"))
KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:29092")
METRICS_PORT = int(os.environ.get("METRICS_PORT", "9090"))
MAX_CHUNK_AGE_SECONDS = float(os.environ.get("MAX_CHUNK_AGE_SECONDS", "10"))

CHUNKS_PROCESSED = Counter(
    "transcriber_chunks_processed_total",
    "Audio chunks transcribed",
    ["streamer_id"],
)
CHUNKS_DROPPED = Counter(
    "transcriber_chunks_dropped_total",
    "Audio chunks skipped because they were older than MAX_CHUNK_AGE_SECONDS",
    ["streamer_id"],
)
INFERENCE_SECONDS = Histogram(
    "transcriber_inference_seconds",
    "Whisper inference time per chunk",
)

consumer = Consumer({
    "bootstrap.servers": KAFKA_BOOTSTRAP,
    "group.id": "asr-workers",
    "auto.offset.reset": "latest",
})
consumer.subscribe([TOPIC])

producer = Producer({"bootstrap.servers": KAFKA_BOOTSTRAP})

model = WhisperModel("small", device="cpu", compute_type="int8")

start_http_server(METRICS_PORT)

elapsed = {}
print("Transcribing... Ctrl+C to stop.")

try:
    while True:
        msg = consumer.poll(1.0)
        if msg is None:
            continue
        if msg.error():
            print(f"[transcriber] error: {msg.error()}")
            continue

        streamer_id = (msg.key() or b"unknown").decode()
        offset = elapsed.setdefault(streamer_id, 0.0)

        ts_type, ts_ms = msg.timestamp()
        if ts_type != TIMESTAMP_NOT_AVAILABLE:
            if time.time() - ts_ms / 1000 > MAX_CHUNK_AGE_SECONDS:
                # Live captions: a stale chunk is worth less than catching up.
                # Still advance elapsed so later caption timestamps stay right.
                elapsed[streamer_id] += CHUNK_SECONDS
                CHUNKS_DROPPED.labels(streamer_id=streamer_id).inc()
                continue

        audio = io.BytesIO(msg.value())
        with INFERENCE_SECONDS.time():
            # beam_size=1 (greedy) instead of faster-whisper's default beam of 5:
            # much less CPU per chunk for a small accuracy cost.
            segments, _ = model.transcribe(audio, language="en", beam_size=1)
            segments = list(segments)  # force the generator; transcribe() itself is lazy
        for seg in segments:
            start, end = offset + seg.start, offset + seg.end
            print(f"[{streamer_id}] [{start:.2f}-{end:.2f}] {seg.text}")
            payload = json.dumps({"start": start, "end": end, "text": seg.text})
            producer.produce(TRANSCRIPTS_TOPIC, key=streamer_id, value=payload)
        producer.poll(0)
        elapsed[streamer_id] += CHUNK_SECONDS
        CHUNKS_PROCESSED.labels(streamer_id=streamer_id).inc()
except KeyboardInterrupt:
    print("Stopping...")
finally:
    producer.flush()
    consumer.close()
