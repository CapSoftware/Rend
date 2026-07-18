#!/usr/bin/env bash
set -euo pipefail

required_environment=(
  TIGRIS_ENDPOINT
  TIGRIS_REGION
  TIGRIS_SOURCE_BUCKET
  TIGRIS_MEDIA_BUCKET
  TIGRIS_SOURCE_LOCATION
  TIGRIS_MEDIA_LOCATION
  TIGRIS_ACCESS_KEY_PARAMETER_ARN
  TIGRIS_SECRET_KEY_PARAMETER_ARN
  TIGRIS_ALLOWED_ORIGINS_JSON
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing required environment variable: $name" >&2
    exit 1
  fi
done
for command_name in aws jq tigris; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command is unavailable: $command_name" >&2
    exit 1
  fi
done

umask 077
work_dir="$(mktemp -d)"
tigris_access_key=""
tigris_secret_key=""
cleanup() {
  tigris_access_key=""
  tigris_secret_key=""
  rm -rf "$work_dir"
}
trap cleanup EXIT

# Terraform's AWS identity reads these at apply time. Credential values never
# enter Terraform variables, plans, state, command arguments, or logs.
tigris_access_key="$(aws ssm get-parameter \
  --name "$TIGRIS_ACCESS_KEY_PARAMETER_ARN" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --no-cli-pager)"
tigris_secret_key="$(aws ssm get-parameter \
  --name "$TIGRIS_SECRET_KEY_PARAMETER_ARN" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --no-cli-pager)"
if [[ -z "$tigris_access_key" || -z "$tigris_secret_key" ]]; then
  echo "Tigris credentials resolved to an empty value" >&2
  exit 1
fi

tigris_s3api() {
  AWS_ACCESS_KEY_ID="$tigris_access_key" \
    AWS_SECRET_ACCESS_KEY="$tigris_secret_key" \
    AWS_DEFAULT_REGION="$TIGRIS_REGION" \
    AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "$TIGRIS_ENDPOINT" s3api "$@" --no-cli-pager
}

# Recent AWS CLI releases add optional S3 request checksums by default. Tigris
# accepts those writes but currently persists an empty CORS/lifecycle document.
# Restrict compatibility mode to the two affected configuration APIs; its
# bucket-policy API expects the normal AWS CLI headers.
tigris_s3api_bucket_config() {
  AWS_ACCESS_KEY_ID="$tigris_access_key" \
    AWS_SECRET_ACCESS_KEY="$tigris_secret_key" \
    AWS_DEFAULT_REGION="$TIGRIS_REGION" \
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "$TIGRIS_ENDPOINT" s3api "$@" --no-cli-pager
}

tigris_cli() {
  AWS_ACCESS_KEY_ID="$tigris_access_key" \
    AWS_SECRET_ACCESS_KEY="$tigris_secret_key" \
    AWS_ENDPOINT_URL_S3="$TIGRIS_ENDPOINT" \
    AWS_DEFAULT_REGION="$TIGRIS_REGION" \
    AWS_EC2_METADATA_DISABLED=true \
    tigris "$@"
}

jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and startswith("https://"))' \
  <<<"$TIGRIS_ALLOWED_ORIGINS_JSON" >/dev/null

jq -n --argjson origins "$TIGRIS_ALLOWED_ORIGINS_JSON" '{
  CORSRules: [{
    ID: "rend-direct-multipart-upload",
    AllowedOrigins: $origins,
    AllowedMethods: ["PUT", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 900
  }]
}' >"$work_dir/source-cors.json"

jq -n --argjson origins "$TIGRIS_ALLOWED_ORIGINS_JSON" '{
  CORSRules: [{
    ID: "rend-private-media",
    AllowedOrigins: $origins,
    AllowedMethods: ["GET", "HEAD"],
    AllowedHeaders: ["Range", "If-None-Match", "If-Modified-Since"],
    ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    MaxAgeSeconds: 900
  }]
}' >"$work_dir/media-cors.json"

ensure_bucket() {
  local bucket="$1"
  local location="$2"
  local cors_file="$3"
  local bucket_info
  local expected_location
  local actual_location
  local public_policy

  if ! tigris_cli buckets get "$bucket" --json --yes >/dev/null 2>&1; then
    tigris_cli buckets create "$bucket" \
      --access private \
      --locations "$location" \
      --json \
      --yes >/dev/null
  else
    tigris_cli buckets set "$bucket" \
      --access private \
      --locations "$location" \
      --allow-object-acl false \
      --disable-directory-listing true \
      --enable-additional-headers true \
      --json \
      --yes >/dev/null
  fi

  tigris_s3api put-bucket-acl --bucket "$bucket" --acl private >/dev/null
  tigris_s3api_bucket_config put-bucket-cors --bucket "$bucket" --cors-configuration "file://$cors_file" >/dev/null

  tigris_s3api_bucket_config get-bucket-cors --bucket "$bucket" >/dev/null

  public_policy="$(tigris_s3api get-bucket-policy-status \
    --bucket "$bucket" \
    --query 'PolicyStatus.IsPublic' \
    --output text)"
  if [[ "$public_policy" != "False" && "$public_policy" != "false" ]]; then
    echo "Tigris policy is public for bucket $bucket" >&2
    exit 1
  fi
  if tigris_s3api get-bucket-acl --bucket "$bucket" --output json \
    | jq -e '.Grants[]? | select((.Grantee.URI? // "") | test("/(AllUsers|AuthenticatedUsers)$"))' >/dev/null; then
    echo "Tigris ACL contains a public grant for bucket $bucket" >&2
    exit 1
  fi

  bucket_info="$(tigris_cli buckets get "$bucket" --json --yes)"
  expected_location="$location"
  if [[ "$location" == "global" ]]; then
    expected_location="Global"
  fi
  actual_location="$(jq -r '.[] | select(.property == "Locations") | .value' <<<"$bucket_info")"
  if [[ "$actual_location" != "$expected_location" ]]; then
    echo "Tigris location verification failed for bucket $bucket" >&2
    exit 1
  fi
}

ensure_bucket "$TIGRIS_SOURCE_BUCKET" "$TIGRIS_SOURCE_LOCATION" "$work_dir/source-cors.json"
ensure_bucket "$TIGRIS_MEDIA_BUCKET" "$TIGRIS_MEDIA_LOCATION" "$work_dir/media-cors.json"
echo "Tigris source and media bucket contracts are reconciled and private; Rend owns abandoned multipart expiry."
