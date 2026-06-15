# Autumn Billing V1

Public V1 uses Autumn as the source of truth for plans, entitlements, balances,
and usage limits. Rend maps each organization to one Autumn customer using the
organization UUID as `customer_id`.

Autumn products, plan prices, credits, overages, and limits are configured
outside the Rend codebase. Rend only references feature IDs and records usage.
Public V1 customer-facing billing is based on video delivery seconds and video
storage second-months by resolution tier. Upload/source bytes are only local
safety and abuse limits.

## Required Model

- Customer ID: Rend `organization_id`.
- Customer creation: dashboard access, API-key creation, and upload guardrails
  call Autumn customer get-or-create paths.
- Checkout: dashboard plan actions call Autumn billing attach and redirect to
  the returned checkout/payment URL.
- Billing portal: dashboard manage actions call Autumn customer billing portal
  and redirect to the returned portal URL.

Relevant Autumn docs:

- Customer get-or-create: https://docs.useautumn.com/documentation/customers/creating-customers
- Balance checks and atomic event send: https://docs.useautumn.com/api-reference/core/check
- Usage tracking: https://docs.useautumn.com/api-reference/core/track
- Billing attach: https://docs.useautumn.com/api-reference/billing/attach
- Billing portal: https://docs.useautumn.com/api-reference/customers/open-billing-portal

## Env Vars

Local development defaults to the local stub:

```sh
REND_BILLING_MODE=local
AUTUMN_SECRET_KEY=
```

Production must use Autumn:

```sh
REND_BILLING_MODE=autumn
AUTUMN_SECRET_KEY=<server-only Autumn secret key>
AUTUMN_API_URL=https://api.useautumn.com/v1
AUTUMN_API_VERSION=2.3.0
```

Feature IDs are explicit and can be changed to match Autumn configuration:

```sh
REND_BILLING_FEATURE_DELIVERY_720P=delivery_720p_seconds
REND_BILLING_FEATURE_DELIVERY_1080P=delivery_1080p_seconds
REND_BILLING_FEATURE_DELIVERY_2K=delivery_2k_seconds
REND_BILLING_FEATURE_DELIVERY_4K=delivery_4k_seconds
REND_BILLING_FEATURE_STORAGE_720P=storage_720p_second_months
REND_BILLING_FEATURE_STORAGE_1080P=storage_1080p_second_months
REND_BILLING_FEATURE_STORAGE_2K=storage_2k_second_months
REND_BILLING_FEATURE_STORAGE_4K=storage_4k_second_months
REND_AUTUMN_USAGE_CREDIT_FEATURE_ID=rend_usage_credits
```

The Autumn dev/sandbox catalog should include:

- Pay as you go: card required, no included credits, metered overage billing.
- Builder: `$19/mo`, `$100` included usage credit.
- Scale: `$450/mo`, `$1,000` included usage credit.
- Enterprise: `$4,500/mo`, `$10,000` included usage credit.

Overages should be billed by Autumn/Stripe. Rend does not hardcode plan prices
except display fallback copy.

The public V1 production plan IDs must be:

```sh
REND_AUTUMN_PLAN_PAYG_ID=pay_as_you_go
REND_AUTUMN_PLAN_BUILDER_ID=builder
REND_AUTUMN_PLAN_SCALE_ID=scale
REND_AUTUMN_PLAN_ENTERPRISE_ID=enterprise
```

`rend_usage_credits` is the Autumn credit-system feature attached to those
plans. It is not a Stripe object managed by Rend.

## Sandbox and Live Separation

Sandbox and production Autumn keys must never be loaded into the same runtime as
the active `AUTUMN_SECRET_KEY`. The production launch gate requires the live
Autumn key to come from `.env.production.local`, and the key must be visibly
marked as live. The sandbox parity input should be a separate env file, usually
`.env.local`, containing a visibly marked test/sandbox Autumn key.

Read-only parity check:

```sh
bun run billing:autumn-parity -- \
  --sandbox-env-file .env.local \
  --production-env-file .env.production.local
```

This fetches only the required Autumn features and plans, compares production to
sandbox, verifies the credit-system schema and plan attachments, and writes a
redacted artifact under `.rend/launch/`. It does not copy customers,
subscriptions, or Stripe objects.

If production parity fails because live Autumn catalog objects are missing,
upsert the catalog through Autumn with the explicit mutation flag:

```sh
node scripts/with-root-env.mjs --profile production --env-file .env.production.local \
  node scripts/setup-autumn-billing.mjs --plans --mux-basic-rates --allow-production-mutation
```

This command may create or update Autumn products/plans and the Stripe live
objects Autumn manages for them. It must not be replaced with manual Stripe
product or price creation.

The controlled dry run can use an explicit internal plan that is managed by
Autumn and does not create a structural Stripe product/price:

```sh
node scripts/with-root-env.mjs --profile production --env-file .env.production.local \
  node scripts/setup-autumn-billing.mjs \
    --internal-dry-run-plan \
    --mux-basic-rates \
    --allow-production-mutation
```

Use the setup helper to upsert the required feature IDs:

```sh
bun run billing:setup-autumn -- --features-only
```

Plan setup needs explicit unit economics. Do not create plans with guessed
prices. Set every unit-cost variable below to the dollar-credit cost per tracked
unit, then run `--plans`. The usage credit system uses one credit as one dollar;
the per-feature credit costs are what convert delivered seconds and storage
second-months into usage-credit drawdown and overage invoices.

