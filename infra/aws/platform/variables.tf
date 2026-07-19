variable "expected_account_id" {
  description = "Dedicated Rend AWS account."
  type        = string
  default     = "211125561119"

  validation {
    condition     = var.expected_account_id == "211125561119"
    error_message = "Rend infrastructure is locked to AWS account 211125561119."
  }
}

variable "aws_region" {
  description = "Primary region for Rend compute and ClickHouse."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "production"
}

variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "rend"
}

variable "availability_zones" {
  description = "Exactly two availability zones used by ECS and the internal ALB."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) == 2 && var.availability_zones[0] != var.availability_zones[1]
    error_message = "Provide exactly two distinct availability zones."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the Rend VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "api_route53_zone_id" {
  description = "Delegated public Route53 hosted zone for api_domain_name and its origin hostname."
  type        = string
}

variable "api_domain_name" {
  description = "Public API hostname routed directly to the public ALB."
  type        = string
  default     = "api.rend.so"
}

variable "playback_domain_name" {
  description = "Public playback hostname routed directly to the Tigris custom domain."
  type        = string
  default     = "video.rend.so"
}

variable "internal_domain_name" {
  description = "TLS hostname resolving to the internal ALB for ECS control traffic."
  type        = string
  default     = "origin.api.rend.so"
}

variable "site_domain_name" {
  description = "Public site origin allowed by API and Tigris CORS."
  type        = string
  default     = "https://rend.so"
}

variable "additional_site_origins" {
  description = "Additional browser origins allowed by API and Tigris CORS."
  type        = list(string)
  default     = ["https://www.rend.so"]
}

variable "playback_cookie_domain" {
  description = "Cookie domain shared by the API and playback host."
  type        = string
  default     = "rend.so"
}

variable "api_image" {
  description = "Immutable rend-api ECR image reference including @sha256 digest."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be an immutable @sha256 reference."
  }
}

variable "worker_image" {
  description = "Immutable rend-media-worker ECR image reference including @sha256 digest."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "worker_image must be an immutable @sha256 reference."
  }
}

variable "tigris_endpoint" {
  description = "HTTPS S3-compatible endpoint for the external private Tigris buckets."
  type        = string

  validation {
    condition     = startswith(var.tigris_endpoint, "https://")
    error_message = "Production Tigris endpoint must use HTTPS."
  }
}

variable "tigris_region" {
  description = "Tigris S3 region value."
  type        = string
  default     = "auto"
}

variable "tigris_source_bucket" {
  description = "Private source-upload bucket created and reconciled by Terraform through the Tigris S3 API."
  type        = string
}

variable "tigris_media_bucket" {
  description = "Private generated-media bucket created and reconciled by Terraform through the Tigris S3 API."
  type        = string
}

variable "tigris_source_location" {
  description = "Tigris location contract for globally available browser source uploads."
  type        = string
  default     = "global"

  validation {
    condition     = var.tigris_source_location == "global"
    error_message = "The hosted source bucket must remain global."
  }
}

variable "tigris_media_location" {
  description = "Single Tigris region colocated with the us-east-1 media workers."
  type        = string
  default     = "iad"

  validation {
    condition     = var.tigris_media_location == "iad"
    error_message = "The initial hosted media bucket must remain in iad to minimize worker transfer."
  }
}

variable "planetscale_vpc_endpoint_service_name" {
  description = "PlanetScale AWS PrivateLink endpoint service name for the production database."
  type        = string

  validation {
    condition     = startswith(var.planetscale_vpc_endpoint_service_name, "com.amazonaws.vpce.")
    error_message = "planetscale_vpc_endpoint_service_name must be a valid AWS endpoint service name."
  }
}

variable "tigris_access_key_id_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing only the Tigris access key ID."
  type        = string
  sensitive   = true
}

variable "tigris_secret_access_key_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing only the Tigris secret access key."
  type        = string
  sensitive   = true
}

variable "database_url_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the TLS PlanetScale PostgreSQL URL."
  type        = string
  sensitive   = true
}

variable "clickhouse_password_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the ClickHouse password."
  type        = string
  sensitive   = true
}

variable "site_internal_token_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the site-to-API token."
  type        = string
  sensitive   = true
}

variable "edge_internal_token_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the edge control token."
  type        = string
  sensitive   = true
}

