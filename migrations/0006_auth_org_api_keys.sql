CREATE SCHEMA IF NOT EXISTS rend_auth;

CREATE TABLE IF NOT EXISTS rend_auth."user" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_uidx ON rend_auth."user"(email);

CREATE TABLE IF NOT EXISTS rend_auth.organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  logo text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_slug_uidx ON rend_auth.organization(slug);

CREATE TABLE IF NOT EXISTS rend_auth.session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES rend_auth."user"(id) ON DELETE CASCADE,
  active_organization_id uuid REFERENCES rend_auth.organization(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS session_token_uidx ON rend_auth.session(token);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON rend_auth.session(user_id);
CREATE INDEX IF NOT EXISTS session_expires_at_idx ON rend_auth.session(expires_at);

CREATE TABLE IF NOT EXISTS rend_auth.account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES rend_auth."user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_user_id_idx ON rend_auth.account(user_id);
CREATE INDEX IF NOT EXISTS account_provider_account_idx ON rend_auth.account(provider_id, account_id);

CREATE TABLE IF NOT EXISTS rend_auth.verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON rend_auth.verification(identifier);
CREATE INDEX IF NOT EXISTS verification_expires_at_idx ON rend_auth.verification(expires_at);

CREATE TABLE IF NOT EXISTS rend_auth.rate_limit (
  key text PRIMARY KEY,
  count integer NOT NULL,
  last_request bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS rend_auth.member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES rend_auth."user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_role_check CHECK (role IN ('owner', 'admin', 'member'))
);

CREATE UNIQUE INDEX IF NOT EXISTS member_user_org_uidx ON rend_auth.member(user_id, organization_id);
CREATE INDEX IF NOT EXISTS member_user_id_idx ON rend_auth.member(user_id);
CREATE INDEX IF NOT EXISTS member_organization_id_idx ON rend_auth.member(organization_id);

CREATE TABLE IF NOT EXISTS rend_auth.invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  inviter_id uuid NOT NULL REFERENCES rend_auth."user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitation_role_check CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT invitation_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled'))
);

CREATE INDEX IF NOT EXISTS invitation_email_idx ON rend_auth.invitation(email);
CREATE INDEX IF NOT EXISTS invitation_organization_status_idx ON rend_auth.invitation(organization_id, status);

INSERT INTO rend_auth.organization (id, name, slug, metadata)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Rend Local',
  'local',
  '{"seeded":"local"}'::jsonb
)
ON CONFLICT DO NOTHING;

INSERT INTO rend_auth.organization (id, name, slug, metadata)
SELECT DISTINCT
  asset.organization_id,
  'Imported Organization ' || left(replace(asset.organization_id::text, '-', ''), 8),
  'imported-' || replace(asset.organization_id::text, '-', ''),
  '{"seeded":"migration"}'::jsonb
FROM rend.assets asset
WHERE asset.organization_id IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE rend.assets
SET organization_id = '00000000-0000-0000-0000-000000000001'
WHERE organization_id IS NULL;

ALTER TABLE rend.assets
  ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'assets_organization_id_fkey'
      AND conrelid = 'rend.assets'::regclass
  ) THEN
    ALTER TABLE rend.assets
      ADD CONSTRAINT assets_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES rend_auth.organization(id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS rend.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rend_auth.organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL,
  created_by_user_id uuid REFERENCES rend_auth."user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  last_used_update_after timestamptz,
  CONSTRAINT api_keys_scopes_nonempty_check CHECK (cardinality(scopes) > 0),
  CONSTRAINT api_keys_scopes_allowed_check CHECK (
    scopes <@ ARRAY['upload', 'read', 'delete', 'analytics']::text[]
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_uidx ON rend.api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_organization_revoked_idx ON rend.api_keys(organization_id, revoked_at);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON rend.api_keys(prefix);
CREATE INDEX IF NOT EXISTS assets_organization_created_id_idx
  ON rend.assets(organization_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS assets_organization_id_asset_id_idx ON rend.assets(organization_id, id);
CREATE INDEX IF NOT EXISTS artifacts_asset_id_kind_idx ON rend.artifacts(asset_id, kind);

DROP TRIGGER IF EXISTS set_updated_at ON rend_auth."user";
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend_auth."user"
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend_auth.organization;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend_auth.organization
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend_auth.session;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend_auth.session
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend_auth.account;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend_auth.account
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend_auth.verification;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend_auth.verification
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();
