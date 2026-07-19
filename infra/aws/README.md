# Rend AWS infrastructure

This directory is the source of truth for the Rend namespace in AWS account
`211125561119`. It deliberately refuses to plan or apply in any other account.
Because the account is shared, the GitHub deploy role is limited to Rend-tagged
or Rend-named resources, exact task roles, Rend state, and explicitly enrolled
autoscaling targets. Administrator access is only a temporary bootstrap aid and
must be detached after a scoped plan/apply succeeds.

The hosted topology is intentionally small:

```text
viewer/browser
  |                         |
api.rend.so             video.rend.so
  |                         |
AWS WAF + public ALB    Tigris delivery network
  |                         |
TLS proxy               public v/* aliases only
  |                         |
ECS API                 private canonical media

browser -- multipart PUT --> private Tigris source
                              |
                    ECS Fargate workers

API / worker --> PlanetScale PostgreSQL over TLS
API          --> internal ALB HTTPS --> ClickHouse m7g.large
```

There is no NAT gateway. Fargate tasks and the SSM-managed ClickHouse instance
receive public egress addresses in tightly restricted security groups. The API
ALB is public and WAF protected; a separate internal ALB carries ECS control
and ClickHouse traffic. ALB-to-task traffic is HTTPS. Each API task binds the
application only to loopback and exposes a small self-signed TLS proxy on port
8443; ALB does not
validate target certificates. ECS control and ClickHouse HTTP traffic use the
internal ALB's validated TLS hostnames. The VPC has an S3 gateway endpoint for
AWS log and backup traffic.

## Boundaries

- Tigris source and media buckets remain external to AWS, but Terraform owns
  their creation and security contract. Its apply-time reconciler reads the
  credentials directly from SSM, then enforces a private source bucket, private
  canonical media, scoped public `v/*` playback aliases, and CORS. Tigris
  object endpoints accept HTTPS only. Rend's 24-hour upload-session sweeper aborts each
  abandoned multipart upload and releases its reservation. Credential values never enter Terraform
  variables, plans, state, arguments, or logs.
- PlanetScale must be PostgreSQL because Rend uses PostgreSQL-specific SQL. Put
  its TLS connection URL in the referenced SSM SecureString parameter.
- Terraform creates ECS, WAF, ALBs, ECR, ClickHouse, monitoring,
  DNS, and backup resources.
- AWS Budgets sends alerts; it is not a hard spending stop. Upload quotas,
  multipart expiry, WAF limits, private bucket controls, and ECS maximum task
  counts are the actual financial guardrails.
- Tigris serves immutable playback aliases directly. AWS and Vercel do not carry
  video bytes, and there is no second CDN or hosted edge service.

## Bootstrap

Run bootstrap once with an administrator identity in the target account:

```bash
cd infra/aws/bootstrap
terraform init
terraform plan -var='github_repository=your-owner/Rend' -out bootstrap.tfplan
terraform apply bootstrap.tfplan
```

Bootstrap creates a versioned, encrypted, non-public state bucket, immutable
ECR repositories, the delegated `api.rend.so` Route53 zone, a dormant legacy
playback zone retained for rollback, and one GitHub OIDC deploy role. The role trusts only the protected
`Production` GitHub environment. Pull requests never receive AWS account
credentials; production plans and applies run through the same scoped role.

Bootstrap prints the four authoritative nameservers for the API zone. At
the DNS provider currently authoritative for `rend.so`, add an `NS` record for
`api` using the API zone's four values. Configure `video` with the Tigris custom
domain CNAME. Do not change the nameservers for the root `rend.so` zone.

Bootstrap uses local state because it creates the remote-state bucket. Store
that one-time state securely after apply.

## Platform initialization

Copy the example outside the repository and replace every placeholder:

```bash
cp infra/aws/environments/production.tfvars.example /secure/path/production.tfvars
cd infra/aws/platform
terraform init \
  -backend-config='bucket=rend-terraform-state-211125561119' \
  -backend-config='key=production/platform.tfstate' \
  -backend-config='region=us-east-1' \
  -backend-config='use_lockfile=true'
terraform plan -var-file=/secure/path/production.tfvars -out=production.tfplan
```

Review the plan and account guard before applying. Never commit a real tfvars
file, plan file, state file, secret, or private key.

## External prerequisites

Before the first platform apply:

1. Reserve distinct globally unique names for the Tigris source and media
   buckets. Terraform creates them if absent and safely reconciles existing
   buckets with those names. The source bucket is global; generated media is
   pinned to `iad` beside the Fargate workers. Local applies require the pinned
   Tigris client used by CI: `npm install --global @tigrisdata/cli@3.4.3`.
2. Create the ten SSM SecureString parameters referenced by the tfvars file. Secret
   values are populated outside Terraform so they do not enter state.
