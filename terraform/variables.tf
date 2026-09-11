variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-central-1"
}

variable "instance_type" {
  description = "EC2 instance type for the k3s + Kafka + whisper box"
  type        = string
  default     = "t3.small"
}

variable "allowed_admin_cidr" {
  description = "CIDR allowed to reach SSH (22) and the k3s API (6443) - your own IP, e.g. 1.2.3.4/32. Never leave this as 0.0.0.0/0."
  type        = string
}

variable "ssh_public_key" {
  description = "Public key content (e.g. the contents of ~/.ssh/id_rsa.pub or a key generated just for this) used for SSH access to the instance"
  type        = string
}
