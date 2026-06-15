CREATE TABLE IF NOT EXISTS rend.billing_storage_spans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES rend.assets(id) ON DELETE CASCADE,
  duration_ms bigint NOT NULL,
  resolution_tier text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_storage_spans_duration_check CHECK (duration_ms > 0),
  CONSTRAINT billing_storage_spans_resolution_tier_check CHECK (
    resolution_tier IN ('720p', '1080p', '2k', '4k')
  ),
  CONSTRAINT billing_storage_spans_interval_check CHECK (
    ended_at IS NULL OR ended_at >= started_at
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_storage_spans_asset_open_uidx
  ON rend.billing_storage_spans(asset_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS billing_storage_spans_org_window_idx
  ON rend.billing_storage_spans(organization_id, resolution_tier, started_at, ended_at);

DROP TRIGGER IF EXISTS set_updated_at ON rend.billing_storage_spans;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.billing_storage_spans
FOR EACH ROW
EXECUTE FUNCTION rend.set_updated_at();
