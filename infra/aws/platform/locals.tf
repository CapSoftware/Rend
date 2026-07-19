locals {
  resource_prefix = "${var.name}-${var.environment}"

  common_tags = {
    Application = "rend"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  public_subnet_cidrs = [
    cidrsubnet(var.vpc_cidr, 8, 0),
    cidrsubnet(var.vpc_cidr, 8, 1),
  ]
  private_subnet_cidrs = [
    cidrsubnet(var.vpc_cidr, 8, 2),
    cidrsubnet(var.vpc_cidr, 8, 3),
  ]

  playback_base_url                    = "https://${var.playback_domain_name}"
  api_base_url                         = "https://${var.api_domain_name}"
  internal_base_url                    = "https://${var.internal_domain_name}"
  clickhouse_internal_domain           = "clickhouse.${var.internal_domain_name}"
  site_origins                         = distinct(concat([var.site_domain_name], var.additional_site_origins))
  allowed_origins                      = join(",", distinct(concat(local.site_origins, [local.api_base_url, local.playback_base_url])))
  edge_id                              = "aws-edge-pool"
  edge_region                          = var.aws_region
  expected_edges                       = "${local.edge_id}=${local.edge_region}=${local.playback_base_url}"
  tigris_playback_key_id_parameter_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${var.expected_account_id}:parameter/rend/${var.environment}/tigris-playback-key-id"

  common_container_environment = [
    { name = "REND_ENV", value = "production" },
    { name = "CLICKHOUSE_URL", value = "https://${local.clickhouse_internal_domain}" },
    { name = "CLICKHOUSE_DATABASE", value = var.clickhouse_database },
    { name = "CLICKHOUSE_USER", value = var.clickhouse_user },
    { name = "OBJECT_STORE_HEALTH_URL", value = var.tigris_endpoint },
    { name = "S3_ENDPOINT", value = var.tigris_endpoint },
    { name = "S3_PRESIGN_ENDPOINT", value = var.tigris_endpoint },
    { name = "S3_REGION", value = var.tigris_region },
    { name = "S3_BUCKET", value = var.tigris_media_bucket },
    { name = "S3_SOURCE_BUCKET", value = var.tigris_source_bucket },
    { name = "REND_PLAYBACK_MODE", value = "tigris" },
    { name = "REND_PLAYBACK_BASE_URL", value = local.playback_base_url },
    { name = "REND_TIGRIS_PLAYBACK_BASE_URL", value = local.playback_base_url },
    { name = "REND_PUBLIC_PLAYBACK_ENABLED", value = "true" },
    { name = "REND_PUBLIC_PLAYBACK_ALIAS_ENABLED", value = "true" },
    { name = "REND_PUBLIC_PLAYBACK_ALIAS_BUCKET", value = var.tigris_media_bucket },
    { name = "REND_PUBLIC_PLAYBACK_ALIAS_PREFIX", value = "v" },
    { name = "REND_PUBLIC_PLAYBACK_ALIAS_ACL", value = "inherit" },
    { name = "REND_PUBLIC_PLAYBACK_ALIAS_METADATA_RENAME", value = "true" },
    { name = "REND_EXPECTED_EDGES", value = local.expected_edges },
    { name = "REND_ALLOW_INSECURE_EDGE_URLS", value = "false" },
    { name = "REND_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS", value = "120" },
    { name = "REND_MAX_UPLOAD_BYTES", value = "268435456000" },
    { name = "REND_UPLOAD_SESSION_TTL_SECS", value = "86400" },
    { name = "REND_UPLOAD_SIGNED_URL_TTL_SECS", value = "900" },
    { name = "REND_ORGANIZATION_STORAGE_BYTES", value = "268435456000" },
    { name = "REND_PLATFORM_STORAGE_BYTES", value = "5497558138880" },
    { name = "REND_ORGANIZATION_VIDEO_LIMIT", value = "50" },
    { name = "REND_OPEN_UPLOAD_SESSIONS_PER_ORGANIZATION", value = "10" },
    { name = "REND_ACTIVE_MEDIA_JOBS_PER_ORGANIZATION", value = "2" },
    { name = "REND_PLAYBACK_SIGNING_KEY_ID", value = "aws-production-001" },
    { name = "REND_PLAYBACK_TOKEN_TTL_SECS", value = "900" },
    { name = "REND_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS", value = "8" },
    { name = "REND_PLAYBACK_TELEMETRY_MAX_BODY_BYTES", value = "262144" },
    { name = "REND_PLAYBACK_TELEMETRY_MAX_EVENTS_PER_BATCH", value = "100" },
    { name = "REND_PLAYBACK_ANALYTICS_DEFAULT_WINDOW_SECS", value = "86400" },
    { name = "REND_PLAYBACK_ANALYTICS_MAX_WINDOW_SECS", value = "604800" },
    { name = "REND_EDGE_WARM_MAX_ARTIFACTS", value = "16" },
    { name = "REND_HTTP_TIMEOUT_SECS", value = "120" },
    { name = "REND_FFMPEG_PATH", value = "/usr/bin/ffmpeg" },
    { name = "REND_FFPROBE_PATH", value = "/usr/bin/ffprobe" },
    { name = "REND_MEDIA_PROCESS_TIMEOUT_SECS", value = "7200" },
    { name = "REND_MEDIA_JOB_MAX_ATTEMPTS", value = "3" },
    { name = "REND_MEDIA_WORKER_POLL_INTERVAL_SECS", value = "1" },
    { name = "REND_MEDIA_JOB_LEASE_SECS", value = "120" },
    { name = "REND_MEDIA_JOB_HEARTBEAT_SECS", value = "30" },
    { name = "REND_MEDIA_SHUTDOWN_GRACE_SECS", value = "90" },
    { name = "REND_MEDIA_MONTHLY_BUDGET_MICROUSD", value = "250000000" },
    { name = "REND_MEDIA_MONTHLY_BASE_MICROUSD", value = "154000000" },
    { name = "REND_MEDIA_JOB_CEILING_MICROUSD", value = "25000000" },
    { name = "REND_MEDIA_TASK_MICROUSD_PER_SECOND", value = "57" },
    { name = "REND_MEDIA_EGRESS_MICROUSD_PER_GIB", value = "100000" },
    { name = "REND_MEDIA_BUDGET_SAFETY_FACTOR", value = "2" },
    { name = "REND_BILLING_MODE", value = "autumn" },
    { name = "AUTUMN_API_URL", value = "https://api.useautumn.com/v1" },
    { name = "AUTUMN_API_VERSION", value = "2.3.0" },
    { name = "REND_BILLING_FEATURE_DELIVERY_720P", value = "delivery_720p_seconds" },
    { name = "REND_BILLING_FEATURE_DELIVERY_1080P", value = "delivery_1080p_seconds" },
    { name = "REND_BILLING_FEATURE_DELIVERY_2K", value = "delivery_2k_seconds" },
    { name = "REND_BILLING_FEATURE_DELIVERY_4K", value = "delivery_4k_seconds" },
    { name = "REND_BILLING_FEATURE_STORAGE_720P", value = "storage_720p_second_months" },
    { name = "REND_BILLING_FEATURE_STORAGE_1080P", value = "storage_1080p_second_months" },
    { name = "REND_BILLING_FEATURE_STORAGE_2K", value = "storage_2k_second_months" },
    { name = "REND_BILLING_FEATURE_STORAGE_4K", value = "storage_4k_second_months" },
    { name = "REND_BILLING_ENTITLEMENT_FAILURE_POLICY", value = "fail_closed" },
    { name = "REND_BILLING_DELIVERY_SYNC_LAG_SECS", value = "60" },
    { name = "REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS", value = "3600" },
    { name = "REND_BILLING_STORAGE_SYNC_LAG_SECS", value = "60" },
    { name = "REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS", value = "3600" },
    { name = "RUST_LOG", value = "info" },
  ]

  common_container_secrets = [
    { name = "DATABASE_URL", valueFrom = var.database_url_parameter_arn },
    { name = "CLICKHOUSE_PASSWORD", valueFrom = var.clickhouse_password_parameter_arn },
    { name = "S3_ACCESS_KEY_ID", valueFrom = var.tigris_access_key_id_parameter_arn },
    { name = "S3_SECRET_ACCESS_KEY", valueFrom = var.tigris_secret_access_key_parameter_arn },
    { name = "REND_SITE_INTERNAL_TOKEN", valueFrom = var.site_internal_token_parameter_arn },
    { name = "REND_EDGE_INTERNAL_TOKEN", valueFrom = var.edge_internal_token_parameter_arn },
    { name = "REND_INTERNAL_TELEMETRY_TOKEN", valueFrom = var.internal_telemetry_token_parameter_arn },
    { name = "REND_PLAYBACK_SIGNING_SECRET", valueFrom = var.playback_signing_secret_parameter_arn },
    { name = "AUTUMN_SECRET_KEY", valueFrom = var.autumn_secret_key_parameter_arn },
  ]

  api_container_secrets = concat(local.common_container_secrets, [
    { name = "REND_CLOUDFRONT_PRIVATE_KEY", valueFrom = var.cloudfront_private_key_parameter_arn },
    { name = "REND_CLOUDFRONT_KEY_PAIR_ID", valueFrom = local.tigris_playback_key_id_parameter_arn },
  ])

  edge_container_secrets = [
    { name = "AWS_ACCESS_KEY_ID", valueFrom = var.tigris_access_key_id_parameter_arn },
    { name = "AWS_SECRET_ACCESS_KEY", valueFrom = var.tigris_secret_access_key_parameter_arn },
    { name = "REND_EDGE_INTERNAL_TOKEN", valueFrom = var.edge_internal_token_parameter_arn },
    { name = "REND_INTERNAL_TELEMETRY_TOKEN", valueFrom = var.internal_telemetry_token_parameter_arn },
    { name = "REND_PLAYBACK_SIGNING_SECRET", valueFrom = var.playback_signing_secret_parameter_arn },
  ]

  parameter_arns = distinct(concat(
    [for secret in local.common_container_secrets : secret.valueFrom],
    [for secret in local.edge_container_secrets : secret.valueFrom],
    [var.cloudfront_private_key_parameter_arn],
    [local.tigris_playback_key_id_parameter_arn],
  ))
}
