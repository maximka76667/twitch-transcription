# AWS deployment

A single EC2 box (`m7i-flex.large`, `eu-central-1`, Ubuntu 24.04) running k3s,
KEDA, Kafka, Redis and the app (`api`, `transcriber`, KEDA-scaled `ingest`
jobs), with Caddy in front serving the frontend and terminating TLS.
Provisioned with Terraform, configured with Ansible, deployed with Kustomize,
observed with Prometheus + Grafana. See `DESIGN.md` for the architecture.

```
laptop                                   EC2 box (Elastic IP)
------                                   ---------------------------------
terraform apply ---------------------->  VPC, subnet, security group, instance
ansible-playbook (ssh :22) ----------->  swap, k3s, helm, KEDA, Caddy, frontend files
kubectl apply -k (:6443) ------------->  Kafka, Redis, api, transcriber, ingest
helm install (:6443) ----------------->  Prometheus, Grafana
browser https://<ip>.sslip.io -------->  Caddy :443 -> frontend files / api :8000
```

## Prerequisites

- An AWS account with billing set up, and an IAM user (not root) with
  `AmazonEC2FullAccess`, credentials configured via `aws configure`
- Installed locally: [Terraform](https://developer.hashicorp.com/terraform/install),
  the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
  `kubectl`, `helm`, Node.js/npm, Docker
- [Ansible](https://docs.ansible.com/) - needs a real Linux environment, not
  native Windows. On Windows: `wsl --install -d Ubuntu`, then inside it
  `sudo apt update && sudo apt install -y ansible`. The scripts call it through
  `wsl -d Ubuntu`.
- An SSH keypair dedicated to this box:
  ```
  ssh-keygen -t ed25519 -f ~/.ssh/twitch-transcription -N '""' -C "twitch-transcription-admin"
  ```
  On Windows, Ansible runs inside WSL and SSH refuses key files with the
  over-open permissions of NTFS mounts, so also copy the key into WSL's own
  filesystem:
  ```
  mkdir -p ~/.ssh
  cp /mnt/c/Users/<you>/.ssh/twitch-transcription ~/.ssh/twitch-transcription
  chmod 600 ~/.ssh/twitch-transcription
  ```
- `terraform/terraform.tfvars` (copy `terraform.tfvars.example`) with
  `ssh_public_key` set to the contents of the `.pub` file. `allowed_admin_cidr`
  is filled in automatically by the deploy script (see below).
- Images for the current code pushed to Docker Hub - see
  [docker-images.md](docker-images.md). Destroying the box never touches them.

## Quick path: one command

```
node scripts/deploy.mjs up
```

In order:

1. Checks the required tools (terraform, kubectl, npm, helm, ansible - inside
   WSL on Windows) and the SSH key, before anything costs money.
2. Looks up your public IP (ipify) and runs `terraform apply` with
   `-var allowed_admin_cidr=<your-ip>/32`. Review the plan and type `yes`.
3. Writes `ansible/inventory.ini` from `inventory.ini.example`: the instance IP
   and the domain `<dashed-ip>.sslip.io`.
4. Builds the frontend (`npm run build`).
5. Waits for SSH, then runs the Ansible playbook.
6. Runs `kubectl apply -k k8s/overlays/aws` with the fetched kubeconfig.
7. Installs Prometheus + Grafana (skip with `--no-monitoring`).

Other commands:

```
node scripts/deploy.mjs up --no-monitoring   # skip step 7
node scripts/deploy.mjs monitoring           # (re)install only monitoring on a running box
```

Your public IP changes over time. If it does, the security group no longer lets
you in (SSH, `kubectl`): re-run `terraform apply` with the new `allowed_admin_cidr`.

## What each step does

### Terraform (`terraform/`)

Creates a VPC, subnet, internet gateway and route table, a security group, the
EC2 instance (30 GB gp3 root volume) and an Elastic IP. Prints `public_ip` and
`ssh_command`.

Security group: 22 (SSH) and 6443 (Kubernetes API) only from
`allowed_admin_cidr`, 80/443 open to everyone, everything else internal.
Kafka, Redis, the API port and Grafana are never exposed directly.

**Instance type.** The account is on the AWS free plan, which only allows
`t3.micro`, `t3.small`, `t4g.micro`, `t4g.small`, `c7i-flex.large` and
`m7i-flex.large` (anything else fails with `FreeTierRestrictionError`).
`t3.small` (2 GB) thrashed running the whole stack, so the default in
`terraform/variables.tf` is `m7i-flex.large` (8 GB, 2 vCPU). Changing
`instance_type` and re-applying updates the instance in place and keeps the
Elastic IP.

### Ansible (`ansible/playbook.yml`)

- adds a swapfile (only if none exists)
- installs k3s with Traefik disabled and `--tls-san <public ip>`, so the
  certificate is valid for the address `kubectl` connects to
- fetches the kubeconfig to `ansible/kubeconfig-aws.yaml` (gitignored, contains
  real credentials), rewritten from `127.0.0.1` to the public IP
- installs helm and KEDA (chart pinned to 2.20.2). KEDA's CRDs must exist before
  the manifests are applied.
- installs Caddy, copies `frontend/dist/` to `/var/www/frontend/`, and renders
  `ansible/templates/Caddyfile.j2`

`ansible/ansible.cfg` sets `StrictHostKeyChecking=accept-new`, so the first
connection to a fresh box doesn't need a manual `ssh` to accept its host key.

### Caddy and the domain

Caddy serves the frontend files and proxies `/health`, `/watch`, `/ws/*` and
`/transcripts/*` to the API. It obtains and renews a Let's Encrypt certificate
by itself. The frontend and API share one origin, so there is no CORS to
configure, and HTTPS pages can open `wss://` connections (browsers block plain
`ws://` from an HTTPS page).

The domain is `<dashed-ip>.sslip.io` - free, no registration, but it changes if
the IP does (for example after destroy and recreate). Swap it for a real domain
when this stops being a test setup.

The proxy targets the node's **private IP** rather than `localhost`: k3s's
ServiceLB exposes the `api` Service through iptables DNAT rules that don't apply
to loopback traffic, so `localhost:8000` returns connection refused.

### Kubernetes manifests (`k8s/`)

`k8s/base/` is the shared set of manifests (Kafka, Redis, `api`, `transcriber`,
`ingest` ScaledJob, KEDA scalers) and is what the local k3d cluster uses.
`k8s/overlays/aws/kustomization.yaml` reuses it and changes only what differs:

- image references point at Docker Hub, at a specific version (see
  [docker-images.md](docker-images.md))
- the transcriber scaler is capped at `maxReplicaCount: 2`
- the transcriber gets tuning environment variables (see below)

```
kubectl kustomize k8s/overlays/aws                                   # preview, changes nothing
kubectl apply -k k8s/overlays/aws --kubeconfig ansible/kubeconfig-aws.yaml
```

## Deploying new code

```
git commit ...                        # backend/ must be committed
node scripts/push-images.mjs          # builds, pushes, writes the version into the overlay
kubectl apply -k k8s/overlays/aws --kubeconfig ansible/kubeconfig-aws.yaml
git commit k8s/overlays/aws/kustomization.yaml
```

## Monitoring

Prometheus and Grafana (the `kube-prometheus-stack` chart, pinned) are installed
by helm from your laptop, using `k8s/monitoring/values.yaml` layered with
`k8s/monitoring/values-aws.yaml` (turns off the etcd/scheduler/controller-manager/
kube-proxy scrapers, which k3s doesn't expose separately). A PodMonitor scrapes
the transcriber's `/metrics`.

Grafana is not exposed to the internet. Reach it through a tunnel:

```
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80 --kubeconfig ansible/kubeconfig-aws.yaml
```

Then open `http://localhost:3000` (`admin` / `admin`) - `http`, not `https`. In
**Explore**, useful queries:

```
# average seconds to transcribe one chunk, per pod (budget = CHUNK_SECONDS, 4)
rate(transcriber_inference_seconds_sum[1m]) / rate(transcriber_inference_seconds_count[1m])

# chunks skipped because they were older than MAX_CHUNK_AGE_SECONDS
rate(transcriber_chunks_dropped_total[1m])

# streams currently being transcribed
sum by (streamer_id) (rate(transcriber_chunks_processed_total[1m]))

# node CPU, 0 to 1
1 - avg(rate(node_cpu_seconds_total{mode="idle"}[1m]))
```

If Grafana's port-forward says `connection refused`, the pod is still starting
(`kubectl get pods -n monitoring`); wait until `3/3 Running`. A `NaN` result
means no chunks were processed in the window (no streams running, or pods just
restarted).

## Transcription tuning on 2 vCPUs

Captions are CPU-bound on this box. `transcriber.py` reads its settings from
environment variables, so they can be changed without rebuilding the image:

| Variable                | Default | Meaning                                             |
| ----------------------- | ------- | --------------------------------------------------- |
| `WHISPER_MODEL`         | `small` | model size (`base`, `tiny` are faster)              |
| `CPU_THREADS`           | `0`     | threads per replica (0 = library default)           |
| `VAD_FILTER`            | `0`     | `1` skips chunks without speech                     |
| `MAX_CHUNK_AGE_SECONDS` | `10`    | chunks older than this are dropped, not transcribed |

Measured with two busy streams (each replica has a 4-second budget per chunk):

| Setting                                    | Average per chunk                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `small`, default threads                   | 4.4-7.5s, overloaded                                                           |
| `small` + `CPU_THREADS=1` + `VAD_FILTER=1` | 3.4s when streamers were quiet, 9.1s when both talked; ~4 in 10 chunks dropped |
| `base` + `CPU_THREADS=1` + `VAD_FILTER=1`  | ~1.1s, no drops, CPU ~40%                                                      |

The AWS overlay sets `base`, `CPU_THREADS=1` and `VAD_FILTER=1`. Load depends on
how much the streamers talk, so judge a setting after several minutes with both
streams busy, not from one reading.

To experiment on the live cluster (restarts the transcriber pods; environment
variables are read only at process start):

```
kubectl set env deployment/transcriber CPU_THREADS=1 -n twitch-transcription --kubeconfig ansible/kubeconfig-aws.yaml
kubectl set env deployment/transcriber --list -n twitch-transcription --kubeconfig ansible/kubeconfig-aws.yaml
```

Whatever wins belongs in the overlay so a rebuilt box gets it.

## Verify

```
kubectl --kubeconfig ansible/kubeconfig-aws.yaml get nodes
kubectl --kubeconfig ansible/kubeconfig-aws.yaml get pods -A
```

One `Ready` node, and the `twitch-transcription` pods running with the image
version you pushed (`kubectl describe pod ... | findstr Image:`). Then open
`https://<dashed-ip>.sslip.io`.

Which streamer an `ingest` pod is watching is only in its logs
(`kubectl logs <pod>`, the `-> topic` line). Finished jobs stay listed as
`Completed` - they use no resources.

## Cost and teardown

`terraform destroy` (type `yes`) in `terraform/` deletes everything; nothing
bills afterwards. A merely **stopped** instance still costs for the EBS volume
and the Elastic IP (roughly $6/month), so destroy instead of stop when not
using it. Rebuild with `node scripts/deploy.mjs up`; the domain changes because
the IP does.

## Not done yet

- A real domain instead of sslip.io.
- GitHub Action for building and pushing images.
- A stop/start helper.
