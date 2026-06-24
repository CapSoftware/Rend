-- Acquisition dimensions for DataFast-style analytics: UTM campaign tagging and
-- a derived acquisition channel (Direct, Referral, Organic Search, Social,
-- Email, Paid, Campaign). These are captured client-side from the page URL and
-- document.referrer, then validated in the control plane before insert. Geo
-- region/city already exist on player_events; this only adds the source columns.

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT ''
    AFTER geo_asn;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS utm_source LowCardinality(String) DEFAULT ''
    AFTER channel;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS utm_medium LowCardinality(String) DEFAULT ''
    AFTER utm_source;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS utm_campaign String DEFAULT ''
    AFTER utm_medium;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS utm_term String DEFAULT ''
    AFTER utm_campaign;

ALTER TABLE rend.player_events
    ADD COLUMN IF NOT EXISTS utm_content String DEFAULT ''
    AFTER utm_term;
