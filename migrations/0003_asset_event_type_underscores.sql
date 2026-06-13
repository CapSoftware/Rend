ALTER TABLE rend.asset_events
DROP CONSTRAINT IF EXISTS asset_events_event_type_check;

ALTER TABLE rend.asset_events
ADD CONSTRAINT asset_events_event_type_check
CHECK (event_type ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$');
