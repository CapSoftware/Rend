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
  TIGRIS_PLAYBACK_DOMAIN
  TIGRIS_PLAYBACK_PUBLIC_KEY_PEM_B64
  TIGRIS_PLAYBACK_KEY_ID_PARAMETER
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
  env -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
    AWS_ACCESS_KEY_ID="$tigris_access_key" \
    AWS_SECRET_ACCESS_KEY="$tigris_secret_key" \
    AWS_DEFAULT_REGION="$TIGRIS_REGION" \
    AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "$TIGRIS_ENDPOINT" s3api "$@" --no-cli-pager
}

# Recent AWS CLI releases add optional S3 request checksums by default. Tigris
# does not consistently implement those headers for bucket configuration APIs.
# Keep compatibility mode scoped to bucket configuration; object data keeps
# the SDK's normal integrity checks.
tigris_s3api_bucket_config() {
  env -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
    AWS_ACCESS_KEY_ID="$tigris_access_key" \
    AWS_SECRET_ACCESS_KEY="$tigris_secret_key" \
    AWS_DEFAULT_REGION="$TIGRIS_REGION" \
    AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "$TIGRIS_ENDPOINT" s3api "$@" --no-cli-pager
}

tigris_cli() {
  env -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
    AWS_ACCESS_KEY_ID="$tigris_access_key" \
    AWS_SECRET_ACCESS_KEY="$tigris_secret_key" \
    AWS_ENDPOINT_URL_S3="$TIGRIS_ENDPOINT" \
    AWS_DEFAULT_REGION="$TIGRIS_REGION" \
    AWS_EC2_METADATA_DISABLED=true \
    tigris "$@"
}

tigris_cloudfront() {
  env -u AWS_SESSION_TOKEN -u AWS_SECURITY_TOKEN -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
    AWS_ACCESS_KEY_ID="$tigris_access_key" \
    AWS_SECRET_ACCESS_KEY="$tigris_secret_key" \
    AWS_DEFAULT_REGION=us-east-1 \
    AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url https://t3.storage.dev cloudfront "$@" --no-cli-pager
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

playback_public_key_pem="$(printf '%s' "$TIGRIS_PLAYBACK_PUBLIC_KEY_PEM_B64" | base64 --decode)"
if [[ "$playback_public_key_pem" != "-----BEGIN PUBLIC KEY-----"* ]]; then
  echo "Tigris playback public key is not a PEM public key" >&2
  exit 1
fi
playback_key_name="rend-production-private-playback"
playback_key_id="$(tigris_cloudfront list-public-keys --output json \
  | jq -r --arg name "$playback_key_name" '.PublicKeyList.Items[]? | select(.Name == $name) | .Id' \
  | head -n 1)"
jq -n \
  --arg caller_reference "rend-production-private-playback-v1" \
  --arg name "$playback_key_name" \
  --arg encoded_key "$playback_public_key_pem" \
  --arg comment "Rend private Tigris playback signed cookies" \
  '{CallerReference:$caller_reference,Name:$name,EncodedKey:$encoded_key,Comment:$comment}' \
  >"$work_dir/public-key-create.json"

if [[ -z "$playback_key_id" ]]; then
  playback_key_id="$(tigris_cloudfront create-public-key \
    --public-key-config "file://$work_dir/public-key-create.json" \
    --query 'PublicKey.Id' \
    --output text)"
else
  current_key="$(tigris_cloudfront get-public-key \
    --id "$playback_key_id" \
    --output json)"
  current_encoded_key="$(jq -r '.PublicKey.PublicKeyConfig.EncodedKey' <<<"$current_key")"
  if [[ "$current_encoded_key" != "$playback_public_key_pem" ]]; then
    echo "Tigris private playback public key does not match the configured Rend key" >&2
    exit 1
  fi
fi
if [[ -z "$playback_key_id" || "$playback_key_id" == "None" ]]; then
  echo "Tigris did not return a private playback public key ID" >&2
  exit 1
fi

tigris_cli buckets set "$TIGRIS_MEDIA_BUCKET" \
  --custom-domain "$TIGRIS_PLAYBACK_DOMAIN" \
  --json \
  --yes >/dev/null

aws ssm put-parameter \
  --name "$TIGRIS_PLAYBACK_KEY_ID_PARAMETER" \
  --type String \
  --value "$playback_key_id" \
  --overwrite \
  --no-cli-pager >/dev/null

echo "Tigris private source/media buckets, signed playback key, and custom playback domain are reconciled."
