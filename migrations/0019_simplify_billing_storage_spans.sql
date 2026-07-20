DROP INDEX IF EXISTS rend.billing_storage_spans_org_window_idx;

ALTER TABLE rend.billing_storage_spans
  DROP CONSTRAINT IF EXISTS billing_storage_spans_resolution_tier_check,
  DROP COLUMN IF EXISTS resolution_tier;

CREATE INDEX IF NOT EXISTS billing_storage_spans_org_window_idx
  ON rend.billing_storage_spans(organization_id, started_at, ended_at);
