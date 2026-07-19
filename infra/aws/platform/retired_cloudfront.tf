# The AWS CloudFront playback distribution was disabled during the direct
# Tigris cutover. AWS will not physically delete a distribution subscribed to
# a flat-rate plan until that plan's billing cycle ends, so keep the retired
# resources out of the active platform state in the meantime. These resources
# serve no traffic and must be deleted with scripts/cleanup-retired-cloudfront.sh
# once the CloudFront console reports that the plan cancellation is effective.

removed {
  from = aws_cloudfront_distribution.this

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_cloudfront_vpc_origin.origin

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_cloudfront_cache_policy.playback

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_cloudfront_origin_request_policy.playback

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_cloudfront_response_headers_policy.public

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_cloudfront_key_group.playback

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_cloudfront_public_key.playback

  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_wafv2_web_acl.cloudfront

  lifecycle {
    destroy = false
  }
}
