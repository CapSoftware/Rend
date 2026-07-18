data "aws_ami" "amazon_linux_arm64" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

resource "aws_kms_key" "clickhouse" {
  description             = "Rend ClickHouse EBS and backup encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "clickhouse" {
  name          = "alias/${local.resource_prefix}-clickhouse"
  target_key_id = aws_kms_key.clickhouse.key_id
}

resource "aws_s3_bucket" "clickhouse_native_backups" {
  bucket = "${local.resource_prefix}-clickhouse-backups-${var.expected_account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "clickhouse_native_backups" {
  bucket = aws_s3_bucket.clickhouse_native_backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "clickhouse_native_backups" {
  bucket = aws_s3_bucket.clickhouse_native_backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "clickhouse_native_backups" {
  bucket = aws_s3_bucket.clickhouse_native_backups.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.clickhouse.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "clickhouse_native_backups" {
  bucket = aws_s3_bucket.clickhouse_native_backups.id

  rule {
    id     = "native-backup-retention"
    status = "Enabled"
    filter {
      prefix = "nightly-"
    }

    expiration {
      days = var.clickhouse_backup_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

data "aws_iam_policy_document" "clickhouse_native_backups" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.clickhouse_native_backups.arn,
      "${aws_s3_bucket.clickhouse_native_backups.arn}/*",
    ]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "clickhouse_native_backups" {
  bucket = aws_s3_bucket.clickhouse_native_backups.id
  policy = data.aws_iam_policy_document.clickhouse_native_backups.json
}

resource "aws_s3_object" "clickhouse_schema" {
  bucket                 = aws_s3_bucket.clickhouse_native_backups.id
  key                    = "bootstrap/clickhouse-schema.sql"
  content                = join("\n", [for schema in sort(fileset("${path.module}/../../../clickhouse", "*.sql")) : file("${path.module}/../../../clickhouse/${schema}")])
  source_hash            = sha256(join("\n", [for schema in sort(fileset("${path.module}/../../../clickhouse", "*.sql")) : file("${path.module}/../../../clickhouse/${schema}")]))
  server_side_encryption = "aws:kms"
  kms_key_id             = aws_kms_key.clickhouse.arn
}

resource "aws_ebs_volume" "clickhouse_data" {
  availability_zone = var.availability_zones[0]
  size              = var.clickhouse_data_volume_gib
  type              = "gp3"
  iops              = 3000
  throughput        = 125
  encrypted         = true
  kms_key_id        = aws_kms_key.clickhouse.arn

  tags = {
    Name   = "${local.resource_prefix}-clickhouse-data"
    Backup = "daily"
  }
}

resource "aws_instance" "clickhouse" {
  ami                         = data.aws_ami.amazon_linux_arm64.id
  instance_type               = var.clickhouse_instance_type
  availability_zone           = var.availability_zones[0]
  subnet_id                   = aws_subnet.public[var.availability_zones[0]].id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.clickhouse.id]
  iam_instance_profile        = aws_iam_instance_profile.clickhouse.name
  monitoring                  = true

  user_data = templatefile("${path.module}/clickhouse-user-data.sh.tftpl", {
    aws_region             = var.aws_region
    backup_bucket          = aws_s3_bucket.clickhouse_native_backups.id
    backup_kms_key_arn     = aws_kms_key.clickhouse.arn
    clickhouse_database    = var.clickhouse_database
    clickhouse_user        = var.clickhouse_user
    clickhouse_schema_uri  = "s3://${aws_s3_object.clickhouse_schema.bucket}/${aws_s3_object.clickhouse_schema.key}"
    cloudfront_log_bucket  = aws_s3_bucket.cloudfront_logs.id
    data_volume_id         = aws_ebs_volume.clickhouse_data.id
    password_parameter_arn = var.clickhouse_password_parameter_arn
  })

  user_data_replace_on_change = true

  root_block_device {
    encrypted   = true
    kms_key_id  = aws_kms_key.clickhouse.arn
    volume_size = 30
    volume_type = "gp3"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = {
    Name = "${local.resource_prefix}-clickhouse"
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_volume_attachment" "clickhouse_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.clickhouse_data.id
  instance_id = aws_instance.clickhouse.id
}

resource "aws_backup_vault" "clickhouse" {
  name        = "${local.resource_prefix}-clickhouse"
  kms_key_arn = aws_kms_key.clickhouse.arn
}

resource "aws_backup_plan" "clickhouse" {
  name = "${local.resource_prefix}-clickhouse"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.clickhouse.name
    schedule          = "cron(0 3 * * ? *)"
    start_window      = 60
    completion_window = 240

    lifecycle {
      delete_after = var.clickhouse_backup_retention_days
    }

    recovery_point_tags = local.common_tags
  }
}

resource "aws_backup_selection" "clickhouse" {
  name         = "${local.resource_prefix}-clickhouse-volume"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.clickhouse.id
  resources    = [aws_ebs_volume.clickhouse_data.arn]
}
