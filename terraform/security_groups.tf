# SSH/k3s-API restricted to allowed_admin_cidr (your own IP), 80/443 public
# for Caddy + Let's Encrypt. Kafka (9092/29092) and the api Service's port
# (8000) are deliberately NOT opened here - internal-only, reached through
# Caddy on 443 once step 6 (Caddy/TLS) exists.
resource "aws_security_group" "app" {
  name        = "twitch-transcription"
  description = "twitch-transcription EC2 box"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "SSH (admin only)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_admin_cidr]
  }

  ingress {
    description = "k3s API (admin only)"
    from_port   = 6443
    to_port     = 6443
    protocol    = "tcp"
    cidr_blocks = [var.allowed_admin_cidr]
  }

  ingress {
    description = "HTTP (ACME challenge + redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS (Caddy - serves the frontend + proxies the API)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "twitch-transcription"
  }
}
