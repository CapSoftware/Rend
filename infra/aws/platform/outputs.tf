output "api_url" {
  value = local.api_base_url
}

output "playback_url" {
  value = local.playback_base_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_names" {
  value = {
    api    = aws_ecs_service.api.name
    worker = aws_ecs_service.worker.name
  }
}

output "ecs_scalable_target_arns" {
  description = "Exact Rend autoscaling targets to grant the shared-account GitHub role after the administrator bootstrap apply."
  value       = [for target in aws_appautoscaling_target.ecs : target.arn]
}

output "task_definition_arns" {
  description = "New immutable task definitions. Release automation migrates before updating services to these revisions."
  value = {
    api     = aws_ecs_task_definition.api.arn
    migrate = aws_ecs_task_definition.migrate.arn
    worker  = aws_ecs_task_definition.worker.arn
  }
}

output "ecs_public_subnet_ids" {
  value = [for subnet in aws_subnet.public : subnet.id]
}

output "ecs_security_group_id" {
  value = aws_security_group.ecs.id
}

output "clickhouse_instance_id" {
  value = aws_instance.clickhouse.id
}

output "clickhouse_schema_etag" {
  description = "Content revision that the deployment workflow must apply before service promotion."
  value       = aws_s3_object.clickhouse_schema.etag
}

output "clickhouse_schema_uri" {
  description = "Private bootstrap schema object consumed by the ClickHouse migration command."
  value       = "s3://${aws_s3_object.clickhouse_schema.bucket}/${aws_s3_object.clickhouse_schema.key}"
}

output "clickhouse_private_url" {
  value = "https://${local.clickhouse_internal_domain}"
}

output "alert_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "tigris_required_cors" {
  description = "CORS origins reconciled onto the private Tigris buckets by Terraform."
  value = {
    allowed_origins = local.site_origins
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Range"]
    max_age_seconds = 3600
  }
}