```sh
REND_AUTUMN_UNIT_COST_DELIVERY_720P=<dollars per delivered second>
REND_AUTUMN_UNIT_COST_DELIVERY_1080P=<dollars per delivered second>
REND_AUTUMN_UNIT_COST_DELIVERY_2K=<dollars per delivered second>
REND_AUTUMN_UNIT_COST_DELIVERY_4K=<dollars per delivered second>
REND_AUTUMN_UNIT_COST_STORAGE_720P=<dollars per second-month>
REND_AUTUMN_UNIT_COST_STORAGE_1080P=<dollars per second-month>
REND_AUTUMN_UNIT_COST_STORAGE_2K=<dollars per second-month>
REND_AUTUMN_UNIT_COST_STORAGE_4K=<dollars per second-month>

bun run billing:setup-autumn -- --plans
```

For a Mux-compatible sandbox baseline, the helper can populate those unit costs
from Mux Basic public rates: delivery `$0.0008/$0.001/$0.0016/$0.0032` per
delivered minute for 720p/1080p/2K/4K and storage
`$0.0024/$0.003/$0.0048/$0.0096` per stored minute-month for the same tiers.
The script converts them to Rend's second-based units:

```sh
bun run billing:setup-autumn -- --plans --mux-basic-rates
```

The helper creates/updates the eight meter features, a `rend_usage_credits`
credit system, and the four V1 plans. It can also verify customer mapping,
plan attach checkout, and billing portal URL creation without printing secrets:

```sh
REND_AUTUMN_VERIFY_CUSTOMER_ID=<rend organization_id> \
REND_AUTUMN_VERIFY_PLAN_ID=pay_as_you_go \
bun run billing:setup-autumn -- --features-only --verify-customer --verify-attach --verify-portal
```

## Enforcement

Uploads are gated server-side before source bytes are accepted. The gate creates
or syncs the Autumn customer and performs a zero-usage Autumn balance check
against the 720p storage feature. This verifies the customer billing state
without recording upload bytes as billable usage.

The API returns `403` with `{ "error": "limit_exceeded" }` when Autumn denies a
required balance. Clients should treat this as a plan or usage state.

Rend uses Autumn check/track patterns only for billable usage and entitlement
gates. If a track call fails after local idempotency insertion, the event remains
failed and can be retried by re-running the bounded sync window.

Delivery usage is tracked asynchronously from bounded ClickHouse aggregation.
Telemetry ingestion enriches playback events with stored artifact duration and
asset/rendition resolution tier, then delivery sync tracks delivered seconds to
the matching 720p/1080p/2K/4K Autumn feature. Playback bootstrap and edge
playback do not call Autumn, Postgres, or the API on the already-issued playback
URL hot path.

Storage usage is tracked asynchronously from Postgres asset metadata. Rend
records ffprobe duration, source dimensions, source tier, max asset tier, and
artifact durations during media processing. Storage sync prorates active asset
duration over the bounded window as second-month usage. A 60-second video stored
for one 30-day month records 60 second-months; the same video stored for one day
records 2 second-months.

## Failure Policy

Dashboard billing display fails soft and can show the last cached billing state.

Upload entitlement checks fail closed by default:

```sh
REND_BILLING_ENTITLEMENT_FAILURE_POLICY=fail_closed
```

`fail_open` exists only as an explicit operational escape hatch. It allows
uploads through provider availability failures, but explicit Autumn denials still
return `limit_exceeded`.

## Delivery Sync

Delivery and storage aggregation are throttled and lagged to avoid racing
telemetry ingest or media processing:

```sh
REND_BILLING_DELIVERY_SYNC_LAG_SECS=60
REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS=3600
REND_BILLING_STORAGE_SYNC_LAG_SECS=60
REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS=3600
```

Operators can trigger a bounded billing sync through the internal operator API:

```sh
POST /internal/operator/billing/delivery-sync
```

Use the dashboard operator billing panel to inspect customer sync status and
manually resync an organization. Operators must not mutate plan state directly
in Rend; plan/product changes should go through Autumn.

## Production Dry Run

Run the production dry run only after parity and the production launch gate pass:

```sh
bun run launch:gate -- --mode production-check --autumn-sandbox-env-file .env.local

bun run launch:production-dry-run -- \
  --allow-production-mutation \
  --acknowledge-real-charge \
  --plan-id internal_production_dry_run
```

Before running it, deploy or restart the production API on the current build and
confirm migrations through `0011_billing_storage_spans.sql` are applied. The dry
run intentionally fails if upload does not create the `upload_gate` billing
event or if storage/delivery usage does not track through Autumn.

`--acknowledge-real-charge` is required for every production dry run because
tracked usage can create live Autumn/Stripe billing artifacts even on
`pay_as_you_go`. For `internal_production_dry_run`, the expected charge is `$0`;
it exists to verify production Autumn checks/tracks without requiring a completed
public checkout first. Document the intended plan and expected charge before
running it. The dry run creates or syncs the internal customer
`Rend Internal Production Dry Run`, attaches the requested Autumn plan, creates a
scoped live API key, uploads a synthetic fixture through the public API, waits
for playable media, verifies upload check plus delivery/storage usage tracking,
verifies checkout/portal URL creation, verifies public embed/watch playback
through the edge, deletes the asset, revokes the generated API key, and writes a
redacted artifact under `.rend/launch/`.

The dry run intentionally leaves the Autumn customer, plan relationship,
balances, usage, and Autumn-generated Stripe objects visible for dashboard
inspection. It must not be used to create structural Stripe products or prices
outside Autumn.
