provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "terraform_data" "account_guard" {
  input = data.aws_caller_identity.current.account_id

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "Refusing to manage Rend outside AWS account ${var.expected_account_id}."
    }
  }
}

data "aws_ssm_parameters_by_path" "deployment_gates" {
  path = "/rend/${var.environment}/deployment-gates/"
}

locals {
  deployment_gate_parameters = zipmap(
    data.aws_ssm_parameters_by_path.deployment_gates.names,
    data.aws_ssm_parameters_by_path.deployment_gates.values,
  )
  activation_complete = contains(
    keys(local.deployment_gate_parameters),
    "/rend/${var.environment}/deployment-gates/activation-complete",
  )
  migration_ready_revision = lookup(
    local.deployment_gate_parameters,
    "/rend/${var.environment}/deployment-gates/migration-ready",
    "",
  )
}

resource "terraform_data" "service_activation_guard" {
  input = var.services_enabled

  lifecycle {
    precondition {
      condition     = var.services_enabled || !local.activation_complete
      error_message = "services_enabled is a one-way activation gate and cannot be set false after activation-complete exists. Use the documented emergency ECS scale-to-zero procedure instead."
    }

    precondition {
      condition     = !var.services_enabled || local.activation_complete || var.worker_cutover_confirmed
      error_message = "worker_cutover_confirmed must be true for the first activation after the Latitude worker is drained."
    }

    precondition {
      condition = !var.services_enabled || local.activation_complete || (
        var.release_revision != "" && local.migration_ready_revision == var.release_revision
      )
      error_message = "The first activation requires a migration-ready marker that exactly matches release_revision."
    }
  }
}
