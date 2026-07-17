ALTER TABLE rend.media_jobs
  ADD COLUMN IF NOT EXISTS reservation_month date;

ALTER TABLE rend.media_job_attempts
  ADD COLUMN IF NOT EXISTS reservation_month date;

UPDATE rend.media_jobs
SET reservation_month = date_trunc(
  'month',
  COALESCE(locked_at, heartbeat_at, created_at, now())
)::date
WHERE reserved_microusd > 0
  AND reservation_month IS NULL;

UPDATE rend.media_job_attempts attempt
SET reservation_month = COALESCE(
  job.reservation_month,
  date_trunc('month', COALESCE(attempt.started_at, job.locked_at, job.created_at, now()))::date
)
FROM rend.media_jobs job
WHERE job.id = attempt.job_id
  AND attempt.reserved_microusd > 0
  AND attempt.reservation_month IS NULL;

ALTER TABLE rend.media_jobs
  DROP CONSTRAINT IF EXISTS media_jobs_compute_reservation_month_check;

ALTER TABLE rend.media_jobs
  ADD CONSTRAINT media_jobs_compute_reservation_month_check
  CHECK (reserved_microusd = 0 OR reservation_month IS NOT NULL) NOT VALID;

ALTER TABLE rend.media_jobs
  VALIDATE CONSTRAINT media_jobs_compute_reservation_month_check;

ALTER TABLE rend.media_job_attempts
  DROP CONSTRAINT IF EXISTS media_job_attempts_compute_reservation_month_check;

ALTER TABLE rend.media_job_attempts
  ADD CONSTRAINT media_job_attempts_compute_reservation_month_check
  CHECK (reserved_microusd = 0 OR reservation_month IS NOT NULL) NOT VALID;

ALTER TABLE rend.media_job_attempts
  VALIDATE CONSTRAINT media_job_attempts_compute_reservation_month_check;

CREATE INDEX IF NOT EXISTS media_jobs_reservation_month_idx
  ON rend.media_jobs (reservation_month)
  WHERE reserved_microusd > 0;
