CREATE INDEX IF NOT EXISTS edge_nodes_active_fanout_idx
ON rend.edge_nodes(status, last_heartbeat_at)
WHERE base_url IS NOT NULL;
