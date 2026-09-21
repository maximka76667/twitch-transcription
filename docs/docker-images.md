# Docker images (Docker Hub)

The AWS cluster can't use `k3d image import` (that only works for a local k3d
cluster sharing your Docker Desktop), so the three backend images live on
Docker Hub and the cluster pulls them itself.

| Service | Dockerfile | Image |
|---|---|---|
| ingest | `backend/Dockerfile.ingest` | `max76667/twitch-transcription-ingest:latest` |
| transcriber | `backend/Dockerfile.transcriber` | `max76667/twitch-transcription-transcriber:latest` |
| api | `backend/Dockerfile.api` | `max76667/twitch-transcription-api:latest` |

The frontend is **not** an image: `npm run build` produces static files that
Ansible copies to the box for Caddy to serve.

## When to do this

Only when `ingest.py`, `transcriber.py`, `api.py` or a `Dockerfile.*` changes.
Destroying and recreating the AWS box does **not** affect the images - Docker
Hub is separate from AWS.

## Push

From `backend/`, once per changed service:

```
docker login

docker build -f Dockerfile.<service> -t max76667/twitch-transcription-<service>:latest .
docker push max76667/twitch-transcription-<service>:latest
```

`transcriber` is the largest image (whisper and its dependencies), so its push
takes the longest.

Repos are created automatically on first push, and **public** by default -
anyone can pull them, and the `COPY`'d source code is inside the image layers.
No `imagePullSecrets` are needed on the cluster because of that.

## How the cluster uses them

- `k8s/base/*.yaml` reference `twitch-transcription-<service>:local` (the local
  k3d flow, loaded with `k3d image import`).
- `k8s/overlays/aws/kustomization.yaml` rewrites those references to the Docker
  Hub images (`images:` for the two Deployments, an explicit patch for
  `ingest`, whose image sits inside a KEDA `ScaledJob`).
- `kubectl apply -k k8s/overlays/aws --kubeconfig ansible/kubeconfig-aws.yaml`
  applies the result. The node's kubelet pulls the images automatically;
  nothing ever runs `docker pull` by hand.

Preview what will be applied, without touching the cluster:

```
kubectl kustomize k8s/overlays/aws
```

## Gotcha: re-pushing `:latest` may not reach a running node

The manifests set `imagePullPolicy: IfNotPresent`. A node that already has a
`:latest` image cached will keep using it, even after you push a new one, and
`kubectl rollout restart` reuses the cached copy too. A brand-new box always
pulls fresh, which is why this rarely shows up after a rebuild.

To roll out new code to a **running** box, either:
- push under a new unique tag (for example the git commit SHA) and set that as
  `newTag` in `k8s/overlays/aws/kustomization.yaml`, then apply again (the
  reproducible option), or
- set `imagePullPolicy: Always` for the AWS overlay, then run
  `kubectl rollout restart deployment/<service> -n twitch-transcription`.

`ingest` runs as short-lived KEDA jobs, so new job pods pick up whatever the
node currently has cached, under the same rule.

## Verify

```
kubectl get pods -n twitch-transcription --kubeconfig ansible/kubeconfig-aws.yaml
kubectl describe pod <pod> -n twitch-transcription --kubeconfig ansible/kubeconfig-aws.yaml
```

`ImagePullBackOff` on a pod means the image name or tag is wrong, or the repo
isn't visible to the cluster. `describe` shows the exact image and the pull
error under Events.
