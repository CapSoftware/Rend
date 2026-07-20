# Autumn Billing

Hosted Rend has one pay-as-you-go plan and two customer-facing meters.

| Meter | Price | What counts |
| --- | ---: | --- |
| Delivery | $0.001 per minute | Time viewers actually watch |
| Storage | $0.003 per minute per month | Video duration, prorated for time stored |

Encoding is included. The same rates apply to every resolution. There is no base
fee or separate egress line item.

Rend measures precise seconds internally so short playback and partial months are
not rounded per event. Autumn prices each 60 tracked delivery seconds as one
delivered minute, and each 60 tracked storage second-months as one stored
minute-month.

## Autumn model

Rend maps each organization UUID to the same Autumn `customer_id`.

The required production and sandbox catalog is:

- metered feature `delivery_seconds`
- metered feature `storage_second_months`
- plan `pay_as_you_go`, containing both features as usage-based prices
- delivery price: `$0.001` per `60` tracked units
- storage price: `$0.003` per `60` tracked units

Relevant Autumn docs:

- [Usage tracking](https://docs.useautumn.com/documentation/customers/tracking-usage)
- [Per-unit pricing](https://docs.useautumn.com/documentation/modelling-pricing/per-unit-pricing)
- [Attach a plan](https://docs.useautumn.com/api-reference/billing/attach)
- [Open the billing portal](https://docs.useautumn.com/api-reference/customers/open-billing-portal)

## Environment

Local development can use the local billing stub:

```sh
REND_BILLING_MODE=local
AUTUMN_SECRET_KEY=
REND_BILLING_FEATURE_DELIVERY=delivery_seconds
REND_BILLING_FEATURE_STORAGE=storage_second_months
```

Hosted environments use Autumn:

```sh
REND_BILLING_MODE=autumn
AUTUMN_SECRET_KEY=<server-only Autumn secret key>
AUTUMN_API_URL=https://api.useautumn.com/v1
AUTUMN_API_VERSION=2.3.0
REND_BILLING_FEATURE_DELIVERY=delivery_seconds
REND_BILLING_FEATURE_STORAGE=storage_second_months
REND_AUTUMN_PLAN_PAYG_ID=pay_as_you_go
```

The setup helper owns the catalog definition:

```sh
bun run billing:setup-autumn -- --plans --mux-basic-rates
```

The rate variables can be overridden explicitly:

```sh
REND_AUTUMN_PRICE_DELIVERY_PER_MINUTE=0.001
REND_AUTUMN_PRICE_STORAGE_PER_MINUTE_MONTH=0.003
```

A live key requires an explicit acknowledgement:

```sh
node scripts/with-root-env.mjs --profile production --env-file .env.production.local \
  node scripts/setup-autumn-billing.mjs \
    --plans \
    --mux-basic-rates \
    --allow-production-mutation
```

## Catalog parity

Sandbox and production keys must live in separate env files. Compare the exact
two features and the pay-as-you-go plan without mutating either environment:

```sh
bun run billing:autumn-parity -- \
  --sandbox-env-file .env.local \
  --production-env-file .env.production.local
```

The parity command writes a redacted result under `.rend/launch/`.

## Enforcement and usage sync

Uploads are checked before source bytes are accepted. The check creates or syncs
the Autumn customer and verifies access to `storage_second_months` without
recording upload bytes as billable usage. An Autumn denial returns
`403 {"error":"limit_exceeded"}`.

Delivery usage is aggregated asynchronously from ClickHouse playback telemetry.
Rend retains resolution information for analytics, but every row is tracked into
the single `delivery_seconds` meter. Playback URLs do not call Autumn on the hot
path.

Storage usage is aggregated asynchronously from Postgres asset spans. A
60-minute video stored for a full 30-day month records 60 stored minute-months.
The same video stored for half that month records 30.

Synchronization is bounded and lagged:

```sh
REND_BILLING_DELIVERY_SYNC_LAG_SECS=60
REND_BILLING_DELIVERY_SYNC_MAX_WINDOW_SECS=3600
REND_BILLING_STORAGE_SYNC_LAG_SECS=60
REND_BILLING_STORAGE_SYNC_MAX_WINDOW_SECS=3600
```

Operators can trigger delivery and storage synchronization from the operator
billing panel. Plan and price changes go through the setup helper and Autumn.

## Failure policy

Dashboard billing display fails soft and may show the last cached state. Upload
checks fail closed by default:

```sh
REND_BILLING_ENTITLEMENT_FAILURE_POLICY=fail_closed
```

`fail_open` is an operational escape hatch for provider availability failures.
Explicit Autumn denials still return `limit_exceeded`.

## Verification

Use a sandbox key first:

```sh
REND_AUTUMN_VERIFY_CUSTOMER_ID=<disposable organization UUID> \
REND_AUTUMN_VERIFY_PLAN_ID=pay_as_you_go \
bun run billing:setup-autumn -- \
  --plans \
  --mux-basic-rates \
  --verify-customer \
  --verify-attach
```

`--verify-portal` is available for an existing customer that has completed a
real Stripe checkout. The no-billing-change verification attach above does not
create a Stripe customer or payment method.

Run the production dry run only after catalog parity, deployment of the matching
API build, and the production launch gate:

```sh
bun run launch:gate -- --mode production-check --autumn-sandbox-env-file .env.local

bun run launch:production-dry-run -- \
  --allow-production-mutation \
  --acknowledge-real-charge
```

The dry run creates a scoped test organization and API key, uploads a synthetic
fixture, verifies upload gating plus both usage meters, checks playback, deletes
the asset, revokes the API key, and writes a redacted artifact under
`.rend/launch/`.
