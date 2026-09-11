output "public_ip" {
  description = "Elastic IP of the instance - point your domain's A record here"
  value       = aws_eip.app.public_ip
}

output "ssh_command" {
  description = "Ready-to-paste SSH command"
  value       = "ssh ubuntu@${aws_eip.app.public_ip}"
}
