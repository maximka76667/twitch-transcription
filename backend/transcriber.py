import io
import json
import os

from confluent_kafka import Consumer, Producer
from faster_whisper import WhisperModel

TOPIC = "audio-chunks"
TRANSCRIPTS_TOPIC = "transcripts"
CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS", "3"))
KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:29092")

consumer = Consumer({
    "bootstrap.servers": KAFKA_BOOTSTRAP,
    "group.id": "asr-workers",
    "auto.offset.reset": "latest",
})
consumer.subscribe([TOPIC])

producer = Producer({"bootstrap.servers": KAFKA_BOOTSTRAP})

model = WhisperModel("small", device="cpu", compute_type="int8")

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

        audio = io.BytesIO(msg.value())
        segments, _ = model.transcribe(audio, language="en")
        for seg in segments:
            start, end = offset + seg.start, offset + seg.end
            print(f"[{streamer_id}] [{start:.2f}-{end:.2f}] {seg.text}")
            payload = json.dumps({"start": start, "end": end, "text": seg.text})
            producer.produce(TRANSCRIPTS_TOPIC, key=streamer_id, value=payload)
        producer.poll(0)
        elapsed[streamer_id] += CHUNK_SECONDS
except KeyboardInterrupt:
    print("Stopping...")
finally:
    producer.flush()
    consumer.close()
