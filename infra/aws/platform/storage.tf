resource "terraform_data" "tigris_buckets" {
  input = {
    endpoint        = var.tigris_endpoint
    region          = var.tigris_region
    source_bucket   = var.tigris_source_bucket
    media_bucket    = var.tigris_media_bucket
    source_location = var.tigris_source_location
    media_location  = var.tigris_media_location
    allowed_origins = local.site_origins
  }

  triggers_replace = [
    var.tigris_endpoint,
    var.tigris_region,
    var.tigris_source_bucket,
    var.tigris_media_bucket,
    var.tigris_source_location,
    var.tigris_media_location,
    sha256(jsonencode(local.site_origins)),
  ]

  lifecycle {
    precondition {
      condition     = var.tigris_source_bucket != var.tigris_media_bucket
      error_message = "Source and generated media must use separate private Tigris buckets."
    }

    precondition {
      condition     = startswith(var.tigris_endpoint, "https://")
      error_message = "The Tigris production endpoint must use HTTPS."
    }
  }

  provisioner "local-exec" {
    command = "${path.module}/../scripts/provision-tigris.sh"

    environment = {
      TIGRIS_ENDPOINT                 = var.tigris_endpoint
      TIGRIS_REGION                   = var.tigris_region
      TIGRIS_SOURCE_BUCKET            = var.tigris_source_bucket
      TIGRIS_MEDIA_BUCKET             = var.tigris_media_bucket
      TIGRIS_SOURCE_LOCATION          = var.tigris_source_location
      TIGRIS_MEDIA_LOCATION           = var.tigris_media_location
      TIGRIS_ACCESS_KEY_PARAMETER_ARN = var.tigris_access_key_id_parameter_arn
      TIGRIS_SECRET_KEY_PARAMETER_ARN = var.tigris_secret_access_key_parameter_arn
      TIGRIS_ALLOWED_ORIGINS_JSON     = jsonencode(local.site_origins)
    }
  }

  depends_on = [terraform_data.account_guard]
}

data "aws_canonical_user_id" "current" {}

resource "aws_s3_bucket" "cloudfront_logs" {
  bucket = "${local.resource_prefix}-cloudfront-logs-${var.expected_account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  access_control_policy {
    grant {
      grantee {
        id   = data.aws_canonical_user_id.current.id
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }

    grant {
      grantee {
        id   = "c4c1ede66af53448b93c283ce9448c4ba468c9432aa01d700d3878632f77d2d0"
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }

    owner {
      id = data.aws_canonical_user_id.current.id
    }
  }

  depends_on = [aws_s3_bucket_ownership_controls.cloudfront_logs]
}

resource "aws_s3_bucket_public_access_block" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

data "aws_iam_policy_document" "cloudfront_logs" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.cloudfront_logs.arn,
      "${aws_s3_bucket.cloudfront_logs.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudfront_logs" {
  bucket = aws_s3_bucket.cloudfront_logs.id
  policy = data.aws_iam_policy_document.cloudfront_logs.json
}
