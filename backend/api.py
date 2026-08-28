import asyncio
import json
import os
import threading
from collections import defaultdict
from urllib.parse import urlparse

import redis
from confluent_kafka import Consumer
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

TOPIC = "transcripts"
JOB_QUEUE = "ingest-jobs"
# must match the refresh cadence in ingest.py's heartbeat loop
ACTIVE_TTL_SECONDS = 15
# tolerate a brief disconnect (page reload, flaky network) before tearing
# down the stream, so a reload-and-reconnect doesn't drop viewers to 0 and
# trigger cleanup + a duplicate ingest job on the next /watch
DISCONNECT_GRACE_SECONDS = 5
KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP", "localhost:29092")
REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)
subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
main_loop: asyncio.AbstractEventLoop | None = None
redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)


async def broadcast(streamer_id: str, message: dict) -> None:
    for queue in subscribers.get(streamer_id, []):
        queue.put_nowait(message)


def kafka_loop() -> None:
    consumer = Consumer({
        "bootstrap.servers": KAFKA_BOOTSTRAP,
        "group.id": "api-workers",
        "auto.offset.reset": "latest",
    })
    consumer.subscribe([TOPIC])

    try:
        while True:
            msg = consumer.poll(1.0)
            if msg is None:
                continue
            if msg.error():
                print(f"[api] error: {msg.error()}")
                continue

            streamer_id = (msg.key() or b"unknown").decode()
            message = json.loads(msg.value())
            # kafka_loop runs on a background thread, not the FastAPI event
            # loop, so handing a message to a websocket has to cross threads.
            if main_loop is not None:
                asyncio.run_coroutine_threadsafe(
                    broadcast(streamer_id, message), main_loop
                )
    finally:
        consumer.close()


@app.on_event("startup")
async def startup() -> None:
    global main_loop
    main_loop = asyncio.get_running_loop()
    threading.Thread(target=kafka_loop, daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ok"}


class WatchRequest(BaseModel):
    channel_url: str


def _streamer_id_from_url(channel_url: str) -> str:
    return urlparse(channel_url).path.strip("/").split("/")[-1]


@app.post("/watch")
def watch(req: WatchRequest):
    streamer_id = _streamer_id_from_url(req.channel_url)
    # SET ... NX is atomic: only the first caller for a given streamer_id
    # wins the flag and queues a job, so concurrent /watch calls for the
    # same stream don't queue duplicate ingest jobs. The TTL is a safety
    # net: the assigned ingest worker refreshes it while actually running
    # (see ingest.py), so a worker that dies uncleanly (no finally cleanup
    # on SIGTERM) doesn't leave this flag stuck forever, blocking future
    # /watch calls for the same streamer.
    if redis_client.set(f"active:{streamer_id}", "1", nx=True, ex=ACTIVE_TTL_SECONDS):
        redis_client.rpush(JOB_QUEUE, streamer_id)
        status = "queued"
    else:
        status = "already active"
    return {"streamer_id": streamer_id, "status": status}


@app.websocket("/ws/transcripts/{streamer_id}")
async def ws_transcripts(websocket: WebSocket, streamer_id: str):
    await websocket.accept()
    redis_client.incr(f"viewers:{streamer_id}")
    queue: asyncio.Queue = asyncio.Queue()
    subscribers[streamer_id].append(queue)
    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
    except WebSocketDisconnect:
        pass
    finally:
        subscribers[streamer_id].remove(queue)
        remaining = redis_client.decr(f"viewers:{streamer_id}")
        if remaining <= 0:
            # a reload/brief reconnect might bring a viewer back before this
            # fires — re-check rather than tearing down immediately
            await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
            still_remaining = redis_client.get(f"viewers:{streamer_id}")
            if still_remaining is None or int(still_remaining) <= 0:
                redis_client.delete(f"viewers:{streamer_id}")
                redis_client.delete(f"active:{streamer_id}")
                redis_client.publish(f"stop:{streamer_id}", "stop")


def _not_implemented(**_kwargs):
    return JSONResponse(status_code=501, content={"detail": "not implemented yet"})


@app.get("/transcripts/{streamer_id}/recent")
def recent(streamer_id: str):
    return _not_implemented()
