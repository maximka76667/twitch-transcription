import os
import re
import shutil
import subprocess
import sys

import redis
from confluent_kafka import Producer

STREAMLINK = shutil.which("streamlink") or os.path.join(
    os.path.dirname(sys.executable), "streamlink.exe"
)

CHUNK_DIR = "chunks"
CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS", "4"))
TOPIC = "audio-chunks"
KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:29092")
REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
JOB_QUEUE = "ingest-jobs"
# must match the TTL api.py sets on the "active" flag
ACTIVE_TTL_SECONDS = 15

producer = Producer({"bootstrap.servers": KAFKA_BOOTSTRAP})
redis_client = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    decode_responses=True,
    socket_keepalive=True,
    socket_timeout=5,
    socket_connect_timeout=5,
)

chunk_re = re.compile(r"chunk_(\d+)\.wav")


def delivery_report(err, _msg):
    if err is not None:
        print(f"[ingest] delivery failed: {err}")


def ingest_stream(streamer_id: str) -> None:
    channel_url = f"https://www.twitch.tv/{streamer_id}"
    shutil.rmtree(CHUNK_DIR, ignore_errors=True)
    os.makedirs(CHUNK_DIR, exist_ok=True)

    streamlink_proc = subprocess.Popen(
        [STREAMLINK, channel_url, "audio_only", "-O", "--twitch-low-latency"],
        stdout=subprocess.PIPE,
    )
    ffmpeg_proc = subprocess.Popen(
        [
            "ffmpeg",
            "-y",
            "-i",
            "pipe:0",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-f",
            "segment",
            "-segment_time",
            str(CHUNK_SECONDS),
            "-reset_timestamps",
            "1",
            os.path.join(CHUNK_DIR, "chunk_%03d.wav"),
        ],
        stdin=streamlink_proc.stdout,
        stderr=subprocess.DEVNULL,
    )
    streamlink_proc.stdout.close()

    # a dedicated pubsub connection per job, subscribed only to this
    # streamer's stop channel — checked non-blockingly each loop iteration
    pubsub = redis_client.pubsub()
    pubsub.subscribe(f"stop:{streamer_id}")

    next_index = 0
    print(f"[ingest] '{streamer_id}' -> topic '{TOPIC}'")

    try:
        while True:
            # renew the "active" flag's TTL while genuinely still working this
            # job — best-effort: if a refresh is missed, the flag just expires
            # a little early rather than the job crashing over it
            try:
                redis_client.expire(f"active:{streamer_id}", ACTIVE_TTL_SECONDS)
            except redis.exceptions.RedisError:
                pass

            try:
                stopped = pubsub.get_message(ignore_subscribe_messages=True, timeout=0.5)
            except redis.exceptions.RedisError as e:
                print(f"[ingest] redis connection issue (stop-check), ignoring: {e}")
                stopped = None
            if stopped:
                print(f"[ingest] stop signal for '{streamer_id}'")
                break

            files = sorted(os.listdir(CHUNK_DIR))
            indices = sorted(int(m.group(1)) for f in files if (m := chunk_re.match(f)))
            # only read a chunk once ffmpeg has moved on to the next one (file is closed/complete)
            while next_index in indices and (next_index + 1) in indices:
                path = os.path.join(CHUNK_DIR, f"chunk_{next_index:03d}.wav")
                with open(path, "rb") as f:
                    data = f.read()
                producer.produce(
                    TOPIC, key=streamer_id, value=data, callback=delivery_report
                )
                producer.poll(0)
                os.remove(path)
                next_index += 1
    finally:
        pubsub.close()
        producer.flush()
        ffmpeg_proc.terminate()
        streamlink_proc.terminate()
        redis_client.delete(f"active:{streamer_id}")


print("[ingest] worker starting, checking for a job...")
try:
    # runs as a k8s Job (one per queued stream, created by KEDA's
    # ScaledJob) rather than a long-lived pool worker, so this grabs at
    # most one job and exits instead of looping forever — a busy pod no
    # longer hides future queue items from KEDA's scaling decision
    job = None
    for attempt in range(3):
        try:
            job = redis_client.blpop(JOB_QUEUE, timeout=5)
            break
        except redis.exceptions.RedisError as e:
            print(f"[ingest] redis connection issue (attempt {attempt + 1}/3): {e}")
            redis_client.connection_pool.disconnect()
    if job is None:
        print("[ingest] no job available, exiting")
    else:
        _, streamer_id = job
        ingest_stream(streamer_id)
except KeyboardInterrupt:
    print("Stopping...")
