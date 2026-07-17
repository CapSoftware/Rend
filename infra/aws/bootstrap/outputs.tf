output "state_bucket" {
  description = "S3 bucket used by the platform backend."
  value       = aws_s3_bucket.terraform_state.id
}

output "github_deploy_role_arn" {
  description = "OIDC role for the protected Production environment."
  value       = aws_iam_role.github_deploy.arn
}

output "ecr_repository_urls" {
  description = "Immutable Rend image repositories used by GitHub OIDC releases."
  value       = { for name, repository in aws_ecr_repository.service : name => repository.repository_url }
}

output "route53_public_zones" {
  description = "Delegated production zones. Add each nameserver set as an NS record in the current rend.so DNS provider."
  value = {
    for name, zone in aws_route53_zone.public : name => {
      zone_id      = zone.zone_id
      zone_name    = zone.name
      name_servers = zone.name_servers
    }
  }
}
