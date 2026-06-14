use super::*;
use axum::{body::to_bytes, http::HeaderValue};
use rend_playback_auth::{POLICY_ASSET_PLAYBACK_V1, decode_unverified_claims};
use std::sync::atomic::AtomicUsize;
use tower::ServiceExt;

const NOW: u64 = 1_800_000_000;
const LOCAL_ADMIN_USER_ID: &str = "00000000-0000-0000-0000-000000000010";

#[derive(Clone)]
struct WarmRecorder {
    count: Arc<AtomicUsize>,
    last_token: Arc<Mutex<Option<String>>>,
    last_request: Arc<Mutex<Option<EdgeWarmRequest>>>,
    status: StatusCode,
}

async fn record_warm(
    State(recorder): State<WarmRecorder>,
    headers: HeaderMap,
    Json(request): Json<EdgeWarmRequest>,
) -> Response {
    recorder.count.fetch_add(1, Ordering::SeqCst);
    let token = headers
        .get("x-rend-internal-token")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    *recorder.last_token.lock().unwrap() = token;
    *recorder.last_request.lock().unwrap() = Some(request);

    if recorder.status.is_success() {
        (
            recorder.status,
            Json(serde_json::json!({
                "asset_id": "asset-123",
                "results": [],
                "summary": {
                    "total": 0,
                    "warmed": 0,
                    "already_warm": 0,
                    "not_found": 0,
                    "failed": 0
                }
            })),
        )
            .into_response()
    } else {
        recorder.status.into_response()
    }
}

async fn spawn_warm_recorder(status: StatusCode) -> (String, WarmRecorder) {
    let recorder = WarmRecorder {
        count: Arc::new(AtomicUsize::new(0)),
        last_token: Arc::new(Mutex::new(None)),
        last_request: Arc::new(Mutex::new(None)),
        status,
    };
    let app = Router::new()
        .route("/internal/warm", post(record_warm))
        .with_state(recorder.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}/internal/warm"), recorder)
}

fn test_issuer() -> PlaybackTokenIssuer {
    PlaybackTokenIssuer::new(
        SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap(),
        Duration::from_secs(600),
    )
    .unwrap()
}

fn test_config() -> ApiConfig {
    ApiConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        database_url: "postgres://rend:rend@localhost:5432/rend".to_owned(),
        redis_url: "redis://localhost:6379".to_owned(),
        object_store_health_url: "http://localhost:9100/minio/health/ready".to_owned(),
        dev_api_key: "dev-secret".to_owned(),
        site_internal_token: "site-internal".to_owned(),
        s3_endpoint: "http://localhost:9100".to_owned(),
        s3_region: "us-east-1".to_owned(),
        s3_bucket: "rend-local".to_owned(),
        aws_access_key_id: "test".to_owned(),
        aws_secret_access_key: "test".to_owned(),
        playback_base_url: "http://127.0.0.1:4100".to_owned(),
        playback_token_issuer: test_issuer(),
        playback_bootstrap_prefetch_segments: DEFAULT_PLAYBACK_BOOTSTRAP_PREFETCH_SEGMENTS,
        edge_registry: EdgeRegistryConfig {
            internal_token: "internal".to_owned(),
            active_heartbeat_window: Duration::from_secs(DEFAULT_EDGE_ACTIVE_HEARTBEAT_WINDOW_SECS),
            expected_edges: ExpectedEdges::default(),
            rend_env: RendEnv::Local,
            allow_insecure_edge_urls: false,
        },
        edge_warm: EdgeWarmConfig {
            url: None,
            internal_token: "internal".to_owned(),
            max_artifacts: DEFAULT_EDGE_WARM_MAX_ARTIFACTS,
        },
        edge_purge: EdgePurgeConfig {
            url: None,
            internal_token: "internal".to_owned(),
        },
        playback_telemetry: telemetry::TelemetryConfig {
            clickhouse_url: "http://127.0.0.1:8123".to_owned(),
            clickhouse_database: "rend".to_owned(),
            clickhouse_user: "rend".to_owned(),
            clickhouse_password: "rend".to_owned(),
            internal_token: "internal".to_owned(),
            max_body_bytes: 256 * 1024,
            max_events_per_batch: 100,
            default_analytics_window_secs: 24 * 60 * 60,
            max_analytics_window_secs: 7 * 24 * 60 * 60,
        },
        media_processing: media::MediaProcessingConfig {
            ffmpeg_path: "ffmpeg".to_owned(),
            ffprobe_path: "ffprobe".to_owned(),
            process_timeout: Duration::from_secs(60),
        },
        media_job_max_attempts: 3,
        inline_media_processing: false,
        media_worker: MediaWorkerConfig {
            worker_id: "test-worker".to_owned(),
            poll_interval: Duration::from_secs(1),
            lock_timeout: Duration::from_secs(300),
        },
        auto_migrate: false,
        request_timeout: Duration::from_secs(10),
        max_upload_bytes: DEFAULT_MAX_UPLOAD_BYTES,
    }
}

fn test_state() -> Arc<AppState> {
    let config = test_config();
    let db = PgPoolOptions::new()
        .connect_lazy(&config.database_url)
        .unwrap();
    let s3 = build_s3_client(&config);

    Arc::new(AppState {
        config,
        db,
        http: reqwest::Client::new(),
        s3,
        started_at: Instant::now(),
    })
}

fn asset_record(playable_state: &str) -> AssetPlaybackRecord {
    AssetPlaybackRecord {
        asset_id: "asset-123".to_owned(),
        source_state: "uploaded".to_owned(),
        playable_state: playable_state.to_owned(),
    }
}

