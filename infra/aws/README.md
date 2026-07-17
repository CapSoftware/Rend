# Rend AWS infrastructure

This directory is the source of truth for the Rend namespace in AWS account
`211125561119`. It deliberately refuses to plan or apply in any other account.
Because the account is shared, the GitHub deploy role cannot create or mutate
IAM roles, launch EC2 instances, or create general infrastructure. It can pass
only the two fixed production ECS task roles and can mutate only Rend-named
resources, the two delegated Rend zones, Rend ECR repositories, Rend state, and
explicitly enrolled Rend autoscaling targets. Initial infrastructure changes
must be applied with a human administrator after reviewing the exact Terraform
plan; routine image and ECS releases use the scoped role.

The hosted topology is intentionally small:

```text
viewer/browser
      |
CloudFront + WAF (api.rend.so and video.rend.so)
      |
CloudFront VPC Origin (HTTPS)
      |
internal ALB (HTTPS)
  |          |
TLS proxy  TLS proxy
  |          |
ECS API    ECS edge
              |
       private Tigris media

browser -- multipart PUT --> private Tigris source
                              |
                    ECS Fargate workers

API / worker / edge --> PlanetScale PostgreSQL over TLS
API / edge          --> internal ALB HTTPS --> ClickHouse m7g.large
```

There is no NAT gateway. Fargate tasks and the SSM-managed ClickHouse instance
receive public egress addresses in tightly restricted security groups; the ALB
is internal and CloudFront is the only public ingress. CloudFront-to-ALB and
ALB-to-task traffic are HTTPS. Each API/edge task binds the application only to
loopback and exposes a small self-signed TLS proxy on port 8443; ALB does not
validate target certificates. ECS control and ClickHouse HTTP traffic use the
internal ALB's validated TLS hostnames. The VPC has an S3 gateway endpoint for
AWS log and backup traffic.

## Boundaries

- Tigris source and media buckets remain external to AWS, but Terraform owns
  their creation and security contract. Its apply-time reconciler reads the
  credentials directly from SSM, then enforces private ACLs, deny-insecure
  policies, CORS, and one-day incomplete-multipart lifecycle rules. Credential
  values never enter Terraform variables, plans, state, arguments, or logs.
- PlanetScale must be PostgreSQL because Rend uses PostgreSQL-specific SQL. Put
  its TLS connection URL in the referenced SSM SecureString parameter.
- Terraform creates the ECS, CloudFront, WAF, ALB, ECR, ClickHouse, monitoring,
  DNS, and backup resources.
- AWS Budgets sends alerts; it is not a hard spending stop. Upload quotas,
  multipart expiry, WAF limits, bucket lifecycle rules, and ECS maximum task
  counts are the actual financial guardrails.
- CloudFront verifies its standard signed cookies with a trusted key group on
  every `/v/*` request. Authorization cookie values are forwarded when needed
  but never included in the playback cache key, so authorized viewers share
  cached renditions safely without fragmenting the cache.

## Bootstrap

Run bootstrap once with an administrator identity in the target account:

```bash
cd infra/aws/bootstrap
terraform init
terraform plan -var='github_repository=your-owner/Rend' -out bootstrap.tfplan
terraform apply bootstrap.tfplan
```

Bootstrap creates a versioned, encrypted, non-public state bucket, immutable
ECR repositories, the delegated `api.rend.so` and `video.rend.so` Route53
zones, and one GitHub OIDC deploy role. The role trusts only the protected
`Production` GitHub environment. Pull requests never receive AWS account
credentials; production plans and applies run through the same scoped role.

Bootstrap prints the four authoritative nameservers for each public zone. At
the DNS provider currently authoritative for `rend.so`, add an `NS` record for
`api` using the API zone's four values and another `NS` record for `video` using
the playback zone's four values. Do not change the nameservers for the root
`rend.so` zone. This delegates only the two production service hostnames to AWS
and leaves the site and all other records untouched.

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
3. Generate the CloudFront RSA key pair. Put only the private PEM in its
   SecureString parameter and put the public PEM in the tfvars file.

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out cloudfront-private.pem
   openssl pkey -in cloudfront-private.pem -pubout -out cloudfront-public.pem
   ```

   Delete local plaintext copies after storing the secret and your encrypted
   recovery copy.
4. Activate the CloudFront Business flat-rate plan in account `211125561119`,
   then set `cloudfront_flat_rate_plan_verified = true`. VPC Origins require at
   least Business. Terraform blocks production while verification is false.
   For the first distribution only, set
   `cloudfront_flat_rate_plan_bootstrap = true` for one apply, subscribe the new
   distribution immediately in the CloudFront console, then set bootstrap back
   to false and verification to true. This escape hatch avoids an IaC/console
   creation deadlock and must never remain enabled.
5. Obtain the production PlanetScale PrivateLink endpoint service name, set it
   in tfvars, and ensure the TLS database URL uses PlanetScale's private DNS.
6. Add the two Route53 delegation record sets emitted by bootstrap at the
   current `rend.so` DNS provider, then confirm both delegated zones resolve to
   the Route53 nameservers before applying the platform.
7. Set a monitored operations email and confirm the SNS subscription; budget
   and health alarms cannot protect the account until confirmation succeeds.
8. In AWS Billing, activate the user-defined cost allocation tag
   `Application`, wait for activation, and set
   `rend_cost_allocation_tag_active = true`. The $400 budget filters on
   `Application=rend`; an account-wide budget is intentionally forbidden in
   this shared account.

The Business plan is $200/month with no traffic overage charges. The remaining
default cost envelope is guarded by a $400 monthly AWS alert budget, 50 videos
and 10 open uploads per organization, two active media jobs per organization,
and at most ten 4-vCPU/8-GiB workers. ClickHouse starts with 100 GiB encrypted
gp3.

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
platform with zero API, edge, or worker tasks and no public A/AAAA aliases. It
also creates three suspended zero-minimum autoscaling targets, but no scaling
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
`false`. For an emergency shutdown, suspend only the three
`service/rend-production/{api,edge,worker}` scalable targets with minimum
capacity zero, then set those three ECS services to desired count zero. Keep
the activation flag true. Restore the documented API 2, edge 2, and worker 1
minima before resuming traffic; never target a non-Rend cluster.

For each later release:

1. Build and push immutable ECR images and record their digests.
2. Plan/apply Terraform with those digest references. This registers new task
   definitions without moving running services.
3. Run `rend-api migrate` as a one-shot ECS task using the new API definition.
4. Apply the additive ClickHouse schema through the Rend-tag-scoped SSM command
   and require its exact S3 object ETag marker before promotion.
5. Confirm the legacy worker fleet remains absent.
6. Update API, edge, then worker ECS services to the new task revisions.
7. Wait for ECS steady state and run the AWS deployment verifier.
8. Roll back by restoring the previous service task-definition revisions. No
   infrastructure rollback is required for an application-only failure.

CloudFront VPC Origin creation can take about 15 minutes. ClickHouse bootstrap
status is available through SSM and `/var/log/rend-clickhouse-bootstrap.log`.

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
