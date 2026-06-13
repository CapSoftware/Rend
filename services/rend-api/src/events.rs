use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};

pub const EVENT_ASSET_CREATED: &str = "asset.created";
pub const EVENT_SOURCE_UPLOAD_STARTED: &str = "source.upload_started";
pub const EVENT_SOURCE_UPLOADED: &str = "source.uploaded";
pub const EVENT_MEDIA_PROCESSING_STARTED: &str = "media.processing_started";
pub const EVENT_ARTIFACT_GENERATED: &str = "artifact.generated";
pub const EVENT_PLAYABLE_STATE_CHANGED: &str = "playable_state.changed";
pub const EVENT_EDGE_WARMING_ATTEMPTED: &str = "edge.warming_attempted";
pub const EVENT_EDGE_WARMING_SUCCEEDED: &str = "edge.warming_succeeded";
pub const EVENT_EDGE_WARMING_FAILED: &str = "edge.warming_failed";
pub const EVENT_UPLOAD_RESPONSE_READY: &str = "upload.response_ready";

#[derive(Clone, Debug, PartialEq)]
pub struct AssetLifecycleEvent {
    pub event_type: &'static str,
    pub metadata: Value,
}

#[derive(Clone, Copy, Debug)]
pub struct ArtifactEventInput<'a> {
    pub kind: &'a str,
    pub object_key: &'a str,
    pub content_type: &'a str,
    pub byte_size: i64,
}

pub async fn insert_asset_event(
    tx: &mut Transaction<'_, Postgres>,
    asset_id: &str,
    event_type: &str,
    metadata: Value,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "
        INSERT INTO rend.asset_events (asset_id, event_type, metadata)
        VALUES ($1::uuid, $2, $3::jsonb)
        RETURNING sequence
        ",
    )
    .bind(asset_id)
    .bind(event_type)
    .bind(metadata.to_string())
    .fetch_one(&mut **tx)
    .await
}

pub async fn insert_asset_event_pool(
    db: &PgPool,
    asset_id: &str,
    event_type: &str,
    metadata: Value,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "
        INSERT INTO rend.asset_events (asset_id, event_type, metadata)
        VALUES ($1::uuid, $2, $3::jsonb)
        RETURNING sequence
        ",
    )
    .bind(asset_id)
    .bind(event_type)
    .bind(metadata.to_string())
    .fetch_one(db)
    .await
}

pub fn asset_created_metadata(source_state: &str, playable_state: &str) -> Value {
    json!({
        "source_state": source_state,
        "playable_state": playable_state,
    })
}

pub fn source_upload_started_metadata(
    content_type: &str,
    content_length: Option<i64>,
) -> Value {
    json!({
        "content_type": content_type,
        "content_length": content_length,
    })
}

pub fn source_uploaded_metadata(content_type: &str, byte_size: i64) -> Value {
    json!({
        "content_type": content_type,
        "byte_size": byte_size,
    })
}

pub fn media_processing_started_metadata(source_state: &str, playable_state: &str) -> Value {
    json!({
        "source_state": source_state,
        "playable_state": playable_state,
    })
}

pub fn playable_state_changed_metadata(previous: &str, current: &str) -> Value {
    json!({
        "previous": previous,
        "current": current,
    })
}

pub fn edge_warming_metadata(artifact_paths: &[String]) -> Value {
    json!({
        "artifact_count": artifact_paths.len(),
        "artifact_paths": artifact_paths,
    })
}

pub fn edge_warming_failed_metadata(
    artifact_paths: &[String],
    reason: &str,
    status: Option<u16>,
) -> Value {
    json!({
        "artifact_count": artifact_paths.len(),
        "artifact_paths": artifact_paths,
        "reason": reason,
        "status": status,
    })
}

pub fn upload_response_ready_metadata(
    source_state: &str,
    playable_state: &str,
    byte_size: i64,
) -> Value {
    json!({
        "source_state": source_state,
        "playable_state": playable_state,
        "byte_size": byte_size,
    })
}

