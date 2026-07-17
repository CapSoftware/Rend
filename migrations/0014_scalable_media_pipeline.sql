ALTER TABLE rend.media_jobs
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reserved_microusd bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_microusd bigint,
  ADD COLUMN IF NOT EXISTS reserved_output_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_bytes bigint NOT NULL DEFAULT 0;

ALTER TABLE rend.media_jobs
  DROP CONSTRAINT IF EXISTS media_jobs_status_check,
  ADD CONSTRAINT media_jobs_status_check CHECK (
    status IN ('queued', 'running', 'deferred_budget', 'succeeded', 'failed', 'cancelled')
  ),
  DROP CONSTRAINT IF EXISTS media_jobs_reserved_microusd_check,
  ADD CONSTRAINT media_jobs_reserved_microusd_check CHECK (reserved_microusd >= 0),
  DROP CONSTRAINT IF EXISTS media_jobs_actual_microusd_check,
  ADD CONSTRAINT media_jobs_actual_microusd_check CHECK (
    actual_microusd IS NULL OR actual_microusd >= 0
  ),
  DROP CONSTRAINT IF EXISTS media_jobs_output_bytes_check,
  ADD CONSTRAINT media_jobs_output_bytes_check CHECK (output_bytes >= 0),
  DROP CONSTRAINT IF EXISTS media_jobs_reserved_output_bytes_check,
  ADD CONSTRAINT media_jobs_reserved_output_bytes_check CHECK (reserved_output_bytes >= 0);

CREATE INDEX IF NOT EXISTS media_jobs_reclaim_idx
  ON rend.media_jobs (lease_expires_at, run_after, created_at, id)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS rend.media_job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES rend.media_jobs(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES rend.assets(id) ON DELETE CASCADE,
  lease_token uuid NOT NULL,
  worker_id text NOT NULL,
  attempt integer NOT NULL,
  status text NOT NULL DEFAULT 'running',
  reserved_microusd bigint NOT NULL DEFAULT 0,
  actual_microusd bigint,
  output_bytes bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  CONSTRAINT media_job_attempts_attempt_check CHECK (attempt > 0),
  CONSTRAINT media_job_attempts_status_check CHECK (
    status IN ('running', 'succeeded', 'retryable', 'failed', 'cancelled', 'lease_lost', 'deferred_budget')
  ),
  CONSTRAINT media_job_attempts_reserved_check CHECK (reserved_microusd >= 0),
  CONSTRAINT media_job_attempts_actual_check CHECK (actual_microusd IS NULL OR actual_microusd >= 0),
  CONSTRAINT media_job_attempts_output_check CHECK (output_bytes >= 0),
  CONSTRAINT media_job_attempts_lease_uidx UNIQUE (job_id, lease_token)
);

CREATE INDEX IF NOT EXISTS media_job_attempts_asset_started_idx
  ON rend.media_job_attempts(asset_id, started_at DESC);

CREATE TABLE IF NOT EXISTS rend.organization_storage_usage (
  organization_id uuid PRIMARY KEY REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  used_bytes bigint NOT NULL DEFAULT 0,
  video_limit integer NOT NULL DEFAULT 50,
  byte_limit bigint NOT NULL DEFAULT 268435456000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_storage_reserved_check CHECK (reserved_bytes >= 0),
  CONSTRAINT organization_storage_used_check CHECK (used_bytes >= 0),
  CONSTRAINT organization_storage_video_limit_check CHECK (video_limit > 0),
  CONSTRAINT organization_storage_byte_limit_check CHECK (byte_limit > 0)
);

INSERT INTO rend.organization_storage_usage (organization_id, used_bytes)
SELECT
  organization.id,
  COALESCE(SUM(artifact.byte_size) FILTER (WHERE asset.deleted_at IS NULL), 0)::bigint
FROM rend_auth.organization organization
LEFT JOIN rend.assets asset ON asset.organization_id = organization.id
LEFT JOIN rend.artifacts artifact ON artifact.asset_id = asset.id
GROUP BY organization.id
ON CONFLICT (organization_id) DO NOTHING;

DROP TRIGGER IF EXISTS set_updated_at ON rend.organization_storage_usage;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.organization_storage_usage
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

