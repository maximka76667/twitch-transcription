data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "admin" {
  key_name   = "twitch-transcription-admin"
  public_key = var.ssh_public_key
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]
  key_name               = aws_key_pair.admin.key_name

  root_block_device {
    volume_type = "gp3"
    volume_size = 30 # default 8GB is too tight for k3s + Kafka + Docker images + whisper model weights
  }

  tags = {
    Name = "twitch-transcription"
  }
}

# Stable address a domain can point at - a bare EC2 public IP changes on
# stop/start, which would silently break DNS.
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Name = "twitch-transcription"
  }
}
