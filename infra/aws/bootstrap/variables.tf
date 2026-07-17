variable "aws_region" {
  description = "AWS region that stores Terraform state."
  type        = string
  default     = "us-east-1"
}

variable "expected_account_id" {
  description = "AWS account containing the isolated Rend namespace. The guard intentionally cannot be pointed at another account."
  type        = string
  default     = "211125561119"

  validation {
    condition     = var.expected_account_id == "211125561119"
    error_message = "Rend infrastructure is locked to AWS account 211125561119."
  }
}

variable "github_repository" {
  description = "GitHub repository in owner/name form."
  type        = string
}

variable "github_environment" {
  description = "Protected GitHub environment allowed to assume the deployment role."
  type        = string
  default     = "Production"
}

variable "state_bucket_name" {
  description = "Optional globally unique state bucket name."
  type        = string
  default     = null
}

variable "api_dns_zone_name" {
  description = "Delegated public Route53 zone for the production Rend API."
  type        = string
  default     = "api.rend.so"
}

variable "playback_dns_zone_name" {
  description = "Delegated public Route53 zone for production Rend playback."
  type        = string
  default     = "video.rend.so"
}

variable "rend_scalable_target_arns" {
  description = "Exact autoscaling target ARNs emitted by the administrator platform bootstrap. Empty until those targets exist."
  type        = list(string)
  default     = []

  validation {
    condition = (length(var.rend_scalable_target_arns) == 0 || (
      length(var.rend_scalable_target_arns) == 3 &&
      length(distinct(var.rend_scalable_target_arns)) == 3
      )) && alltrue([
      for arn in var.rend_scalable_target_arns :
      startswith(arn, "arn:aws:application-autoscaling:us-east-1:211125561119:scalable-target/")
    ])
    error_message = "Autoscaling access must be empty during bootstrap or contain exactly three distinct Rend target ARNs in account 211125561119/us-east-1."
  }
}
