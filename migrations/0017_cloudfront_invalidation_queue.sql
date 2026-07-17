CREATE TABLE IF NOT EXISTS rend.cloudfront_invalidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  caller_reference text NOT NULL UNIQUE,
  paths text[] NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  lease_expires_at timestamptz,
  invalidation_id text,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cloudfront_invalidations_paths_check CHECK (
    cardinality(paths) BETWEEN 1 AND 1000
  ),
  CONSTRAINT cloudfront_invalidations_status_check CHECK (
    status IN ('queued', 'submitting', 'submitted', 'succeeded')
  ),
  CONSTRAINT cloudfront_invalidations_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS cloudfront_invalidations_claim_idx
  ON rend.cloudfront_invalidations (next_attempt_at, created_at)
  WHERE status IN ('queued', 'submitting', 'submitted');

DROP TRIGGER IF EXISTS set_updated_at ON rend.cloudfront_invalidations;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.cloudfront_invalidations
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();
