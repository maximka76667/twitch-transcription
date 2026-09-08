# Docker Compose (fast local debugging)

Runs the same 4 services (`kafka`, `ingest`, `transcriber`, `api`) as plain
Docker containers via `backend/docker-compose.yml` — no `k3d`/`kubectl`/
`helm` involved. Faster edit-rebuild-restart loop than the Kubernetes path
when you're purely iterating on `ingest.py` / `transcriber.py` / `api.py`
logic and don't need the rest of the stack around it.

**What you lose versus the Kubernetes setup** (see main `README.md`):
KEDA autoscaling (Compose just runs one fixed instance of each service) and
the Prometheus/Grafana monitoring stack. `transcriber`'s `/metrics` endpoint
still works under Compose — it'd just be reachable directly at
`localhost:9090`, nothing scrapes/stores/graphs it. Compose is for quickly
exercising the pipeline itself, not a maintained parallel deployment target.

### Requirements

- Docker Desktop (or Docker Engine + Compose plugin)

### Configuration

`CHUNK_SECONDS` (audio chunk length in seconds) is set in
`backend/docker-compose.yml` and must match on both `ingest` and
`transcriber`. There's no `STREAMER_ID` to configure — `ingest` runs as a
generic worker pool and is told which streamer to handle at runtime via the
frontend's **Watch** button (`POST /watch`), not an env var.

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