variable "internal_telemetry_token_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the telemetry ingest token."
  type        = string
  sensitive   = true
}

variable "playback_signing_secret_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the Rend playback signing secret."
  type        = string
  sensitive   = true
}

variable "cloudfront_private_key_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the private key paired with the CloudFront playback public key."
  type        = string
  sensitive   = true
}

variable "cloudfront_public_key_pem" {
  description = "PEM-encoded RSA public key CloudFront uses to verify private playback signed cookies."
  type        = string

  validation {
    condition     = startswith(trimspace(var.cloudfront_public_key_pem), "-----BEGIN PUBLIC KEY-----")
    error_message = "cloudfront_public_key_pem must be a PEM-encoded public key."
  }
}

variable "autumn_secret_key_parameter_arn" {
  description = "Existing SSM SecureString parameter ARN containing the Autumn production key."
  type        = string
  sensitive   = true
}

variable "parameter_kms_key_arns" {
  description = "Optional customer-managed KMS keys used by externally created SecureString parameters."
  type        = list(string)
  default     = []
}

variable "clickhouse_database" {
  description = "ClickHouse database name."
  type        = string
  default     = "rend"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.clickhouse_database))
    error_message = "clickhouse_database must be a safe ClickHouse identifier."
  }
}

variable "clickhouse_user" {
  description = "ClickHouse application user."
  type        = string
  default     = "rend"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.clickhouse_user))
    error_message = "clickhouse_user must be a safe ClickHouse identifier."
  }
}

variable "clickhouse_instance_type" {
  description = "ARM Graviton instance used for ClickHouse."
  type        = string
  default     = "m7g.large"
}

variable "clickhouse_data_volume_gib" {
  description = "Encrypted gp3 data volume size."
  type        = number
  default     = 100

  validation {
    condition     = var.clickhouse_data_volume_gib >= 100
    error_message = "ClickHouse data volume must be at least 100 GiB."
  }
}

variable "clickhouse_backup_retention_days" {
  description = "AWS Backup retention for the ClickHouse EBS volume."
  type        = number
  default     = 35
}

variable "services_enabled" {
  description = "One-way production activation gate. It starts Rend services after migration and worker handoff; it is not a shutdown toggle and must remain true after activation."
  type        = bool
  default     = false
}

variable "worker_cutover_confirmed" {
  description = "Explicit confirmation that the Latitude worker is drained before enabling Fargate services."
  type        = bool
  default     = false
}

variable "release_revision" {
  description = "Immutable source revision that the migration-ready marker must match before service activation."
  type        = string
  default     = ""
}

variable "api_min_tasks" {
  type    = number
  default = 2

  validation {
    condition     = var.api_min_tasks == 2
    error_message = "api_min_tasks is fixed at 2 for the initial production architecture."
  }
}

variable "api_max_tasks" {
  type    = number
  default = 6


  validation {
    condition     = var.api_max_tasks >= 2 && var.api_max_tasks <= 6
    error_message = "api_max_tasks must be between 2 and the hard ceiling of 6."
  }
}

variable "worker_min_tasks" {
  type    = number
  default = 1


  validation {
    condition     = var.worker_min_tasks == 1
    error_message = "worker_min_tasks is fixed at 1 for the initial production architecture."
  }
}

variable "worker_max_tasks" {
  type    = number
  default = 50


  validation {
    condition     = var.worker_max_tasks >= 1 && var.worker_max_tasks <= 50
    error_message = "worker_max_tasks must be between 1 and the hard global ceiling of 50."
  }
}

variable "monthly_budget_usd" {
  description = "Alerting budget. Capacity and quota limits remain the hard cost controls."
  type        = number
  default     = 400

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be positive."
  }
}

variable "rend_cost_allocation_tag_active" {
  description = "Creates the Rend-only budget after the AWS Organizations management account activates the Application cost allocation tag. Other infrastructure remains deployable while false."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Required operations email for budget and alarm notifications. Subscription confirmation is required."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email))
    error_message = "alert_email must be a valid operations email address."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "tls_proxy_image" {
  description = "Pinned Caddy image used only for self-signed TLS between the internal ALB and ECS tasks."
  type        = string
  default     = "public.ecr.aws/docker/library/caddy:2.10.0-alpine@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.tls_proxy_image))
    error_message = "tls_proxy_image must be an immutable @sha256 reference."
  }
}
