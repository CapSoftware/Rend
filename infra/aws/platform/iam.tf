data "aws_iam_policy_document" "ecs_task_execution_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }

}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${local.resource_prefix}-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    sid       = "ReadRuntimeSecrets"
    actions   = ["ssm:GetParameters"]
    resources = local.parameter_arns
  }

  dynamic "statement" {
    for_each = length(var.parameter_kms_key_arns) == 0 ? [] : [1]
    content {
      sid       = "DecryptRuntimeSecrets"
      actions   = ["kms:Decrypt"]
      resources = var.parameter_kms_key_arns
    }
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "RuntimeSecrets"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

resource "aws_iam_role" "ecs_task" {
  name               = "${local.resource_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume.json
}

data "aws_iam_policy_document" "ecs_task" {
  statement {
    sid = "ECSExec"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }

  statement {
    sid = "PublishMediaQueueMetrics"
    actions = [
      "cloudwatch:PutMetricData",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Rend/Media"]
    }
  }

  statement {
    sid = "ProtectActiveMediaTask"
    actions = [
      "ecs:GetTaskProtection",
      "ecs:UpdateTaskProtection",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${var.expected_account_id}:task/${local.resource_prefix}/*",
    ]
  }

  statement {
    sid       = "InvalidateDeletedPlayback"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.this.arn]
  }
}

resource "aws_iam_role_policy" "ecs_task" {
  name   = "RendRuntime"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task.json
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "clickhouse" {
  name               = "${local.resource_prefix}-clickhouse"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "clickhouse_ssm" {
  role       = aws_iam_role.clickhouse.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "clickhouse_secret" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [var.clickhouse_password_parameter_arn]
  }

  statement {
    sid       = "RecordAppliedClickHouseSchema"
    actions   = ["ssm:PutParameter"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${var.expected_account_id}:parameter/rend/${var.environment}/deployment-gates/clickhouse-schema-applied"]
  }

  dynamic "statement" {
    for_each = length(var.parameter_kms_key_arns) == 0 ? [] : [1]
    content {
      actions   = ["kms:Decrypt"]
      resources = var.parameter_kms_key_arns
    }
  }
}

data "aws_iam_policy_document" "clickhouse_native_backup_access" {
  statement {
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.clickhouse_native_backups.arn,
      "${aws_s3_bucket.clickhouse_native_backups.arn}/*",
    ]
  }

  statement {
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.clickhouse.arn]
  }

  statement {
    sid = "ReadCloudFrontStandardLogs"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.cloudfront_logs.arn,
      "${aws_s3_bucket.cloudfront_logs.arn}/cloudfront/*",
    ]
  }
}

resource "aws_iam_role_policy" "clickhouse_native_backups" {
  name   = "ClickHouseNativeBackups"
  role   = aws_iam_role.clickhouse.id
  policy = data.aws_iam_policy_document.clickhouse_native_backup_access.json
}

resource "aws_iam_role_policy" "clickhouse_secret" {
  name   = "ClickHouseBootstrapSecret"
  role   = aws_iam_role.clickhouse.id
  policy = data.aws_iam_policy_document.clickhouse_secret.json
}

resource "aws_iam_instance_profile" "clickhouse" {
  name = "${local.resource_prefix}-clickhouse"
  role = aws_iam_role.clickhouse.name
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.resource_prefix}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_assume.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}
