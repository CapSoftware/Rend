CREATE TABLE IF NOT EXISTS rend.media_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES rend.assets(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  locked_at timestamptz,
  locked_by text,
  run_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_jobs_job_type_check CHECK (job_type IN ('process_media')),
  CONSTRAINT media_jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT media_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT media_jobs_max_attempts_check CHECK (max_attempts > 0)
);

CREATE INDEX IF NOT EXISTS media_jobs_queued_claim_idx
  ON rend.media_jobs (run_after, created_at, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS media_jobs_asset_id_idx
  ON rend.media_jobs (asset_id);

DROP TRIGGER IF EXISTS set_updated_at ON rend.media_jobs;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.media_jobs
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();
