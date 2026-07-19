provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "rend"
      ManagedBy   = "terraform"
      Scope       = "bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  state_bucket_name = coalesce(var.state_bucket_name, "rend-terraform-state-${var.expected_account_id}")
}

resource "terraform_data" "account_guard" {
  input = data.aws_caller_identity.current.account_id

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "Refusing to bootstrap outside Rend AWS account ${var.expected_account_id}."
    }
  }
}

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [terraform_data.account_guard]
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "terraform_state" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.terraform_state.arn,
      "${aws_s3_bucket.terraform_state.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  policy = data.aws_iam_policy_document.terraform_state.json
}

resource "aws_route53_zone" "public" {
  for_each = {
    api      = var.api_dns_zone_name
    playback = var.playback_dns_zone_name
  }

  name    = each.value
  comment = "Delegated Rend ${each.key} production zone"

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [terraform_data.account_guard]
}

resource "aws_ecr_repository" "service" {
  for_each = toset(["rend-api", "rend-edge", "rend-media-worker"])

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after seven days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
  ]
}

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "RendGitHubTerraformDeploy"
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_assume.json
  max_session_duration = 7200
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid = "ReadPlatformMetadata"
    actions = [
      "acm:Describe*", "acm:Get*", "acm:List*",
      "application-autoscaling:Describe*",
      "backup:Get*", "backup:List*",
      "budgets:Describe*", "budgets:View*",
      "cloudfront:Get*", "cloudfront:List*",
      "cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*",
      "ec2:Describe*", "ec2:Get*",
      "ecr:Describe*", "ecr:Get*", "ecr:List*",
      "ecs:Describe*", "ecs:List*",
      "elasticloadbalancing:Describe*",
      "iam:Get*", "iam:List*",
      "kms:Describe*", "kms:Get*", "kms:List*",
      "logs:Describe*", "logs:List*",
      "route53:Get*", "route53:List*",
      "s3:GetAccountPublicAccessBlock", "s3:ListAllMyBuckets",
      "sns:Get*", "sns:List*",
      "ssm:DescribeParameters",
      "wafv2:Get*", "wafv2:List*",
    ]
    resources = ["*"]
  }

  # Name-addressable resources stay inside the Rend namespace. This account is
  # shared, so a service-wide mutation grant is intentionally forbidden.
  statement {
    sid     = "ManageNamedRendResources"
    actions = ["ecr:*", "s3:*"]
    resources = concat(
      [
        aws_s3_bucket.terraform_state.arn,
        "${aws_s3_bucket.terraform_state.arn}/*",
      ],
      [for repository in aws_ecr_repository.service : repository.arn],
    )
  }

  statement {
    sid = "ManageNamedRendPlatformResources"
    actions = [
      "backup:*", "budgets:*", "cloudwatch:*",
      "elasticloadbalancing:*", "logs:*",
      "s3:*", "sns:*", "ssm:*", "wafv2:*",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:backup:${var.aws_region}:${var.expected_account_id}:backup-vault:rend-*",
      "arn:${data.aws_partition.current.partition}:budgets::${var.expected_account_id}:budget/rend-*",
      "arn:${data.aws_partition.current.partition}:cloudwatch:${var.aws_region}:${var.expected_account_id}:alarm:rend-*",
      "arn:${data.aws_partition.current.partition}:cloudwatch::${var.expected_account_id}:dashboard/rend-*",
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:cluster/rend-*",
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:service/rend-*/*",
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:task-definition/rend-*:*",
      "arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${var.expected_account_id}:loadbalancer/app/rend-*/*",
      "arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${var.expected_account_id}:listener/app/rend-*/*/*",
      "arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${var.expected_account_id}:listener-rule/app/rend-*/*/*/*",
      "arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${var.expected_account_id}:targetgroup/rend-*/*",
      "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${var.expected_account_id}:log-group:/rend/*",
      "arn:${data.aws_partition.current.partition}:s3:::rend-*",
      "arn:${data.aws_partition.current.partition}:sns:${var.aws_region}:${var.expected_account_id}:rend-*",
      "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${var.expected_account_id}:parameter/rend/*",
      "arn:${data.aws_partition.current.partition}:wafv2:us-east-1:${var.expected_account_id}:global/webacl/rend-*/*",
      "arn:${data.aws_partition.current.partition}:wafv2:${var.aws_region}:${var.expected_account_id}:regional/webacl/rend-*/*",
    ]
  }

  statement {
    sid = "UseTaggedRendKmsKeys"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:kms:${var.aws_region}:${var.expected_account_id}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Application"
      values   = ["rend"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = ["production"]
    }
  }

  statement {
    sid = "ManageFixedProductionRolePolicies"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/rend-production-backup",
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/rend-production-clickhouse",
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/rend-production-ecs-task",
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/rend-production-ecs-task-execution",
    ]
  }

  statement {
    sid       = "ManageDelegatedRendZones"
    actions   = ["route53:ChangeResourceRecordSets", "route53:ChangeTagsForResource"]
    resources = [for zone in aws_route53_zone.public : zone.arn]
  }

  statement {
    sid       = "UseRunShellScriptForRendClickHouse"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}::document/AWS-RunShellScript"]
  }

  statement {
    sid       = "SendCommandsOnlyToRendClickHouse"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${var.expected_account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Application"
      values   = ["rend"]
    }

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Environment"
      values   = ["production"]
    }

    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/Name"
      values   = ["rend-production-clickhouse"]
    }
  }

  statement {
    sid = "RegisterTaggedRendTaskDefinitions"
    actions = [
      "ecs:RegisterTaskDefinition",
    ]
    # RegisterTaskDefinition does not support resource-level permissions.
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Application"
      values   = ["rend"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = ["production"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/ManagedBy"
      values   = ["terraform"]
    }
  }

  statement {
    sid = "ManageProductionEcsReleases"
    actions = [
      "ecs:DeregisterTaskDefinition",
      "ecs:TagResource",
      "ecs:UntagResource",
      "ecs:UpdateService",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:cluster/rend-production",
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:service/rend-production/*",
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:task-definition/rend-production-*:*",
    ]
  }

  statement {
    sid       = "RunOnlyProductionMigrationTask"
    actions   = ["ecs:RunTask"]
    resources = ["arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:task-definition/rend-production-migrate:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:cluster/rend-production"]
    }
  }

  dynamic "statement" {
    for_each = length(var.rend_scalable_target_arns) > 0 ? [1] : []
    content {
      sid = "ManageExactRendAutoscalingTargets"
      actions = [
        "application-autoscaling:DeleteScalingPolicy",
        "application-autoscaling:DeregisterScalableTarget",
        "application-autoscaling:PutScalingPolicy",
        "application-autoscaling:RegisterScalableTarget",
      ]
      resources = var.rend_scalable_target_arns

      condition {
        test     = "StringEquals"
        variable = "application-autoscaling:service-namespace"
        values   = ["ecs"]
      }

      condition {
        test     = "StringEquals"
        variable = "application-autoscaling:scalable-dimension"
        values   = ["ecs:service:DesiredCount"]
      }

      condition {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Application"
        values   = ["rend"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.rend_scalable_target_arns) > 0 ? [1] : []
    content {
      sid = "TagExactRendAutoscalingTargets"
      actions = [
        "application-autoscaling:ListTagsForResource",
        "application-autoscaling:TagResource",
        "application-autoscaling:UntagResource",
      ]
      resources = var.rend_scalable_target_arns

      condition {
        test     = "StringEquals"
        variable = "aws:ResourceTag/Application"
        values   = ["rend"]
      }
    }
  }

  statement {
    sid       = "PublishRendImages"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"]
    resources = [for repository in aws_ecr_repository.service : repository.arn]
  }

  statement {
    sid     = "PassOnlyFixedProductionTaskRoles"
    actions = ["iam:PassRole"]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/rend-production-ecs-task-execution",
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/rend-production-ecs-task",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "IdentifyAccount"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "RendPlatformDeployment"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
