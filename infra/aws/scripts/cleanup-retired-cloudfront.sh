#!/usr/bin/env bash
set -euo pipefail

expected_account_id="${REND_AWS_ACCOUNT_ID:-211125561119}"
distribution_id="${REND_RETIRED_CLOUDFRONT_DISTRIBUTION_ID:-E3KM9SDZISGFJS}"

if [[ "${1:-}" != "--confirm" ]]; then
  echo "usage: $0 --confirm" >&2
  echo "Run only after the CloudFront console says the flat-rate plan cancellation is effective." >&2
  exit 2
fi

for command_name in aws jq; do
  command -v "$command_name" >/dev/null || {
    echo "$command_name is required" >&2
    exit 1
  }
done

account_id="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$account_id" != "$expected_account_id" ]]; then
  echo "refusing to modify AWS account $account_id; expected $expected_account_id" >&2
  exit 1
fi

if distribution_json="$(aws cloudfront get-distribution --id "$distribution_id" --output json 2>/dev/null)"; then
  if [[ "$(jq -r '.Distribution.DistributionConfig.Enabled' <<<"$distribution_json")" != "false" ]]; then
    echo "refusing to delete enabled CloudFront distribution $distribution_id" >&2
    exit 1
  fi
  if [[ "$(jq -r '.Distribution.Status' <<<"$distribution_json")" != "Deployed" ]]; then
    echo "distribution $distribution_id must be Deployed before deletion" >&2
    exit 1
  fi

  distribution_etag="$(jq -r '.ETag' <<<"$distribution_json")"
  aws cloudfront delete-distribution --id "$distribution_id" --if-match "$distribution_etag"
else
  distributions_json="$(aws cloudfront list-distributions --output json)"
  if jq -e --arg id "$distribution_id" \
    'any((.DistributionList.Items // [])[]; .Id == $id)' \
    <<<"$distributions_json" >/dev/null; then
    echo "distribution $distribution_id still exists but could not be read" >&2
    exit 1
  fi
fi

delete_named_cloudfront_resource() {
  local list_command="$1"
  local list_filter="$2"
  local get_command="$3"
  local delete_command="$4"
  local name="$5"
  local id
  local etag

  id="$(aws cloudfront "$list_command" --output json | jq -r --arg name "$name" "$list_filter | select(.Name == \$name) | .Id" | head -n 1)"
  [[ -n "$id" ]] || return 0
  etag="$(aws cloudfront "$get_command" --id "$id" --output json | jq -r '.ETag')"
  aws cloudfront "$delete_command" --id "$id" --if-match "$etag"
}

delete_named_cloudfront_resource \
  list-key-groups '(.KeyGroupList.Items // [])[]' \
  get-key-group delete-key-group rend-production-playback
delete_named_cloudfront_resource \
  list-public-keys '(.PublicKeyList.Items // [])[]' \
  get-public-key delete-public-key rend-production-playback
delete_named_cloudfront_resource \
  list-cache-policies '(.CachePolicyList.Items // [])[].CachePolicy' \
  get-cache-policy delete-cache-policy rend-production-private-playback
delete_named_cloudfront_resource \
  list-origin-request-policies '(.OriginRequestPolicyList.Items // [])[].OriginRequestPolicy' \
  get-origin-request-policy delete-origin-request-policy rend-production-private-playback-origin
delete_named_cloudfront_resource \
  list-response-headers-policies '(.ResponseHeadersPolicyList.Items // [])[].ResponseHeadersPolicy' \
  get-response-headers-policy delete-response-headers-policy rend-production-public-playback

vpc_origin_id="$(aws cloudfront list-vpc-origins --output json | jq -r '(.VpcOriginList.Items // [])[] | select(.Name == "rend-production-origin") | .Id' | head -n 1)"
if [[ -n "$vpc_origin_id" ]]; then
  vpc_origin_etag="$(aws cloudfront get-vpc-origin --id "$vpc_origin_id" --output json | jq -r '.ETag')"
  aws cloudfront delete-vpc-origin --id "$vpc_origin_id" --if-match "$vpc_origin_etag"
fi

web_acl_id="$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --output json \
  | jq -r '(.WebACLs // [])[] | select(.Name == "rend-production-cloudfront") | .Id' | head -n 1)"
if [[ -n "$web_acl_id" ]]; then
  lock_token="$(aws wafv2 get-web-acl \
    --name rend-production-cloudfront \
    --scope CLOUDFRONT \
    --id "$web_acl_id" \
    --region us-east-1 \
    --output json | jq -r '.LockToken')"
  aws wafv2 delete-web-acl \
    --name rend-production-cloudfront \
    --scope CLOUDFRONT \
    --id "$web_acl_id" \
    --lock-token "$lock_token" \
    --region us-east-1
fi

echo "Retired CloudFront resources removed from AWS account $account_id."
