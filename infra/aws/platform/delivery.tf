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


resource "aws_route53_record" "public_ipv4" {
  for_each = var.services_enabled ? {
    api = {
      name    = var.api_domain_name
      zone_id = var.api_route53_zone_id
    }
  } : {}

  zone_id = each.value.zone_id
  name    = each.value.name
  type    = "A"

  alias {
    name                   = aws_lb.public_api.dns_name
    zone_id                = aws_lb.public_api.zone_id
    evaluate_target_health = true
  }

  depends_on = [
    aws_ecs_service.api,
    aws_wafv2_web_acl_association.public_api,
  ]
}

resource "aws_wafv2_web_acl" "public_api" {
  name  = "${local.resource_prefix}-public-api"
  scope = "REGIONAL"

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
      or_statement {
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
        statement {
          byte_match_statement {
            positional_constraint = "EXACTLY"
            search_string         = "/metrics"
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
      metric_name                = "BlockInternalRoutes"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitByIP"
    priority = 10
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitByIP"
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
    metric_name                = "${local.resource_prefix}-public-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "public_api" {
  resource_arn = aws_lb.public_api.arn
  web_acl_arn  = aws_wafv2_web_acl.public_api.arn
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
