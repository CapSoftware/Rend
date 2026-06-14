export type AssetSummary = {
  asset_id: string;
  source_state: string;
  playable_state: string;
  created_at: string;
  updated_at: string;
  source_byte_size?: number;
  artifact_count: number;
  suspended_at?: string;
  suspension_reason?: string;
  organization_suspended_at?: string;
  organization_suspension_reason?: string;
};

export type AssetArtifact = {
  kind: string;
  content_type: string;
  byte_size?: number;
};

export type AssetDetail = AssetSummary & {
  artifacts: AssetArtifact[];
};

export type AssetListResponse = {
  status: "ok";
  assets: AssetSummary[];
};

export type AssetUploadResponse = {
  status: "ok";
  asset: AssetSummary;
};

export type AssetDeleteResponse = {
  status: "ok";
  asset_id: string;
  deleted: true;
  already_deleted: boolean;
  origin_objects_deleted: number;
  purge_attempted: boolean;
};

export type AssetPlaybackAnalytics = {
  asset_id: string;
  window_started_at: string;
  window_ended_at: string;
  request_count: number;
  bytes_served: number;
  cache_status_counts: Record<string, number>;
  status_code_counts: Record<string, number>;
  first_seen?: string;
  last_seen?: string;
};

export type AssetPlayerTelemetryEvent = {
  playback_session_id: string;
  asset_id: string;
  phase: string;
  event_time_ms: number;
  received_at_ms: number;
  bootstrap_duration_ms?: number;
  bootstrap_http_status?: number;
  selected_playback_mode?: string;
  selected_artifact_path?: string;
  metadata_loaded_ms?: number;
  canplay_ms?: number;
  first_frame_ms?: number;
  playback_failure_reason?: string;
  playback_failure_code?: string;
  cache_headers?: Record<string, string>;
  edge_label?: string;
  region_label?: string;
  player_version?: string;
  app_version?: string;
};

export type AssetPlayerTelemetryResponse = {
  status: "ok";
  events: AssetPlayerTelemetryEvent[];
};

export type AssetErrorResponse = {
  status: "error";
  error: string;
  message: string;
};