fn asset_state_record(playable_state: &str) -> AssetStateRecord {
    AssetStateRecord {
        asset_id: "asset-123".to_owned(),
        source_state: "uploaded".to_owned(),
        playable_state: playable_state.to_owned(),
        created_at: "2026-06-13T12:00:00.000Z".to_owned(),
        updated_at: "2026-06-13T12:01:00.000Z".to_owned(),
        suspended_at: None,
        suspension_reason: None,
        organization_suspended_at: None,
        organization_suspension_reason: None,
    }
}

fn artifact_record(
    kind: impl Into<String>,
    object_key: impl Into<String>,
    content_type: impl Into<String>,
) -> PlaybackArtifactRecord {
    PlaybackArtifactRecord {
        kind: kind.into(),
        object_key: object_key.into(),
        content_type: content_type.into(),
    }
}

fn event_record(sequence: i64, event_type: &str) -> AssetEventRecord {
    event_record_for_asset("asset-123", sequence, event_type)
}

fn event_record_for_asset(asset_id: &str, sequence: i64, event_type: &str) -> AssetEventRecord {
    AssetEventRecord {
        id: format!("event-{sequence}"),
        asset_id: asset_id.to_owned(),
        sequence,
        event_type: event_type.to_owned(),
        created_at: "2026-06-13T12:00:00.000Z".to_owned(),
        metadata_json: r#"{"ok":true}"#.to_owned(),
    }
}

fn hls_artifact_records() -> Vec<PlaybackArtifactRecord> {
    vec![
        artifact_record("opener", "videos/asset-123/opener.mp4", "video/mp4"),
        artifact_record(
            "manifest",
            "videos/asset-123/hls/master.m3u8",
            "application/vnd.apple.mpegurl",
        ),
        artifact_record(
            "segment",
            "videos/asset-123/hls/segment_00002.ts",
            "video/mp2t",
        ),
        artifact_record(
            "segment",
            "videos/asset-123/hls/segment_00000.ts",
            "video/mp2t",
        ),
        artifact_record(
            "segment",
            "videos/asset-123/hls/segment_00001.ts",
            "video/mp2t",
        ),
    ]
}

async fn route_response(app: Router, path: &str, auth: Option<&str>) -> Response {
    route_response_with_method(app, "GET", path, auth).await
}

async fn route_response_with_method(
    app: Router,
    method: &str,
    path: &str,
    auth: Option<&str>,
) -> Response {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(auth) = auth {
        builder = builder.header(header::AUTHORIZATION, auth);
    }

    app.oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn post_internal_telemetry(
    app: Router,
    body: impl Into<Body>,
    token: Option<&str>,
) -> Response {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/internal/telemetry/playback")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header("x-rend-internal-token", token);
    }

    app.oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap()
}

async fn post_internal_edge_register(
    app: Router,
    body: impl Into<Body>,
    token: Option<&str>,
) -> Response {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/internal/edges/register")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header("x-rend-internal-token", token);
    }

    app.oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap()
}

async fn post_internal_operator(
    app: Router,
    path: &str,
    body: impl Into<Body>,
    token: Option<&str>,
) -> Response {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-rend-operator-user-id", LOCAL_ADMIN_USER_ID)
        .header("x-rend-operator-email", "admin@rend.test");
    if let Some(token) = token {
        builder = builder.header("x-rend-site-token", token);
    }

    app.oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap()
}

async fn post_video_with_headers(
    app: Router,
    body: impl Into<Body>,
    auth: Option<&str>,
    content_length: Option<&str>,
) -> Response {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/v1/videos")
        .header(header::CONTENT_TYPE, "video/mp4");
    if let Some(auth) = auth {
        builder = builder.header(header::AUTHORIZATION, auth);
    }
    if let Some(content_length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, content_length);
    }

    app.oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap()
}

#[test]
fn bearer_authorization_accepts_matching_dev_key() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer dev-secret"),
    );

    assert!(is_authorized(&headers, "dev-secret"));
}

#[test]
fn bearer_authorization_rejects_missing_or_wrong_key() {
    assert!(!is_authorized(&HeaderMap::new(), "dev-secret"));

    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer wrong-secret"),
    );

    assert!(!is_authorized(&headers, "dev-secret"));
}

#[test]
fn api_key_hashing_is_deterministic_hex() {
    let hash = hash_api_key("rend_test_secret");

    assert_eq!(hash, hash_api_key("rend_test_secret"));
    assert_eq!(hash.len(), 64);
    assert!(!hash.contains("rend_test_secret"));
}

#[test]
fn request_auth_scope_checks_gate_mutations() {
    let read_only = RequestAuth {
        organization_id: LOCAL_ORG_ID.to_owned(),
        scopes: [ApiScope::Read].into_iter().collect(),
        credential: RequestCredential::ApiKey,
    };

    assert!(require_scope(&read_only, ApiScope::Read).is_ok());
    let Err(error) = require_scope(&read_only, ApiScope::Delete) else {
        panic!("read-only auth unexpectedly had delete scope");
    };
    assert_eq!(error.status, StatusCode::FORBIDDEN);
}

#[test]
fn site_internal_auth_can_read_suspended_state_for_dashboard() {
    let site_auth = RequestAuth::all(LOCAL_ORG_ID, RequestCredential::SiteInternal);
    let api_auth = RequestAuth::all(LOCAL_ORG_ID, RequestCredential::ApiKey);

    assert!(site_auth.allows_suspended_reads());
    assert!(!api_auth.allows_suspended_reads());
}

#[test]
fn parse_api_scopes_rejects_unknown_or_empty_scope_sets() {
    assert_eq!(
        parse_api_scopes(vec!["read".to_owned(), "analytics".to_owned()]).unwrap(),
        [ApiScope::Read, ApiScope::Analytics].into_iter().collect()
    );
    assert!(parse_api_scopes(Vec::new()).is_err());
    assert!(parse_api_scopes(vec!["unknown".to_owned()]).is_err());
}

