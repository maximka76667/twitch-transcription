# AWS deployment

**Status: in progress.** This covers what's actually built so far —
provisioning the box and turning it into a working k3s cluster. Deploying
the app itself onto that cluster, TLS/domain, and serving the frontend
aren't done yet; this doc will grow as those land. See `DESIGN.md`'s
"Planned: Terraform / AWS deployment" section for the full target
architecture.

Single EC2 box (`t3.small`, `eu-central-1`) running self-hosted Kafka + k3s,
provisioned with Terraform, configured with Ansible.

## Prerequisites

- An AWS account with billing set up, and an IAM user (not root) with
  `AmazonEC2FullAccess` — credentials configured via `aws configure`
- [Terraform](https://developer.hashicorp.com/terraform/install) and the
  [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  (both run natively on Windows)
- [Ansible](https://docs.ansible.com/) — needs a real Linux environment, not
  native Windows. On Windows: `wsl --install -d Ubuntu`, then inside it
  `sudo apt update && sudo apt install -y ansible`
- An SSH keypair dedicated to this box, e.g.:
  ```
  ssh-keygen -t ed25519 -f ~/.ssh/twitch-transcription -N '""' -C "twitch-transcription-admin"
  ```

## 1. Provision the box (Terraform)

From `terraform/`:

```
cp terraform.tfvars.example terraform.tfvars
```

Fill in `terraform.tfvars`:
- `allowed_admin_cidr` — your own IP, `/32`. Find it with
  `curl -s -4 https://api.ipify.org`. Never leave this as `0.0.0.0/0`.
- `ssh_public_key` — contents of the `.pub` file from the keypair above.

```
terraform init
terraform plan   # review what it's about to create - safe, read-only
terraform apply  # confirm with yes
```

Creates a VPC, subnet, security group (SSH/k3s-API restricted to your IP,
80/443 public, everything else internal-only), the EC2 instance, and an
Elastic IP. Prints `public_ip` and `ssh_command` when done.

Teardown: `terraform destroy` (confirm with `yes`) — deletes everything, no
cost afterward.

## 2. Turn it into a k3s cluster (Ansible)

Run from inside WSL. One-time setup — SSH refuses private keys with the
overly-open permissions NTFS-mounted files show up with in WSL, so copy the
key into WSL's own filesystem first:

```
mkdir -p ~/.ssh
cp /mnt/c/Users/<you>/.ssh/twitch-transcription ~/.ssh/twitch-transcription
chmod 600 ~/.ssh/twitch-transcription
```

From `ansible/`:

```
cp inventory.ini.example inventory.ini
```

Edit `inventory.ini`, replacing the placeholder with the real IP from
Terraform's `public_ip` output.

First connection to a new box needs its host key accepted once, interactively
(Ansible can't do this non-interactively):

```
ssh -i ~/.ssh/twitch-transcription ubuntu@<the-ip>
```

Type `yes`, then `exit` right back out. Then run the playbook:

```
ansible-playbook -i inventory.ini playbook.yml
```

Sets up a 2GB swapfile (needed - Kafka + k3s + whisper inference together
is tight on `t3.small`'s 2GB RAM), installs k3s (Traefik disabled - not
used, a future Caddy step handles TLS/ingress instead), and fetches the
kubeconfig to `ansible/kubeconfig-aws.yaml` (gitignored - contains real TLS
credentials), rewritten to point at the box's public IP instead of
`127.0.0.1`.

## 3. Verify

From Windows (or anywhere with `kubectl`):

```
kubectl --kubeconfig ansible/kubeconfig-aws.yaml get nodes
kubectl --kubeconfig ansible/kubeconfig-aws.yaml get pods -A
```

Should show one `Ready` node and `coredns`/`local-path-provisioner`/
`metrics-server` all `Running` in `kube-system`.

## Not built yet

- Deploying the actual app (`ingest`/`transcriber`/`api`/KEDA) onto this
  cluster — the existing `k8s/*.yaml` reference `:local` image tags from
  `k3d image import`, which doesn't exist on real k8s; needs a real
  registry (Docker Hub planned) first.
- A domain + TLS (Caddy, Let's Encrypt).
- Serving the frontend from this box.