3. Retain the legacy Tigris-compatible RSA key inputs until their existing SSM
   values are rotated out. Public alias playback does not use signed cookies.

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out cloudfront-private.pem
   openssl pkey -in cloudfront-private.pem -pubout -out cloudfront-public.pem
   ```

   Delete local plaintext copies after storing the secret and your encrypted
   recovery copy.
4. Rend controls exposure through API WAF rules, backend quotas, Tigris request
   pricing, and hard ECS autoscaling ceilings.
5. Obtain the production PlanetScale PrivateLink endpoint service name, set it
   in tfvars, and ensure the TLS database URL uses PlanetScale's private DNS.
6. Add the API Route53 delegation emitted by bootstrap and the Tigris playback
   CNAME at the current `rend.so` DNS provider.
7. Set a monitored operations email and confirm the SNS subscription; budget
   and health alarms cannot protect the account until confirmation succeeds.
8. In AWS Billing, activate the user-defined cost allocation tag
   `Application`, wait for activation, and set
   `rend_cost_allocation_tag_active = true`. The $400 budget filters on
   `Application=rend`; an account-wide budget is intentionally forbidden in
   this shared account.

The default cost envelope is guarded by a $400
monthly AWS alert budget, 50 videos and 10 open uploads per organization, two
active media jobs per organization, and at most fifty 4-vCPU/8-GiB workers.
Only one worker is kept warm; the fleet scales from queue demand. ClickHouse
starts with 100 GiB encrypted gp3.

ClickHouse has two independent nightly recovery layers: a native database
backup copied to a versioned KMS-encrypted S3 bucket at 02:15 UTC and an AWS
Backup EBS recovery point at 03:00 UTC. Run a restore into an isolated instance
quarterly and record row-count, timestamp-range, and representative-query
comparisons before deleting the drill environment.

## Release ordering

Terraform owns the task-definition shape but intentionally ignores the running
service's `task_definition` revision. This prevents an infrastructure apply
from deploying new application code before its migration gate.

The first deployment is deliberately two-phase. Keep `services_enabled=false`
and `worker_cutover_confirmed=false` for the bootstrap apply. This creates the
platform with zero API or worker tasks and no public API alias. It
also creates two suspended zero-minimum autoscaling targets, but no scaling
policies. Enroll only those exact target ARNs into the deploy role:

```bash
targets="$(terraform -chdir=infra/aws/platform output -json ecs_scalable_target_arns)"
terraform -chdir=infra/aws/bootstrap apply \
  -var='github_repository=your-owner/Rend' \
  -var="rend_scalable_target_arns=$targets"
```

The workflow runs the one-shot migration and writes the source revision to
`/rend/production/deployment-gates/migration-ready`. Drain and stop the Latitude worker, then
run a second workflow apply for that same revision with both flags true. Only
that activation apply creates the public aliases, starts the minimum service
counts, unsuspends the enrolled targets, and creates scaling policies. After
public verification, the workflow writes `activation-complete`; later releases
can register new task definitions before their migration because Terraform
does not move the running service revision during the infrastructure apply.

`services_enabled` is a one-way activation gate, not an on/off switch. Once
`activation-complete` exists, Terraform rejects attempts to set it back to
`false`. For an emergency shutdown, suspend only the two
`service/rend-production/{api,worker}` scalable targets with minimum
capacity zero, then set those two ECS services to desired count zero. Keep
the activation flag true. Restore the documented API 2 and worker 1
minima before resuming traffic; never target a non-Rend cluster.

For each later release:

1. Build and push immutable ECR images and record their digests.
2. Plan/apply Terraform with those digest references. This registers new task
   definitions without moving running services.
3. Run `rend-api migrate` as a one-shot ECS task using the new API definition.
4. Apply the additive ClickHouse schema through the Rend-tag-scoped SSM command
   and require its exact S3 object ETag marker before promotion.
5. Confirm the legacy worker fleet remains absent.
6. Update API, then worker ECS services to the new task revisions.
7. Wait for ECS steady state and run the AWS deployment verifier.
8. Roll back by restoring the previous service task-definition revisions. No
   infrastructure rollback is required for an application-only failure.

ClickHouse bootstrap status is available through SSM and
`/var/log/rend-clickhouse-bootstrap.log`.

## Checks

```bash
terraform -chdir=infra/aws/bootstrap fmt -check
terraform -chdir=infra/aws/platform fmt -check
terraform -chdir=infra/aws/bootstrap init -backend=false
terraform -chdir=infra/aws/bootstrap validate
terraform -chdir=infra/aws/platform init -backend=false
terraform -chdir=infra/aws/platform validate
shellcheck infra/aws/scripts/provision-tigris.sh
docker compose -f compose.yml -f compose.selfhost.yml config --quiet
```

Provider initialization downloads plugins locally but does not contact or
modify AWS. Planning and applying require the account guard to pass.
