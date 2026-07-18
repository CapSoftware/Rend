resource "aws_acm_certificate" "public" {
  provider = aws.us_east_1

  domain_name               = var.api_domain_name
  subject_alternative_names = [var.playback_domain_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.public.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id = (
    each.key == var.playback_domain_name
    ? var.playback_route53_zone_id
    : var.api_route53_zone_id
  )
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "public" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.public.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

resource "aws_acm_certificate" "internal" {
  domain_name               = var.internal_domain_name
  subject_alternative_names = [local.clickhouse_internal_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "internal_certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.internal.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id         = var.api_route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "internal" {
  certificate_arn         = aws_acm_certificate.internal.arn
  validation_record_fqdns = [for record in aws_route53_record.internal_certificate_validation : record.fqdn]
}

resource "aws_cloudfront_vpc_origin" "origin" {
  vpc_origin_endpoint_config {
    name                   = "${local.resource_prefix}-origin"
    arn                    = aws_lb.origin.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "https-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

resource "aws_cloudfront_cache_policy" "playback" {
  name    = "${local.resource_prefix}-private-playback"
  comment = "Private playback cache; authorization cookies never enter the cache key"
  # Every published playback path is insert-once and immutable. CloudFront
  # still authorizes signed cookies before cache lookup, while the viewer sees
  # the origin's private Cache-Control header. Forcing the full immutable TTL
  # here avoids exposing a public cache directive to downstream proxies.
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["Origin"]
      }
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_origin_request_policy" "playback" {
  name    = "${local.resource_prefix}-private-playback-origin"
  comment = "Forward only Rend origin authorization; CloudFront auth cookies stop at CloudFront"

  cookies_config {
    cookie_behavior = "whitelist"
    cookies {
      items = ["__rend_playback"]
    }
  }

  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Access-Control-Request-Headers", "Access-Control-Request-Method"]
    }
  }

  query_strings_config {
    query_string_behavior = "none"
  }
}

resource "aws_cloudfront_public_key" "playback" {
  name        = "${local.resource_prefix}-playback"
  comment     = "Rend private playback signed-cookie verification key"
  encoded_key = var.cloudfront_public_key_pem
}

resource "aws_cloudfront_key_group" "playback" {
  name    = "${local.resource_prefix}-playback"
  comment = "Required for every private /v/* request"
  items   = [aws_cloudfront_public_key.playback.id]
}

resource "terraform_data" "cloudfront_flat_rate_plan_guard" {
  input = {
    bootstrap = var.cloudfront_flat_rate_plan_bootstrap
    tier      = var.cloudfront_flat_rate_plan_tier
    verified  = var.cloudfront_flat_rate_plan_verified
  }

  lifecycle {
    precondition {
      condition     = var.cloudfront_flat_rate_plan_verified || var.cloudfront_flat_rate_plan_bootstrap
      error_message = "Production is blocked until the CloudFront flat-rate plan is active in account 211125561119. For the first distribution apply only, explicitly set cloudfront_flat_rate_plan_bootstrap=true, subscribe immediately, then set verified=true and bootstrap=false."
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "public" {
  name = "${local.resource_prefix}-security"

  cors_config {
    access_control_allow_credentials = true

    access_control_allow_headers {
      items = [
        "Accept",
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "If-Match",
        "If-None-Match",
        "Range",
        "X-Requested-With",
      ]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    }

    access_control_allow_origins {
      items = local.site_origins
    }

    access_control_expose_headers {
      items = ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"]
    }

    access_control_max_age_sec = 600
    origin_override            = false
  }

  security_headers_config {
    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }
}

resource "aws_wafv2_web_acl" "cloudfront" {
  provider = aws.us_east_1

  name  = "${local.resource_prefix}-cloudfront"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "BlockInternalRoutes"
    priority = 0

    action {
      block {}
    }

    statement {
      byte_match_statement {
        positional_constraint = "STARTS_WITH"
        search_string         = "/internal/"

        field_to_match {
          uri_path {}
        }

        text_transformation {
          priority = 0
          type     = "NONE"
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "BlockInternalRoutes"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitNonPlaybackByIP"
    priority = 10

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000

        scope_down_statement {
          not_statement {
            statement {
              byte_match_statement {
                positional_constraint = "STARTS_WITH"
                search_string         = "/v/"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitNonPlaybackByIP"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitPlaybackByIP"
    priority = 15

    action {
      block {}
    }

    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 20000

        scope_down_statement {
          byte_match_statement {
            positional_constraint = "STARTS_WITH"
            search_string         = "/v/"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitPlaybackByIP"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSCommonRules"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSCommonRules"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSKnownBadInputs"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSKnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.resource_prefix}-cloudfront"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudwatch_log_group" "waf" {
  provider = aws.us_east_1

  name              = "aws-waf-logs-${local.resource_prefix}-cloudfront"
  retention_in_days = var.log_retention_days
}

resource "aws_wafv2_web_acl_logging_configuration" "cloudfront" {
  provider = aws.us_east_1

  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  resource_arn            = aws_wafv2_web_acl.cloudfront.arn

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Rend API and private playback"
  aliases             = [var.api_domain_name, var.playback_domain_name]
  http_version        = "http2and3"
  price_class         = var.cloudfront_price_class
  retain_on_delete    = true
  wait_for_deployment = true
  web_acl_id          = aws_wafv2_web_acl.cloudfront.arn

  origin {
    domain_name = var.internal_domain_name
    origin_id   = "rend-vpc-origin"

    vpc_origin_config {
      vpc_origin_id            = aws_cloudfront_vpc_origin.origin.id
      origin_keepalive_timeout = 60
      origin_read_timeout      = 60
    }
  }

  default_cache_behavior {
    target_origin_id           = "rend-vpc-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.public.id
  }

  ordered_cache_behavior {
    path_pattern               = "/v/*"
    target_origin_id           = "rend-vpc-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.playback.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.playback.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.public.id
    trusted_key_groups         = [aws_cloudfront_key_group.playback.id]
  }

  ordered_cache_behavior {
    path_pattern               = "/embed-fast/*"
    target_origin_id           = "rend-vpc-origin"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.public.id
  }

  logging_config {
    bucket          = aws_s3_bucket.cloudfront_logs.bucket_domain_name
    include_cookies = false
    prefix          = "cloudfront/"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
      locations        = []
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.public.certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  depends_on = [
    aws_s3_bucket_acl.cloudfront_logs,
    aws_s3_bucket_policy.cloudfront_logs,
    terraform_data.cloudfront_flat_rate_plan_guard,
  ]
}

resource "aws_route53_record" "public_ipv4" {
  for_each = var.services_enabled ? {
    api = {
      name    = var.api_domain_name
      zone_id = var.api_route53_zone_id
    }
    playback = {
      name    = var.playback_domain_name
      zone_id = var.playback_route53_zone_id
    }
  } : {}

  zone_id = each.value.zone_id
  name    = each.value.name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "public_ipv6" {
  for_each = var.services_enabled ? {
    api = {
      name    = var.api_domain_name
      zone_id = var.api_route53_zone_id
    }
    playback = {
      name    = var.playback_domain_name
      zone_id = var.playback_route53_zone_id
    }
  } : {}

  zone_id = each.value.zone_id
  name    = each.value.name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_zone" "internal" {
  name = var.internal_domain_name

  vpc {
    vpc_id = aws_vpc.this.id
  }

  comment = "Private DNS for Rend ECS-to-ALB control traffic"
}

resource "aws_route53_record" "internal" {
  zone_id = aws_route53_zone.internal.zone_id
  name    = var.internal_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.origin.dns_name
    zone_id                = aws_lb.origin.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "internal_public_origin" {
  zone_id = var.api_route53_zone_id
  name    = var.internal_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.origin.dns_name
    zone_id                = aws_lb.origin.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "clickhouse_internal" {
  zone_id = aws_route53_zone.internal.zone_id
  name    = local.clickhouse_internal_domain
  type    = "A"

  alias {
    name                   = aws_lb.origin.dns_name
    zone_id                = aws_lb.origin.zone_id
    evaluate_target_health = true
  }
}