CREATE TABLE IF NOT EXISTS rend.global_storage_usage (
  singleton boolean PRIMARY KEY DEFAULT true,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  used_bytes bigint NOT NULL DEFAULT 0,
  byte_limit bigint NOT NULL DEFAULT 5497558138880,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_storage_singleton_check CHECK (singleton),
  CONSTRAINT global_storage_reserved_check CHECK (reserved_bytes >= 0),
  CONSTRAINT global_storage_used_check CHECK (used_bytes >= 0),
  CONSTRAINT global_storage_byte_limit_check CHECK (byte_limit > 0)
);

INSERT INTO rend.global_storage_usage (singleton, used_bytes)
SELECT true, COALESCE(SUM(byte_size), 0)::bigint
FROM rend.artifacts artifact
INNER JOIN rend.assets asset ON asset.id = artifact.asset_id
WHERE asset.deleted_at IS NULL
ON CONFLICT (singleton) DO NOTHING;

DROP TRIGGER IF EXISTS set_updated_at ON rend.global_storage_usage;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.global_storage_usage
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

CREATE TABLE IF NOT EXISTS rend.storage_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES rend.assets(id) ON DELETE CASCADE,
  reference_key text NOT NULL,
  reason text NOT NULL,
  reserved_bytes_delta bigint NOT NULL DEFAULT 0,
  used_bytes_delta bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_ledger_nonempty_delta_check CHECK (
    reserved_bytes_delta <> 0 OR used_bytes_delta <> 0
  ),
  CONSTRAINT storage_ledger_reference_key_check CHECK (length(reference_key) BETWEEN 1 AND 300),
  CONSTRAINT storage_ledger_reason_check CHECK (length(reason) BETWEEN 1 AND 80),
  CONSTRAINT storage_ledger_reference_uidx UNIQUE (organization_id, reference_key)
);

CREATE INDEX IF NOT EXISTS storage_ledger_asset_created_idx
  ON rend.storage_ledger_entries(asset_id, created_at, id);

CREATE TABLE IF NOT EXISTS rend.upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL UNIQUE REFERENCES rend.assets(id) ON DELETE CASCADE,
  provider_upload_id text NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  content_length bigint NOT NULL,
  filename text,
  part_size integer NOT NULL DEFAULT 16777216,
  part_count integer NOT NULL,
  checksum_sha256 text,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'uploading',
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  aborted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT upload_sessions_content_length_check CHECK (content_length > 0),
  CONSTRAINT upload_sessions_part_size_check CHECK (part_size >= 5242880),
  CONSTRAINT upload_sessions_part_count_check CHECK (part_count BETWEEN 1 AND 10000),
  CONSTRAINT upload_sessions_status_check CHECK (
    status IN ('uploading', 'completing', 'completed', 'aborted', 'expired', 'failed')
  ),
  CONSTRAINT upload_sessions_idempotency_key_check CHECK (
    length(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT upload_sessions_org_idempotency_uidx UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS upload_sessions_org_status_idx
  ON rend.upload_sessions(organization_id, status, expires_at);

CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx
  ON rend.upload_sessions(expires_at)
  WHERE status IN ('uploading', 'completing');

DROP TRIGGER IF EXISTS set_updated_at ON rend.upload_sessions;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.upload_sessions
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

CREATE TABLE IF NOT EXISTS rend.media_compute_months (
  month date PRIMARY KEY,
  cap_microusd bigint NOT NULL,
  base_microusd bigint NOT NULL DEFAULT 0,
  reserved_microusd bigint NOT NULL DEFAULT 0,
  spent_microusd bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_compute_months_cap_check CHECK (cap_microusd > 0),
  CONSTRAINT media_compute_months_base_check CHECK (base_microusd >= 0),
  CONSTRAINT media_compute_months_reserved_check CHECK (reserved_microusd >= 0),
  CONSTRAINT media_compute_months_spent_check CHECK (spent_microusd >= 0)
);

DROP TRIGGER IF EXISTS set_updated_at ON rend.media_compute_months;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.media_compute_months
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

ALTER TABLE rend.asset_events
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS asset_events_asset_dedupe_uidx
  ON rend.asset_events(asset_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_asset_object_key_uidx
  ON rend.artifacts(asset_id, object_key);
