CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS rend;

CREATE OR REPLACE FUNCTION rend.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS rend.assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  source_state text NOT NULL DEFAULT 'pending',
  playable_state text NOT NULL DEFAULT 'not_playable',
  playback_policy text NOT NULL DEFAULT 'public',
  duration_ms bigint,
  current_opener_artifact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT assets_source_state_check CHECK (source_state IN ('pending', 'uploading', 'uploaded', 'processing', 'ready', 'failed', 'deleted')),
  CONSTRAINT assets_playable_state_check CHECK (playable_state IN ('not_playable', 'opener_ready', 'hls_ready', 'failed', 'deleted')),
  CONSTRAINT assets_playback_policy_check CHECK (playback_policy IN ('public', 'signed'))
);

CREATE TABLE IF NOT EXISTS rend.artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES rend.assets(id) ON DELETE CASCADE,
  kind text NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint,
  checksum text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_kind_check CHECK (kind IN ('source', 'opener', 'thumbnail', 'manifest', 'segment', 'rendition_metadata'))
);

CREATE TABLE IF NOT EXISTS rend.playback_signing_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id text NOT NULL UNIQUE,
  algorithm text NOT NULL DEFAULT 'ed25519',
  public_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  not_before timestamptz NOT NULL DEFAULT now(),
  not_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT playback_signing_keys_status_check CHECK (status IN ('active', 'retiring', 'retired'))
);

CREATE TABLE IF NOT EXISTS rend.edge_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_id text NOT NULL UNIQUE,
  region text NOT NULL,
  base_url text,
  cache_max_bytes bigint,
  status text NOT NULL DEFAULT 'registered',
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edge_nodes_status_check CHECK (status IN ('registered', 'healthy', 'draining', 'unhealthy', 'removed'))
);

CREATE TABLE IF NOT EXISTS rend.edge_warm_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES rend.assets(id) ON DELETE CASCADE,
  artifact_id uuid REFERENCES rend.artifacts(id) ON DELETE SET NULL,
  edge_node_id uuid REFERENCES rend.edge_nodes(id) ON DELETE SET NULL,
  region text,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edge_warm_requests_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS rend.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_organization_id_idx ON rend.assets(organization_id);
CREATE INDEX IF NOT EXISTS artifacts_asset_id_kind_idx ON rend.artifacts(asset_id, kind);
CREATE INDEX IF NOT EXISTS edge_nodes_region_status_idx ON rend.edge_nodes(region, status);
CREATE INDEX IF NOT EXISTS edge_warm_requests_status_next_attempt_idx ON rend.edge_warm_requests(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx ON rend.outbox_events(created_at) WHERE published_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at ON rend.assets;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.assets
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend.artifacts;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.artifacts
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend.playback_signing_keys;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.playback_signing_keys
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend.edge_nodes;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.edge_nodes
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON rend.edge_warm_requests;
CREATE TRIGGER set_updated_at
BEFORE UPDATE ON rend.edge_warm_requests
FOR EACH ROW EXECUTE FUNCTION rend.set_updated_at();
