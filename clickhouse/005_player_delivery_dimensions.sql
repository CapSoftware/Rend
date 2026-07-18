ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS selected_width UInt32 DEFAULT 0
    AFTER selected_artifact_path;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS selected_height UInt32 DEFAULT 0
    AFTER selected_width;