#[tokio::test]
async fn site_internal_token_auth_sets_request_org_and_all_scopes() {
    let state = test_state();
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-rend-site-token",
        HeaderValue::from_static("site-internal"),
    );
    headers.insert(
        "x-rend-organization-id",
        HeaderValue::from_static("00000000-0000-0000-0000-0000000000ab"),
    );

    let auth = authenticate_request(&state, &headers)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(auth.organization_id, "00000000-0000-0000-0000-0000000000ab");
    assert!(auth.has_scope(ApiScope::Upload));
    assert!(auth.has_scope(ApiScope::Read));
    assert!(auth.has_scope(ApiScope::Delete));
    assert!(auth.has_scope(ApiScope::Analytics));
}

#[tokio::test]
async fn local_dev_key_auth_uses_seeded_local_org() {
    let state = test_state();
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer dev-secret"),
    );

    let auth = authenticate_request(&state, &headers)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(auth.organization_id, LOCAL_ORG_ID);
    assert!(auth.has_scope(ApiScope::Upload));
}

#[tokio::test]
async fn playback_bootstrap_endpoint_requires_dev_api_key() {
    let app = build_app(test_state(), Duration::from_secs(10));

    let response = route_response(app.clone(), "/v1/assets/asset-123/playback", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = route_response(
        app,
        "/v1/assets/asset-123/playback",
        Some("Bearer wrong-secret"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn current_asset_endpoint_requires_dev_api_key() {
    let app = build_app(test_state(), Duration::from_secs(10));

    let response = route_response(app.clone(), "/v1/assets/asset-123", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = route_response(app, "/v1/assets/asset-123", Some("Bearer wrong-secret")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_assets_endpoint_requires_dev_api_key() {
    let app = build_app(test_state(), Duration::from_secs(10));

    let response = route_response(app.clone(), "/v1/assets", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = route_response(app, "/v1/assets", Some("Bearer wrong-secret")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn delete_asset_endpoint_requires_dev_api_key() {
    let app = build_app(test_state(), Duration::from_secs(10));

    let response =
        route_response_with_method(app.clone(), "DELETE", "/v1/assets/asset-123", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = route_response_with_method(
        app,
        "DELETE",
        "/v1/assets/asset-123",
        Some("Bearer wrong-secret"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn asset_events_endpoint_requires_dev_api_key() {
    let app = build_app(test_state(), Duration::from_secs(10));

    let response = route_response(app.clone(), "/v1/assets/asset-123/events", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = route_response(
        app,
        "/v1/assets/asset-123/events",
        Some("Bearer wrong-secret"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn event_stream_endpoint_requires_dev_api_key() {
    let app = build_app(test_state(), Duration::from_secs(10));

    let response = route_response(app.clone(), "/v1/events", None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = route_response(app, "/v1/events", Some("Bearer wrong-secret")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn playback_analytics_endpoint_requires_dev_api_key() {
    let app = build_app(test_state(), Duration::from_secs(10));

    let response = route_response(
        app.clone(),
        "/v1/assets/00000000-0000-0000-0000-000000000001/analytics/playback",
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = route_response(
        app,
        "/v1/assets/00000000-0000-0000-0000-000000000001/analytics/playback",
        Some("Bearer wrong-secret"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn internal_playback_telemetry_requires_internal_token() {
    let app = build_app(test_state(), Duration::from_secs(10));
    let body = serde_json::json!({"events": []}).to_string();

    let response = post_internal_telemetry(app.clone(), body.clone(), None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = post_internal_telemetry(app, body, Some("wrong-token")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn internal_edge_registration_requires_internal_token() {
    let app = build_app(test_state(), Duration::from_secs(10));
    let body = serde_json::json!({
        "edge_id": "edge-1",
        "region": "local",
        "base_url": "http://127.0.0.1:4100",
        "status": "healthy"
    })
    .to_string();

    let response = post_internal_edge_register(app.clone(), body.clone(), None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = post_internal_edge_register(app, body, Some("wrong-token")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn internal_operator_routes_require_site_internal_token() {
    let app = build_app(test_state(), Duration::from_secs(10));
    let body = serde_json::json!({"reason":"abuse report"}).to_string();
    let path = "/internal/operator/assets/00000000-0000-0000-0000-000000000001/suspend";

    let response = post_internal_operator(app.clone(), path, body.clone(), None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = post_internal_operator(app, path, body, Some("wrong-token")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn internal_playback_telemetry_rejects_unknown_secret_fields() {
    let app = build_app(test_state(), Duration::from_secs(10));
    let body = serde_json::json!({
        "events": [{
            "event_id": "evt-1",
            "observed_at": "2026-06-13T12:00:00.000Z",
            "asset_id": "00000000-0000-0000-0000-000000000001",
            "artifact_path": "hls/master.m3u8",
            "edge_id": "edge-1",
            "region": "local",
            "cache_status": "MISS",
            "status_code": 200,
            "bytes_served": 123,
            "content_type": "application/vnd.apple.mpegurl",
            "duration_ms": 12,
            "authorization": "Bearer secret"
        }]
    })
    .to_string();

    let response = post_internal_telemetry(app, body, Some("internal")).await;

    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[test]
fn current_asset_unknown_asset_returns_404() {
    let Err(error) = asset_current_response(None, Vec::new()) else {
        panic!("unknown asset unexpectedly returned current state JSON");
    };

    assert_eq!(error.status, StatusCode::NOT_FOUND);
    assert_eq!(error.message, "asset not found");
}

#[test]
fn current_asset_returns_artifact_summary() {
    let response = asset_current_response(
        Some(asset_state_record("hls_ready")),
        vec![
            AssetArtifactSummary {
                kind: "opener".to_owned(),
                content_type: "video/mp4".to_owned(),
                byte_size: Some(123),
            },
            AssetArtifactSummary {
                kind: "manifest".to_owned(),
                content_type: "application/vnd.apple.mpegurl".to_owned(),
                byte_size: Some(456),
            },
        ],
    )
    .unwrap();

    assert_eq!(response.asset_id, "asset-123");
    assert_eq!(response.source_state, "uploaded");
    assert_eq!(response.playable_state, "hls_ready");
    assert_eq!(response.artifacts.len(), 2);
    assert_eq!(response.artifacts[0].kind, "opener");
    assert_eq!(response.artifacts[0].content_type, "video/mp4");
    assert_eq!(response.artifacts[0].byte_size, Some(123));
}

#[test]
fn current_asset_rejects_suspended_state_for_api_reads() {
    let mut asset = asset_state_record("hls_ready");
    asset.suspended_at = Some("2026-06-14T10:00:00.000Z".to_owned());
    asset.suspension_reason = Some("abuse".to_owned());

    let Err(error) = ensure_asset_state_record_not_suspended(Some(&asset)) else {
        panic!("suspended asset unexpectedly passed read guard");
    };

    assert_eq!(error.status, StatusCode::FORBIDDEN);
    assert_eq!(error.message, "asset is suspended");
}

#[test]
fn operator_reasons_are_normalized_and_redacted_before_audit() {
    let reason = normalize_operator_reason(
        " unsafe URL https://edge.example/v/asset/opener.mp4?token=secret\nAuthorization: Bearer abc ",
    )
    .unwrap();

    assert!(reason.contains("[redacted-url]"));
    assert!(reason.contains("[redacted-secret]"));
    assert!(!reason.contains("edge.example"));
    assert!(!reason.contains("token=secret"));
    assert!(!reason.contains("Bearer abc"));
}

#[test]
fn delete_asset_normalizes_uuid_and_rejects_malformed_id() {
    assert_eq!(
        normalize_asset_id("00000000-0000-0000-0000-000000000ABC").unwrap(),
        "00000000-0000-0000-0000-000000000abc"
    );

    let Err(error) = normalize_asset_id("not-a-uuid") else {
        panic!("malformed asset id unexpectedly normalized");
    };
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert_eq!(error.message, "malformed asset_id");
}

#[test]
fn delete_origin_cleanup_only_accepts_rend_owned_asset_prefix() {
    let asset_id = "00000000-0000-0000-0000-0000000000ab";

    assert!(is_rend_owned_asset_object_key(
        asset_id,
        "videos/00000000-0000-0000-0000-0000000000ab/hls/master.m3u8"
    ));
    assert!(!is_rend_owned_asset_object_key(
        asset_id,
        "videos/00000000-0000-0000-0000-0000000000ac/hls/master.m3u8"
    ));
    assert!(!is_rend_owned_asset_object_key(
        asset_id,
        "videos/00000000-0000-0000-0000-0000000000ab/../other"
    ));
}

#[test]
fn asset_events_unknown_asset_returns_404() {
    let Err(error) = asset_events_response(false, "asset-123".to_owned(), Vec::new()) else {
        panic!("unknown asset unexpectedly returned lifecycle events");
    };

    assert_eq!(error.status, StatusCode::NOT_FOUND);
    assert_eq!(error.message, "asset not found");
}

#[test]
fn asset_events_response_orders_by_sequence() {
    let response = asset_events_response(
        true,
        "asset-123".to_owned(),
        vec![
            event_record(3, events::EVENT_SOURCE_UPLOADED),
            event_record(1, events::EVENT_ASSET_CREATED),
            event_record(2, events::EVENT_SOURCE_UPLOAD_STARTED),
        ],
    )
    .unwrap();

    let sequences = response
        .events
        .iter()
        .map(|event| event.sequence)
        .collect::<Vec<_>>();
    assert_eq!(sequences, vec![1, 2, 3]);
    assert_eq!(response.next_after_sequence, Some(3));
}

#[test]
fn asset_events_query_clamps_after_sequence_and_limit() {
    assert_eq!(
        normalize_asset_events_query(AssetEventsQuery {
            after_sequence: Some(-10),
            limit: Some(0),
        }),
        NormalizedAssetEventsQuery {
            after_sequence: 0,
            limit: 1,
        }
    );
    assert_eq!(
        normalize_asset_events_query(AssetEventsQuery {
            after_sequence: Some(12),
            limit: Some(MAX_ASSET_EVENTS_LIMIT + 500),
        }),
        NormalizedAssetEventsQuery {
            after_sequence: 12,
            limit: MAX_ASSET_EVENTS_LIMIT,
        }
    );
}

#[test]
fn event_stream_query_uses_after_sequence() {
    let query = normalize_event_stream_query(
        &HeaderMap::new(),
        EventStreamQuery {
            asset_id: None,
            after_sequence: Some("12".to_owned()),
        },
    )
    .unwrap();

    assert_eq!(query.after_sequence, 12);
    assert_eq!(query.asset_id, None);
}

#[test]
fn event_stream_last_event_id_takes_precedence() {
    let mut headers = HeaderMap::new();
    headers.insert("last-event-id", HeaderValue::from_static("20"));

    let query = normalize_event_stream_query(
        &headers,
        EventStreamQuery {
            asset_id: None,
            after_sequence: Some("12".to_owned()),
        },
    )
    .unwrap();

    assert_eq!(query.after_sequence, 20);
}

#[test]
fn event_stream_rejects_invalid_cursor_and_asset_id() {
    let Err(error) = normalize_event_stream_query(
        &HeaderMap::new(),
        EventStreamQuery {
            asset_id: None,
            after_sequence: Some("not-a-sequence".to_owned()),
        },
    ) else {
        panic!("invalid cursor unexpectedly parsed");
    };
    assert_eq!(error.status, StatusCode::BAD_REQUEST);

    let Err(error) = normalize_event_stream_query(
        &HeaderMap::new(),
        EventStreamQuery {
            asset_id: Some("not-a-uuid".to_owned()),
            after_sequence: None,
        },
    ) else {
        panic!("invalid asset_id unexpectedly parsed");
    };
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
}

#[test]
fn event_stream_sse_frame_uses_sequence_id_and_event_type_name() {
    let record = event_record(42, events::EVENT_SOURCE_UPLOADED);
    let frame = sse_frame(&record).unwrap();
    let frame = std::str::from_utf8(&frame).unwrap();

    assert!(frame.starts_with("id: 42\nevent: source.uploaded\ndata: "));
    assert!(frame.ends_with("\n\n"));

    let data = frame
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let payload: Value = serde_json::from_str(data).unwrap();
    assert_eq!(payload["id"], "event-42");
    assert_eq!(payload["asset_id"], "asset-123");
    assert_eq!(payload["sequence"], 42);
    assert_eq!(payload["event_type"], events::EVENT_SOURCE_UPLOADED);
    assert_eq!(payload["created_at"], "2026-06-13T12:00:00.000Z");
    assert_eq!(payload["metadata"], serde_json::json!({"ok": true}));
}

#[test]
fn event_stream_after_sequence_and_asset_id_filter_exclude_records() {
    let query = NormalizedEventStreamQuery {
        asset_id: Some("asset-123".to_owned()),
        after_sequence: 10,
    };

    assert!(event_stream_record_matches(
        &event_record_for_asset("asset-123", 11, events::EVENT_SOURCE_UPLOADED),
        &query
    ));
    assert!(!event_stream_record_matches(
        &event_record_for_asset("asset-123", 10, events::EVENT_SOURCE_UPLOADED),
        &query
    ));
    assert!(!event_stream_record_matches(
        &event_record_for_asset(
            "00000000-0000-0000-0000-000000000000",
            11,
            events::EVENT_SOURCE_UPLOADED,
        ),
        &query
    ));
}

#[test]
fn event_stream_metadata_is_external_safe() {
    let mut record = event_record(7, events::EVENT_ARTIFACT_GENERATED);
    record.metadata_json = serde_json::json!({
        "kind": "opener",
        "artifact_path": "opener.mp4",
        "playback_url": "http://edge.local/v/asset/opener.mp4?token=abc",
        "nested": {
            "authorization": "Bearer abc",
            "reason": "safe failure reason",
            "credential_hint": "do not leak",
        },
        "messages": [
            "plain",
            "signed url had ?token=abc"
        ]
    })
    .to_string();

    let frame = sse_frame(&record).unwrap();
    let frame = std::str::from_utf8(&frame).unwrap();
    let data = frame
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .unwrap();
    let encoded = data.to_ascii_lowercase();

    for forbidden in [
        "playback_url",
        "?token=",
        "bearer ",
        "authorization",
        "credential",
    ] {
        assert!(!encoded.contains(forbidden), "{forbidden}");
    }
    assert!(encoded.contains("opener.mp4"));
    assert!(encoded.contains("[redacted]"));
}

#[test]
fn upload_media_flow_records_required_lifecycle_event_types() {
    let artifacts = vec![
        events::ArtifactEventInput {
            kind: "opener",
            object_key: "videos/asset-123/opener.mp4",
            content_type: "video/mp4",
            byte_size: 100,
        },
        events::ArtifactEventInput {
            kind: "manifest",
            object_key: "videos/asset-123/hls/master.m3u8",
            content_type: "application/vnd.apple.mpegurl",
            byte_size: 50,
        },
        events::ArtifactEventInput {
            kind: "segment",
            object_key: "videos/asset-123/hls/segment_00000.ts",
            content_type: "video/mp2t",
            byte_size: 25,
        },
    ];
    let artifact_events = events::artifact_generated_events("asset-123", &artifacts);
    let mut event_types = vec![
        events::EVENT_ASSET_CREATED,
        events::EVENT_SOURCE_UPLOAD_STARTED,
        events::EVENT_SOURCE_UPLOADED,
        events::EVENT_MEDIA_PROCESSING_QUEUED,
        events::EVENT_UPLOAD_RESPONSE_READY,
        events::EVENT_MEDIA_PROCESSING_STARTED,
    ];
    event_types.extend(artifact_events.iter().map(|event| event.event_type));
    event_types.extend([
        events::EVENT_PLAYABLE_STATE_CHANGED,
        events::EVENT_EDGE_WARMING_ATTEMPTED,
        events::EVENT_EDGE_WARMING_SUCCEEDED,
        events::EVENT_UPLOAD_RESPONSE_READY,
        events::EVENT_ASSET_DELETION_REQUESTED,
        events::EVENT_ASSET_DELETED,
        events::EVENT_EDGE_PURGE_ATTEMPTED,
        events::EVENT_EDGE_PURGE_SUCCEEDED,
    ]);

    for required in [
        events::EVENT_ASSET_CREATED,
        events::EVENT_SOURCE_UPLOAD_STARTED,
        events::EVENT_SOURCE_UPLOADED,
        events::EVENT_MEDIA_PROCESSING_QUEUED,
        events::EVENT_UPLOAD_RESPONSE_READY,
        events::EVENT_MEDIA_PROCESSING_STARTED,
        events::EVENT_ARTIFACT_GENERATED,
        events::EVENT_PLAYABLE_STATE_CHANGED,
        events::EVENT_EDGE_WARMING_ATTEMPTED,
        events::EVENT_EDGE_WARMING_SUCCEEDED,
        events::EVENT_ASSET_DELETION_REQUESTED,
        events::EVENT_ASSET_DELETED,
        events::EVENT_EDGE_PURGE_ATTEMPTED,
        events::EVENT_EDGE_PURGE_SUCCEEDED,
    ] {
        assert!(event_types.contains(&required), "{required}");
    }
}

#[test]
fn playback_bootstrap_unknown_asset_returns_404() {
    let result =
        playback_bootstrap_response(None, &[], "http://127.0.0.1:4100", &test_issuer(), 2, NOW);
    let Err(error) = result else {
        panic!("unknown asset unexpectedly returned bootstrap JSON");
    };

    assert_eq!(error.status, StatusCode::NOT_FOUND);
    assert_eq!(error.message, "asset not found");
}

#[test]
fn playback_bootstrap_not_playable_asset_returns_404() {
    let result = playback_bootstrap_response(
        Some(asset_record("not_playable")),
        &[],
        "http://127.0.0.1:4100",
        &test_issuer(),
        2,
        NOW,
    );
    let Err(error) = result else {
        panic!("not playable asset unexpectedly returned bootstrap JSON");
    };

    assert_eq!(error.status, StatusCode::NOT_FOUND);
    assert_eq!(error.message, "asset is not playable yet");
}

#[test]
fn playback_bootstrap_ready_asset_without_artifact_returns_404() {
    let result = playback_bootstrap_response(
        Some(asset_record("opener_ready")),
        &[],
        "http://127.0.0.1:4100",
        &test_issuer(),
        2,
        NOW,
    );
    let Err(error) = result else {
        panic!("ready asset without artifacts unexpectedly returned bootstrap JSON");
    };

    assert_eq!(error.status, StatusCode::NOT_FOUND);
    assert_eq!(error.message, "asset is not playable yet");
}

#[test]
fn playback_bootstrap_hls_ready_returns_manifest_opener_and_segment_hints() {
    let response = playback_bootstrap_response(
        Some(asset_record("hls_ready")),
        &hls_artifact_records(),
        "http://127.0.0.1:4100/",
        &test_issuer(),
        2,
        NOW,
    )
    .unwrap();

    assert_eq!(response.asset_id, "asset-123");
    assert_eq!(response.source_state, "uploaded");
    assert_eq!(response.playable_state, "hls_ready");
    assert_eq!(response.ttl_seconds, 600);
    assert_eq!(response.playback_token_expires_at, NOW + 600);
    assert_eq!(response.playback_url, response.manifest_url);
    assert_eq!(
        response.playback_content_type.as_deref(),
        Some("application/vnd.apple.mpegurl")
    );
    assert_eq!(
        response.opener_url.as_deref().map(url_without_token),
        Some("http://127.0.0.1:4100/v/asset-123/opener.mp4".to_owned())
    );
    assert_eq!(response.opener_content_type.as_deref(), Some("video/mp4"));
    assert_eq!(
        response.manifest_url.as_deref().map(url_without_token),
        Some("http://127.0.0.1:4100/v/asset-123/hls/master.m3u8".to_owned())
    );
    assert_eq!(response.prefetch_hints.len(), 2);
    assert_eq!(
        response.prefetch_hints[0].artifact_path,
        "hls/segment_00000.ts"
    );
    assert_eq!(response.prefetch_hints[0].content_type, "video/mp2t");
    assert_eq!(
        response.prefetch_hints[1].artifact_path,
        "hls/segment_00001.ts"
    );
}

#[test]
fn playback_bootstrap_opener_ready_returns_opener_primary_without_manifest() {
    let response = playback_bootstrap_response(
        Some(asset_record("opener_ready")),
        &hls_artifact_records(),
        "http://127.0.0.1:4100",
        &test_issuer(),
        2,
        NOW,
    )
    .unwrap();

    assert_eq!(
        response.playback_url.as_deref().map(url_without_token),
        Some("http://127.0.0.1:4100/v/asset-123/opener.mp4".to_owned())
    );
    assert_eq!(response.playback_content_type.as_deref(), Some("video/mp4"));
    assert!(response.manifest_url.is_none());
    assert!(response.manifest_content_type.is_none());
    assert!(response.prefetch_hints.is_empty());
}

#[test]
fn playback_bootstrap_urls_are_tokenless_and_cookie_carries_playback_token() {
    let response = playback_bootstrap_response(
        Some(asset_record("hls_ready")),
        &hls_artifact_records(),
        "https://edge.local",
        &test_issuer(),
        1,
        NOW,
    )
    .unwrap();
    let playback_url = response.playback_url.as_deref().unwrap();
    let claims = decode_unverified_claims(&response.playback_token).unwrap();
    let serialized = serde_json::to_string(&response).unwrap();
    let cookie = playback_cookie_header(
        &response.playback_token,
        response.ttl_seconds,
        "https://edge.local",
    );

    assert_eq!(
        playback_url,
        "https://edge.local/v/asset-123/hls/master.m3u8"
    );
    assert!(!serialized.contains("?token="), "{serialized}");
    assert!(
        !serialized.contains(&response.playback_token),
        "{serialized}"
    );
    assert!(cookie.starts_with("__rend_playback="));
    assert!(cookie.contains("; HttpOnly"));
    assert!(cookie.contains("; Secure"));
    assert_eq!(claims.asset_id, "asset-123");
    assert_eq!(claims.exp, NOW + 600);
    assert_eq!(claims.kid, "kid-a");
    assert_eq!(claims.policy, POLICY_ASSET_PLAYBACK_V1);
}

#[test]
fn playback_bootstrap_prefetch_hints_are_bounded() {
    let response = playback_bootstrap_response(
        Some(asset_record("hls_ready")),
        &hls_artifact_records(),
        "http://edge.local",
        &test_issuer(),
        1,
        NOW,
    )
    .unwrap();

    assert_eq!(response.prefetch_hints.len(), 1);
    assert_eq!(
        response.prefetch_hints[0].artifact_path,
        "hls/segment_00000.ts"
    );
}

#[test]
fn source_object_key_is_deterministic_and_internal() {
    assert_eq!(
        source_object_key("asset-123"),
        "videos/asset-123/source".to_owned()
    );
}

#[test]
fn playback_url_uses_tokenless_hls_edge_shape() {
    let issuer = PlaybackTokenIssuer::new(
        SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap(),
        Duration::from_secs(600),
    )
    .unwrap();
    let url = playback_url(
        "http://127.0.0.1:4100/",
        "asset-123",
        "hls_ready",
        &issuer,
        1_800_000_000,
    )
    .unwrap()
    .unwrap();

    assert_eq!(url, "http://127.0.0.1:4100/v/asset-123/hls/master.m3u8");
    assert!(!url.contains("?token="), "{url}");
}

#[test]
fn playback_url_is_absent_until_playable() {
    let issuer = PlaybackTokenIssuer::new(
        SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap(),
        Duration::from_secs(600),
    )
    .unwrap();
    let url = playback_url(
        "http://127.0.0.1:4100/",
        "asset-123",
        "not_playable",
        &issuer,
        1_800_000_000,
    )
    .unwrap();

    assert_eq!(url, None);
}

#[test]
fn edge_warm_request_is_absent_when_no_artifacts_are_selected() {
    let generated = vec!["hls/segment_00000.ts".to_owned()];

    assert!(edge_warm_request("asset-123", "not_playable", &generated, 4).is_none());
}

#[test]
fn edge_warm_artifact_paths_select_opener_manifest_and_first_segments() {
    let generated = vec![
        "hls/segment_00002.ts".to_owned(),
        "hls/segment_00000.ts".to_owned(),
        "thumbnail.jpg".to_owned(),
        "hls/segment_00001.ts".to_owned(),
    ];

    assert_eq!(
        edge_warm_artifact_paths("hls_ready", &generated, 4),
        vec![
            "opener.mp4".to_owned(),
            "hls/master.m3u8".to_owned(),
            "hls/segment_00000.ts".to_owned(),
            "hls/segment_00001.ts".to_owned(),
        ]
    );
}

#[test]
fn edge_warm_artifact_paths_skip_unplayable_states() {
    assert!(edge_warm_artifact_paths("failed", &[], 4).is_empty());
    assert!(edge_warm_artifact_paths("not_playable", &[], 4).is_empty());
}

#[test]
fn edge_registry_validation_normalizes_safe_values() {
    assert_eq!(
        normalize_edge_name("edge_id", " rend-edge.us-east-1 ").unwrap(),
        "rend-edge.us-east-1"
    );
    assert_eq!(
        normalize_edge_base_url(
            &EdgeRegistryConfig {
                internal_token: "internal".to_owned(),
                active_heartbeat_window: Duration::from_secs(120),
                expected_edges: ExpectedEdges::default(),
                rend_env: RendEnv::Local,
                allow_insecure_edge_urls: false,
            },
            "http://127.0.0.1:4100/"
        )
        .unwrap(),
        "http://127.0.0.1:4100"
    );
    assert_eq!(
        normalize_edge_status(Some("HEALTHY"), "registered").unwrap(),
        "healthy"
    );
    assert_eq!(normalize_cache_max_bytes(Some(1024)).unwrap(), Some(1024));
}

#[test]
fn edge_registry_validation_rejects_secret_bearing_base_urls() {
    let registry = EdgeRegistryConfig {
        internal_token: "internal".to_owned(),
        active_heartbeat_window: Duration::from_secs(120),
        expected_edges: ExpectedEdges::default(),
        rend_env: RendEnv::Local,
        allow_insecure_edge_urls: false,
    };
    let error =
        normalize_edge_base_url(&registry, "https://user:secret@edge.example.com").unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);

    let error =
        normalize_edge_base_url(&registry, "https://edge.example.com?token=secret").unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
}

#[test]
fn strict_edge_registry_requires_https_base_urls() {
    let registry = EdgeRegistryConfig {
        internal_token: "internal".to_owned(),
        active_heartbeat_window: Duration::from_secs(120),
        expected_edges: ExpectedEdges::default(),
        rend_env: RendEnv::Production,
        allow_insecure_edge_urls: false,
    };

    let error = normalize_edge_base_url(&registry, "http://edge.example.com").unwrap_err();

    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert!(error.message.contains("https"));
}

#[test]
fn expected_edge_registration_rejects_unknown_or_changed_edges() {
    let expected_edges = ExpectedEdges::parse(
        "edge-a=us-east=https://edge-a.example.com",
        RendEnv::Production,
        false,
    )
    .unwrap();
    let registry = EdgeRegistryConfig {
        internal_token: "internal".to_owned(),
        active_heartbeat_window: Duration::from_secs(120),
        expected_edges,
        rend_env: RendEnv::Production,
        allow_insecure_edge_urls: false,
    };

    validate_expected_edge_registration(
        &registry,
        "edge-a",
        "us-east",
        "https://edge-a.example.com",
    )
    .unwrap();

    assert_eq!(
        validate_expected_edge_registration(
            &registry,
            "edge-b",
            "us-east",
            "https://edge-b.example.com"
        )
        .unwrap_err()
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        validate_expected_edge_registration(
            &registry,
            "edge-a",
            "us-east",
            "https://changed.example.com"
        )
        .unwrap_err()
        .status,
        StatusCode::BAD_REQUEST
    );
}

#[test]
fn fanout_skips_untrusted_registry_rows() {
    let expected_edges = ExpectedEdges::parse(
        "edge-a=us-east=https://edge-a.example.com",
        RendEnv::Production,
        false,
    )
    .unwrap();
    let registry = EdgeRegistryConfig {
        internal_token: "internal".to_owned(),
        active_heartbeat_window: Duration::from_secs(120),
        expected_edges,
        rend_env: RendEnv::Production,
        allow_insecure_edge_urls: false,
    };

    assert!(registered_edge_is_trusted(
        &registry,
        &RegisteredEdgeNode {
            edge_id: "edge-a".to_owned(),
            region: "us-east".to_owned(),
            base_url: "https://edge-a.example.com".to_owned(),
        }
    ));
    assert!(!registered_edge_is_trusted(
        &registry,
        &RegisteredEdgeNode {
            edge_id: "edge-a".to_owned(),
            region: "us-east".to_owned(),
            base_url: "https://changed.example.com".to_owned(),
        }
    ));
}

#[tokio::test]
async fn maybe_warm_edge_posts_when_configured_and_uses_internal_token() {
    let (url, recorder) = spawn_warm_recorder(StatusCode::OK).await;
    let config = EdgeWarmConfig {
        url: Some(url),
        internal_token: "warm-secret".to_owned(),
        max_artifacts: 3,
    };
    let generated = vec![
        "hls/segment_00001.ts".to_owned(),
        "hls/segment_00000.ts".to_owned(),
    ];

    maybe_warm_edge(
        None,
        &reqwest::Client::new(),
        &EdgeRegistryConfig {
            internal_token: "warm-secret".to_owned(),
            active_heartbeat_window: Duration::from_secs(120),
            expected_edges: ExpectedEdges::default(),
            rend_env: RendEnv::Local,
            allow_insecure_edge_urls: false,
        },
        &config,
        "asset-123",
        "hls_ready",
        &generated,
    )
    .await;

    assert_eq!(recorder.count.load(Ordering::SeqCst), 1);
    assert_eq!(
        recorder.last_token.lock().unwrap().as_deref(),
        Some("warm-secret")
    );
    let request = recorder.last_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.asset_id, "asset-123");
    assert_eq!(
        request.artifact_paths,
        vec![
            "opener.mp4".to_owned(),
            "hls/master.m3u8".to_owned(),
            "hls/segment_00000.ts".to_owned(),
        ]
    );
}

#[tokio::test]
async fn maybe_warm_edge_swallows_warm_endpoint_failure() {
    let (url, recorder) = spawn_warm_recorder(StatusCode::INTERNAL_SERVER_ERROR).await;
    let config = EdgeWarmConfig {
        url: Some(url),
        internal_token: "warm-secret".to_owned(),
        max_artifacts: 4,
    };

    maybe_warm_edge(
        None,
        &reqwest::Client::new(),
        &EdgeRegistryConfig {
            internal_token: "warm-secret".to_owned(),
            active_heartbeat_window: Duration::from_secs(120),
            expected_edges: ExpectedEdges::default(),
            rend_env: RendEnv::Local,
            allow_insecure_edge_urls: false,
        },
        &config,
        "asset-123",
        "opener_ready",
        &["opener.mp4".to_owned()],
    )
    .await;

    assert_eq!(recorder.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn warm_fanout_posts_to_every_target_best_effort() {
    let (ok_url, ok_recorder) = spawn_warm_recorder(StatusCode::OK).await;
    let (failed_url, failed_recorder) =
        spawn_warm_recorder(StatusCode::INTERNAL_SERVER_ERROR).await;
    let targets = vec![
        EdgeFanoutTarget {
            edge_id: "edge-ok".to_owned(),
            region: Some("local".to_owned()),
            action_url: ok_url,
            source: "registry",
        },
        EdgeFanoutTarget {
            edge_id: "edge-failed".to_owned(),
            region: Some("backup".to_owned()),
            action_url: failed_url,
            source: "registry",
        },
    ];
    let request = EdgeWarmRequest {
        asset_id: "asset-123".to_owned(),
        artifact_paths: vec!["opener.mp4".to_owned()],
    };

    let results =
        fanout_edge_warm_requests(&reqwest::Client::new(), "warm-secret", &targets, &request).await;

    assert_eq!(ok_recorder.count.load(Ordering::SeqCst), 1);
    assert_eq!(failed_recorder.count.load(Ordering::SeqCst), 1);
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].edge_id, "edge-ok");
    assert_eq!(results[0].status, "succeeded");
    assert_eq!(results[1].edge_id, "edge-failed");
    assert_eq!(results[1].status, "failed");
    assert_eq!(results[1].http_status, Some(500));
}

#[test]
fn content_type_defaults_to_octet_stream() {
    assert_eq!(
        request_content_type(&HeaderMap::new()),
        "application/octet-stream".to_owned()
    );
}

#[test]
fn request_content_length_rejects_uploads_over_limit() {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("11"));

    let error = request_content_length(&headers, 10).unwrap_err();

    assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn counted_upload_body_rejects_streamed_body_over_limit() {
    let byte_count = Arc::new(AtomicU64::new(0));
    let stream = counted_body_stream(Body::from("too large"), byte_count.clone(), 3);

    let result = stream.collect().await;

    assert!(result.is_err());
    assert!(byte_count.load(Ordering::Relaxed) > 3);
}

#[tokio::test]
async fn upload_endpoint_rejects_content_length_over_limit_before_db() {
    let mut config = test_config();
    config.max_upload_bytes = 3;
    let db = PgPoolOptions::new()
        .connect_lazy(&config.database_url)
        .unwrap();
    let s3 = build_s3_client(&config);
    let state = Arc::new(AppState {
        config,
        db,
        http: reqwest::Client::new(),
        s3,
        started_at: Instant::now(),
    });
    let app = build_app(state, Duration::from_secs(10));

    let response =
        post_video_with_headers(app, Body::empty(), Some("Bearer dev-secret"), Some("4")).await;

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn player_harness_route_loads_without_auth() {
    let app = build_app(test_state(), Duration::from_secs(10));
    let response = route_response(app, "/player", None).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(html.contains("<title>Rend local playback</title>"));
}

fn url_without_token(url: &str) -> String {
    url.split_once("?token=")
        .map(|(path, _token)| path)
        .unwrap_or(url)
        .to_owned()
}
