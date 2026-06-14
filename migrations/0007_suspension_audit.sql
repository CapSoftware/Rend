ALTER TABLE rend_auth.organization
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by_user_id uuid REFERENCES rend_auth."user"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suspension_reason text;

ALTER TABLE rend.assets
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by_user_id uuid REFERENCES rend_auth."user"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suspension_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organization_suspension_reason_check'
      AND conrelid = 'rend_auth.organization'::regclass
  ) THEN
    ALTER TABLE rend_auth.organization
      ADD CONSTRAINT organization_suspension_reason_check
      CHECK (suspension_reason IS NULL OR length(suspension_reason) BETWEEN 1 AND 1000);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'assets_suspension_reason_check'
      AND conrelid = 'rend.assets'::regclass
  ) THEN
    ALTER TABLE rend.assets
      ADD CONSTRAINT assets_suspension_reason_check
      CHECK (suspension_reason IS NULL OR length(suspension_reason) BETWEEN 1 AND 1000);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS organization_suspended_idx
  ON rend_auth.organization(suspended_at)
  WHERE suspended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS assets_organization_suspended_idx
  ON rend.assets(organization_id, suspended_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS rend.operator_audit_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_user_id uuid REFERENCES rend_auth."user"(id) ON DELETE SET NULL,
  operator_email text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_audit_action_check CHECK (action IN ('suspend', 'restore')),
  CONSTRAINT operator_audit_target_type_check CHECK (target_type IN ('organization', 'asset')),
  CONSTRAINT operator_audit_reason_check CHECK (length(reason) BETWEEN 1 AND 1000),
  CONSTRAINT operator_audit_email_check CHECK (operator_email !~ '[\r\n]' AND length(operator_email) BETWEEN 3 AND 320)
);

CREATE INDEX IF NOT EXISTS operator_audit_target_idx
  ON rend.operator_audit_records(target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS operator_audit_created_idx
  ON rend.operator_audit_records(created_at DESC);
