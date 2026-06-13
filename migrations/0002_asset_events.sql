CREATE TABLE IF NOT EXISTS rend.asset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES rend.assets(id) ON DELETE CASCADE,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_events_event_type_check CHECK (event_type ~ '^[a-z0-9]+(\.[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_events_sequence_idx ON rend.asset_events(sequence);
CREATE INDEX IF NOT EXISTS asset_events_asset_id_sequence_idx ON rend.asset_events(asset_id, sequence);