pub fn artifact_generated_events(
    asset_id: &str,
    artifacts: &[ArtifactEventInput<'_>],
) -> Vec<AssetLifecycleEvent> {
    let mut events = Vec::new();
    let mut segments = Vec::new();

    for artifact in artifacts {
        let artifact_path = external_artifact_path(asset_id, artifact.object_key);
        if artifact.kind == "segment" {
            segments.push(SegmentSummary {
                artifact_path,
                content_type: artifact.content_type,
                byte_size: artifact.byte_size,
            });
            continue;
        }

        events.push(AssetLifecycleEvent {
            event_type: EVENT_ARTIFACT_GENERATED,
            metadata: json!({
                "kind": artifact.kind,
                "artifact_path": artifact_path,
                "content_type": artifact.content_type,
                "byte_size": artifact.byte_size,
            }),
        });
    }

    if !segments.is_empty() {
        segments.sort_by(|left, right| left.artifact_path.cmp(&right.artifact_path));
        let count = segments.len();
        let total_byte_size: i64 = segments.iter().map(|segment| segment.byte_size).sum();
        let first = &segments[0];
        let last = &segments[count - 1];

        events.push(AssetLifecycleEvent {
            event_type: EVENT_ARTIFACT_GENERATED,
            metadata: json!({
                "kind": "segment",
                "count": count,
                "content_type": first.content_type,
                "total_byte_size": total_byte_size,
                "first_artifact_path": first.artifact_path,
                "last_artifact_path": last.artifact_path,
            }),
        });
    }

    events
}

fn external_artifact_path(asset_id: &str, object_key: &str) -> String {
    let prefix = format!("videos/{asset_id}/");
    object_key
        .strip_prefix(&prefix)
        .unwrap_or(object_key)
        .to_owned()
}

struct SegmentSummary<'a> {
    artifact_path: String,
    content_type: &'a str,
    byte_size: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_generated_events_bound_segment_payloads() {
        let artifacts = vec![
            ArtifactEventInput {
                kind: "opener",
                object_key: "videos/asset-123/opener.mp4",
                content_type: "video/mp4",
                byte_size: 100,
            },
            ArtifactEventInput {
                kind: "segment",
                object_key: "videos/asset-123/hls/segment_00001.ts",
                content_type: "video/mp2t",
                byte_size: 30,
            },
            ArtifactEventInput {
                kind: "segment",
                object_key: "videos/asset-123/hls/segment_00000.ts",
                content_type: "video/mp2t",
                byte_size: 20,
            },
        ];

        let events = artifact_generated_events("asset-123", &artifacts);

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, EVENT_ARTIFACT_GENERATED);
        assert_eq!(events[0].metadata["kind"], "opener");
        assert_eq!(events[0].metadata["artifact_path"], "opener.mp4");
        assert_eq!(events[1].metadata["kind"], "segment");
        assert_eq!(events[1].metadata["count"], 2);
        assert_eq!(
            events[1].metadata["first_artifact_path"],
            "hls/segment_00000.ts"
        );
        assert_eq!(
            events[1].metadata["last_artifact_path"],
            "hls/segment_00001.ts"
        );
        assert_eq!(events[1].metadata["total_byte_size"], 50);
    }

    #[test]
    fn lifecycle_metadata_excludes_playback_tokens_and_secrets() {
        let artifacts = vec![ArtifactEventInput {
            kind: "manifest",
            object_key: "videos/asset-123/hls/master.m3u8",
            content_type: "application/vnd.apple.mpegurl",
            byte_size: 100,
        }];
        let mut metadata = vec![
            asset_created_metadata("uploading", "not_playable"),
            source_upload_started_metadata("video/mp4", Some(123)),
            source_uploaded_metadata("video/mp4", 123),
            media_processing_started_metadata("uploaded", "not_playable"),
            playable_state_changed_metadata("not_playable", "hls_ready"),
            edge_warming_metadata(&["opener.mp4".to_owned()]),
            edge_warming_failed_metadata(&["opener.mp4".to_owned()], "status_error", Some(502)),
            upload_response_ready_metadata("uploaded", "hls_ready", 123),
        ];
        metadata.extend(
            artifact_generated_events("asset-123", &artifacts)
                .into_iter()
                .map(|event| event.metadata),
        );

        for value in metadata {
            assert_metadata_is_external_safe(&value);
        }
    }

    fn assert_metadata_is_external_safe(value: &Value) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    let lower = key.to_ascii_lowercase();
                    assert!(!lower.contains("token"), "{key}");
                    assert!(!lower.contains("secret"), "{key}");
                    assert!(!lower.contains("credential"), "{key}");
                    assert!(!lower.contains("authorization"), "{key}");
                    assert_ne!(lower, "playback_url");
                    assert_metadata_is_external_safe(value);
                }
            }
            Value::Array(values) => {
                for value in values {
                    assert_metadata_is_external_safe(value);
                }
            }
            Value::String(value) => {
                let lower = value.to_ascii_lowercase();
                assert!(!lower.contains("?token="), "{value}");
                assert!(!lower.contains("bearer "), "{value}");
            }
            _ => {}
        }
    }
}
