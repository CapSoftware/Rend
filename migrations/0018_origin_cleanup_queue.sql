CREATE TABLE IF NOT EXISTS rend.origin_cleanup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL,
  bucket_kind text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  lease_expires_at timestamptz,
  objects_deleted bigint NOT NULL DEFAULT 0,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT origin_cleanup_jobs_asset_bucket_uidx UNIQUE (asset_id, bucket_kind),
  CONSTRAINT origin_cleanup_jobs_bucket_kind_check CHECK (bucket_kind IN ('media', 'source')),
  CONSTRAINT origin_cleanup_jobs_status_check CHECK (status IN ('queued', 'cleaning', 'succeeded')),
  CONSTRAINT origin_cleanup_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT origin_cleanup_jobs_objects_deleted_check CHECK (objects_deleted >= 0)
);

CREATE INDEX IF NOT EXISTS origin_cleanup_jobs_claim_idx
  ON rend.origin_cleanup_jobs (next_attempt_at, created_at)
  WHERE status IN ('queued', 'cleaning');

DROP TRIGGER IF EXISTS set_updated_at ON rend.origin_cleanup_jobs;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.origin_cleanup_jobs
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();
