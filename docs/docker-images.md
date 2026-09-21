# Docker images (Docker Hub)

The AWS cluster can't use `k3d image import` (that only works for a local k3d
cluster sharing your Docker Desktop), so the three backend images live on
Docker Hub and the cluster pulls them itself.

| Service | Dockerfile | Image |
|---|---|---|
| ingest | `backend/Dockerfile.ingest` | `max76667/twitch-transcription-ingest:<version>` |
| transcriber | `backend/Dockerfile.transcriber` | `max76667/twitch-transcription-transcriber:<version>` |
| api | `backend/Dockerfile.api` | `max76667/twitch-transcription-api:<version>` |

The frontend is **not** an image: `npm run build` produces static files that
Ansible copies to the box for Caddy to serve.

## When to do this

Only when `ingest.py`, `transcriber.py`, `api.py` or a `Dockerfile.*` changes.
Destroying and recreating the AWS box does **not** affect the images - Docker
Hub is separate from AWS.

## Push

```
docker login                       # once
git commit ...                     # backend/ must be committed
node scripts/push-images.mjs       # version = git describe --tags --always
node scripts/push-images.mjs v0.2.0   # or an explicit version
```

The script:

- refuses to run if `backend/` has uncommitted changes (the version has to
  identify real code); an explicit version skips that check
- builds and pushes all three images under the version
- never overwrites a tag: if `<image>:<version>` already exists on Docker Hub it
  warns and skips that image
- afterwards writes the version into `k8s/overlays/aws/kustomization.yaml` - the
  two `newTag:` lines and the ingest patch's image line - and prints the
  `kubectl apply -k` command. It stops if it doesn't find exactly those three
  lines, instead of silently rewriting nothing.

Config (Docker Hub user, service list, overlay path) is at the top of
`scripts/push-images.mjs`. The version is the commit SHA of HEAD, so a commit
that only touches other files (docs, the overlay itself) gives a new version on
the next run and would rebuild identical images under a new tag - push once per
backend change.

`transcriber` is the largest image (whisper and its dependencies), so its push
takes the longest. `docker manifest inspect` decides whether a tag exists; any
failure of that command (for example being offline) counts as "doesn't exist".

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

## Why versions and not `:latest`

The manifests set `imagePullPolicy: IfNotPresent`. A node that already has a
`:latest` image cached keeps using it even after you push a new one, and
`kubectl rollout restart` reuses the cached copy too - a brand-new box always
pulls fresh, so this only bites on a running one. A unique tag per version
sidesteps it: a new tag is never cached, so changing the tag in the overlay is
what triggers the rollout, and git records exactly which version is deployed.

`ingest` runs as short-lived KEDA jobs, so new job pods use whatever the
overlay's ingest image line says, which the push script updates along with the
other two.

## Deploy

```
kubectl apply -k k8s/overlays/aws --kubeconfig ansible/kubeconfig-aws.yaml
git commit k8s/overlays/aws/kustomization.yaml
```

## Verify

```
kubectl get pods -n twitch-transcription --kubeconfig ansible/kubeconfig-aws.yaml
kubectl describe pods -n twitch-transcription --kubeconfig ansible/kubeconfig-aws.yaml | findstr /C:"Name:" /C:"Image:"
```

Every service should show the version the script printed.

`ImagePullBackOff` on a pod means the image name or tag is wrong, or the repo
isn't visible to the cluster. `describe` shows the exact image and the pull
error under Events.
