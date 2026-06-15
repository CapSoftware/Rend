CREATE TABLE IF NOT EXISTS rend.billing_customers (
  organization_id uuid PRIMARY KEY REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  autumn_customer_id text NOT NULL,
  billing_mode text NOT NULL DEFAULT 'local',
  customer_synced_at timestamptz,
  customer_sync_error text,
  billing_state jsonb,
  billing_state_synced_at timestamptz,
  billing_state_error text,
  delivery_usage_cursor_at timestamptz,
  delivery_usage_synced_at timestamptz,
  delivery_usage_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_customers_mode_check CHECK (billing_mode IN ('local', 'autumn')),
  CONSTRAINT billing_customers_customer_sync_error_check CHECK (
    customer_sync_error IS NULL OR length(customer_sync_error) BETWEEN 1 AND 1000
  ),
  CONSTRAINT billing_customers_billing_state_error_check CHECK (
    billing_state_error IS NULL OR length(billing_state_error) BETWEEN 1 AND 1000
  ),
  CONSTRAINT billing_customers_delivery_usage_error_check CHECK (
    delivery_usage_error IS NULL OR length(delivery_usage_error) BETWEEN 1 AND 1000
  )
);

CREATE INDEX IF NOT EXISTS billing_customers_mode_synced_idx
  ON rend.billing_customers(billing_mode, customer_synced_at);

CREATE TABLE IF NOT EXISTS rend.billing_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES rend.assets(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  feature_id text NOT NULL,
  value bigint NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  tracked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_usage_events_idempotency_key_uidx UNIQUE (idempotency_key),
  CONSTRAINT billing_usage_events_status_check CHECK (status IN ('pending', 'tracked', 'failed', 'skipped')),
  CONSTRAINT billing_usage_events_source_check CHECK (
    source IN ('upload_reservation', 'upload_reconcile', 'upload_refund', 'asset_delete', 'delivery_aggregation', 'local_stub')
  ),
  CONSTRAINT billing_usage_events_feature_id_check CHECK (
    feature_id !~ '[\r\n]' AND length(feature_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT billing_usage_events_idempotency_key_check CHECK (
    idempotency_key !~ '[\r\n]' AND length(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT billing_usage_events_error_check CHECK (
    error IS NULL OR length(error) BETWEEN 1 AND 1000
  )
);

CREATE INDEX IF NOT EXISTS billing_usage_events_org_created_idx
  ON rend.billing_usage_events(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS billing_usage_events_status_created_idx
  ON rend.billing_usage_events(status, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON rend.billing_customers;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.billing_customers
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend.billing_usage_events;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.billing_usage_events
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();
