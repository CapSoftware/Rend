ALTER TABLE rend.assets
  ADD COLUMN IF NOT EXISTS source_width integer,
  ADD COLUMN IF NOT EXISTS source_height integer,
  ADD COLUMN IF NOT EXISTS source_resolution_tier text,
  ADD COLUMN IF NOT EXISTS max_resolution_tier text;

ALTER TABLE rend.artifacts
  ADD COLUMN IF NOT EXISTS duration_ms bigint,
  ADD COLUMN IF NOT EXISTS resolution_tier text;

ALTER TABLE rend.billing_customers
  ADD COLUMN IF NOT EXISTS storage_usage_cursor_at timestamptz,
  ADD COLUMN IF NOT EXISTS storage_usage_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS storage_usage_error text;

ALTER TABLE rend.billing_usage_events
  ALTER COLUMN value TYPE double precision USING value::double precision;

ALTER TABLE rend.assets
  DROP CONSTRAINT IF EXISTS assets_source_resolution_tier_check,
  ADD CONSTRAINT assets_source_resolution_tier_check CHECK (
    source_resolution_tier IS NULL OR source_resolution_tier IN ('720p', '1080p', '2k', '4k')
  );

ALTER TABLE rend.assets
  DROP CONSTRAINT IF EXISTS assets_max_resolution_tier_check,
  ADD CONSTRAINT assets_max_resolution_tier_check CHECK (
    max_resolution_tier IS NULL OR max_resolution_tier IN ('720p', '1080p', '2k', '4k')
  );

ALTER TABLE rend.artifacts
  DROP CONSTRAINT IF EXISTS artifacts_resolution_tier_check,
  ADD CONSTRAINT artifacts_resolution_tier_check CHECK (
    resolution_tier IS NULL OR resolution_tier IN ('720p', '1080p', '2k', '4k')
  );

ALTER TABLE rend.artifacts
  DROP CONSTRAINT IF EXISTS artifacts_duration_ms_check,
  ADD CONSTRAINT artifacts_duration_ms_check CHECK (duration_ms IS NULL OR duration_ms >= 0);

ALTER TABLE rend.billing_customers
  DROP CONSTRAINT IF EXISTS billing_customers_storage_usage_error_check,
  ADD CONSTRAINT billing_customers_storage_usage_error_check CHECK (
    storage_usage_error IS NULL OR length(storage_usage_error) BETWEEN 1 AND 1000
  );

ALTER TABLE rend.billing_usage_events
  DROP CONSTRAINT IF EXISTS billing_usage_events_source_check,
  ADD CONSTRAINT billing_usage_events_source_check CHECK (
    source IN (
      'upload_gate',
      'upload_reservation',
      'upload_reconcile',
      'upload_refund',
      'asset_delete',
      'delivery_aggregation',
      'storage_aggregation',
      'local_stub'
    )
  );

CREATE INDEX IF NOT EXISTS assets_org_resolution_storage_idx
  ON rend.assets(organization_id, max_resolution_tier, created_at, deleted_at)
  WHERE duration_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS artifacts_asset_object_key_idx
  ON rend.artifacts(asset_id, object_key);
