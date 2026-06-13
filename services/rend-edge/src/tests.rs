use super::*;
use axum::body::to_bytes;
use rend_playback_auth::{PlaybackTokenIssuer, SigningKey};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

const NOW: u64 = 1_800_000_000;

#[derive(Clone)]
struct FakeOriginState {
    objects: Arc<Mutex<HashMap<String, FakeOriginObject>>>,
    active_requests: Arc<Mutex<usize>>,
    metrics: FakeOriginMetrics,
}

#[derive(Clone)]
struct FakeOriginMetrics {
    requests: Arc<Mutex<Vec<String>>>,
    max_active_requests: Arc<Mutex<usize>>,
}

#[derive(Clone)]
enum FakeOriginObject {
    Body(Vec<u8>),
    DelayedBody { bytes: Vec<u8>, delay: Duration },
    Error(StatusCode),
    DelayedNoSuchKey { delay: Duration },
}

struct FakeOriginRequestGuard {
    active_requests: Arc<Mutex<usize>>,
}

#[derive(Deserialize)]
struct FakeS3Path {
    bucket: String,
    key: String,
}

fn test_auth() -> (SingleKeyring, PlaybackTokenIssuer) {
    let key = SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap();
    (
        SingleKeyring::from_key(key.clone()),
        PlaybackTokenIssuer::new(key, Duration::from_secs(300)).unwrap(),
    )
}

async fn fake_s3_get(
    State(state): State<FakeOriginState>,
    AxumPath(path): AxumPath<FakeS3Path>,
) -> Response {
    let _guard = track_fake_origin_request(&state);

    state
        .metrics
        .requests
        .lock()
        .unwrap()
        .push(format!("{}/{}", path.bucket, path.key));

    let object = state.objects.lock().unwrap().get(&path.key).cloned();
    if let Some(delay) = object.as_ref().map(FakeOriginObject::delay) {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
    }

    match object {
        Some(FakeOriginObject::Body(bytes)) => (StatusCode::OK, bytes).into_response(),
        Some(FakeOriginObject::DelayedBody { bytes, .. }) => {
            (StatusCode::OK, bytes).into_response()
        }
        Some(FakeOriginObject::Error(status)) => status.into_response(),
        Some(FakeOriginObject::DelayedNoSuchKey { .. }) => no_such_key_response(&path.key),
        None => no_such_key_response(&path.key),
    }
}

fn no_such_key_response(key: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/xml")],
        format!("<Error><Code>NoSuchKey</Code><Key>{key}</Key></Error>"),
    )
        .into_response()
}

async fn spawn_fake_origin(
    objects: HashMap<String, FakeOriginObject>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    let (endpoint, metrics) = spawn_fake_origin_with_metrics(objects).await;
    (endpoint, metrics.requests)
}

async fn spawn_fake_origin_with_metrics(
    objects: HashMap<String, FakeOriginObject>,
) -> (String, FakeOriginMetrics) {
    let metrics = FakeOriginMetrics {
        requests: Arc::new(Mutex::new(Vec::new())),
        max_active_requests: Arc::new(Mutex::new(0)),
    };
    let state = FakeOriginState {
        objects: Arc::new(Mutex::new(objects)),
        active_requests: Arc::new(Mutex::new(0)),
        metrics: metrics.clone(),
    };
    let app = Router::new()
        .route("/{bucket}/{*key}", get(fake_s3_get))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), metrics)
}

impl FakeOriginObject {
    fn delay(&self) -> Duration {
        match self {
            Self::Body(_) | Self::Error(_) => Duration::ZERO,
            Self::DelayedBody { delay, .. } | Self::DelayedNoSuchKey { delay } => *delay,
        }
    }
}

impl FakeOriginMetrics {
    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    fn max_active_requests(&self) -> usize {
        *self.max_active_requests.lock().unwrap()
    }
}

impl Drop for FakeOriginRequestGuard {
    fn drop(&mut self) {
        let mut active_requests = self.active_requests.lock().unwrap();
        *active_requests = active_requests.saturating_sub(1);
    }
}

fn track_fake_origin_request(state: &FakeOriginState) -> FakeOriginRequestGuard {
    let active_now = {
        let mut active_requests = state.active_requests.lock().unwrap();
        *active_requests += 1;
        *active_requests
    };

    let mut max_active_requests = state.metrics.max_active_requests.lock().unwrap();
    *max_active_requests = (*max_active_requests).max(active_now);

    FakeOriginRequestGuard {
        active_requests: state.active_requests.clone(),
    }
}

fn test_cache_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("rend-edge-{name}-{}", temp_file_suffix()))
}

fn test_state(cache_dir: PathBuf, origin_endpoint: String) -> Arc<AppState> {
    test_state_with_max_in_flight(cache_dir, origin_endpoint, DEFAULT_MAX_IN_FLIGHT_FILLS)
}

fn test_state_with_max_in_flight(
    cache_dir: PathBuf,
    origin_endpoint: String,
    max_in_flight_fills: usize,
) -> Arc<AppState> {
    test_state_with_max_in_flight_and_telemetry(
        cache_dir,
        origin_endpoint,
        max_in_flight_fills,
        telemetry::TelemetryConfig::disabled(),
        telemetry::TelemetryHandle::disabled(),
    )
}

fn test_state_with_max_in_flight_and_telemetry(
    cache_dir: PathBuf,
    origin_endpoint: String,
    max_in_flight_fills: usize,
    playback_telemetry: telemetry::TelemetryConfig,
    telemetry: telemetry::TelemetryHandle,
) -> Arc<AppState> {
    let config = EdgeConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        edge_id: "test-edge".to_owned(),
        region: "test".to_owned(),
        cache_dir,
        origin_health_url: format!("{origin_endpoint}/minio/health/ready"),
        s3_endpoint: origin_endpoint,
        s3_region: "us-east-1".to_owned(),
        s3_bucket: "rend-local".to_owned(),
        aws_access_key_id: "test".to_owned(),
        aws_secret_access_key: "test".to_owned(),
        internal_token: "test-internal-token".to_owned(),
        playback_telemetry,
        playback_keyring: test_auth().0,
        warm_max_artifacts: 4,
        max_in_flight_fills,
        cache_max_bytes: None,
        max_origin_artifact_bytes: DEFAULT_MAX_ORIGIN_ARTIFACT_BYTES,
        cache_min_free_bytes: 0,
        control_plane: None,
        request_timeout: Duration::from_secs(10),
    };
    let s3 = build_s3_client(&config);

    Arc::new(AppState {
        config,
        http: reqwest::Client::new(),
        s3,
        in_flight_fills: Arc::new(FillRegistry::default()),
        metrics: Arc::new(EdgeMetrics::default()),
        telemetry,
        started_at: Instant::now(),
    })
}

fn test_state_with_resource_limits(
    cache_dir: PathBuf,
    origin_endpoint: String,
    max_origin_artifact_bytes: u64,
    cache_max_bytes: Option<u64>,
    cache_min_free_bytes: u64,
) -> Arc<AppState> {
    let config = EdgeConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        edge_id: "test-edge".to_owned(),
        region: "test".to_owned(),
        cache_dir,
        origin_health_url: format!("{origin_endpoint}/minio/health/ready"),
        s3_endpoint: origin_endpoint,
        s3_region: "us-east-1".to_owned(),
        s3_bucket: "rend-local".to_owned(),
        aws_access_key_id: "test".to_owned(),
        aws_secret_access_key: "test".to_owned(),
        internal_token: "test-internal-token".to_owned(),
        playback_telemetry: telemetry::TelemetryConfig::disabled(),
        playback_keyring: test_auth().0,
        warm_max_artifacts: 4,
        max_in_flight_fills: DEFAULT_MAX_IN_FLIGHT_FILLS,
        cache_max_bytes,
        max_origin_artifact_bytes,
        cache_min_free_bytes,
        control_plane: None,
        request_timeout: Duration::from_secs(10),
    };
    let s3 = build_s3_client(&config);

    Arc::new(AppState {
        config,
        http: reqwest::Client::new(),
        s3,
        in_flight_fills: Arc::new(FillRegistry::default()),
        metrics: Arc::new(EdgeMetrics::default()),
        telemetry: telemetry::TelemetryHandle::disabled(),
        started_at: Instant::now(),
    })
}

async fn post_warm(app: Router, body: impl Into<Body>, token: Option<&str>) -> Response {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/internal/warm")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header("x-rend-internal-token", token);
    }

    app.oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap()
}

async fn post_purge(app: Router, body: impl Into<Body>, token: Option<&str>) -> Response {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/internal/purge")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header("x-rend-internal-token", token);
    }

    app.oneshot(builder.body(body.into()).unwrap())
        .await
        .unwrap()
}

async fn get_metrics(app: Router, token: Option<&str>) -> Response {
    let mut builder = Request::builder().method("GET").uri("/metrics");
    if let Some(token) = token {
        builder = builder.header("x-rend-internal-token", token);
    }

    app.oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn response_json(response: Response) -> Value {
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn warm_body(asset_id: &str, artifact_paths: &[&str]) -> String {
    serde_json::json!({
        "asset_id": asset_id,
        "artifact_paths": artifact_paths,
    })
    .to_string()
}

fn purge_body(asset_id: &str, artifact_paths: Option<&[&str]>) -> String {
    match artifact_paths {
        Some(artifact_paths) => serde_json::json!({
            "asset_id": asset_id,
            "artifact_paths": artifact_paths,
        }),
        None => serde_json::json!({
            "asset_id": asset_id,
        }),
    }
    .to_string()
}

fn tamper_last_char(value: &str) -> String {
    let mut output = value.to_owned();
    let last = output.pop().unwrap();
    output.push(if last == 'A' { 'B' } else { 'A' });
    output
}

struct PlaybackTestResponse {
    status: StatusCode,
    cache_status: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

fn signed_playback_uri(asset_id: &str, artifact_path: &str) -> String {
    let (_keyring, issuer) = test_auth();
    let token = issuer.issue_asset_playback_token(asset_id, NOW).unwrap();
    format!("/v/{asset_id}/{artifact_path}?token={token}")
}

async fn get_playback(app: Router, uri: impl AsRef<str>) -> PlaybackTestResponse {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri.as_ref())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();

    PlaybackTestResponse {
        status,
        cache_status: headers
            .get("x-rend-cache")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        content_type: headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        body,
    }
}

async fn get_playback_concurrently(
    app: Router,
    uri: String,
    request_count: usize,
) -> Vec<PlaybackTestResponse> {
    let barrier = Arc::new(tokio::sync::Barrier::new(request_count));
    let mut handles = Vec::with_capacity(request_count);
    for _ in 0..request_count {
        let app = app.clone();
        let uri = uri.clone();
        let barrier = barrier.clone();
        handles.push(tokio::spawn(async move {
            barrier.wait().await;
            get_playback(app, uri).await
        }));
    }

    let mut responses = Vec::with_capacity(request_count);
    for handle in handles {
        responses.push(handle.await.unwrap());
    }
    responses
}

async fn wait_for_in_flight_count(state: &AppState, expected: usize) {
    for _ in 0..100 {
        if state.in_flight_fills.len() == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    panic!(
        "timed out waiting for {expected} in-flight fills; last count was {}",
        state.in_flight_fills.len()
    );
}

#[test]
fn maps_opener_to_goal_three_object_and_cache_key() {
    assert_eq!(
        map_playback_artifact("asset-123", "opener.mp4").unwrap(),
        PlaybackArtifact {
            object_key: "videos/asset-123/opener.mp4".to_owned(),
            cache_key: "videos/asset-123/opener.mp4".to_owned(),
            content_type: "video/mp4",
        }
    );
}

#[test]
fn maps_hls_manifest_to_goal_three_object_and_cache_key() {
    assert_eq!(
        map_playback_artifact("asset-123", "hls/master.m3u8").unwrap(),
        PlaybackArtifact {
            object_key: "videos/asset-123/hls/master.m3u8".to_owned(),
            cache_key: "videos/asset-123/hls/master.m3u8".to_owned(),
            content_type: "application/vnd.apple.mpegurl",
        }
    );
}

#[test]
fn maps_hls_segment_to_goal_three_object_and_cache_key() {
    assert_eq!(
        map_playback_artifact("asset-123", "hls/segment_00000.ts").unwrap(),
        PlaybackArtifact {
            object_key: "videos/asset-123/hls/segment_00000.ts".to_owned(),
            cache_key: "videos/asset-123/hls/segment_00000.ts".to_owned(),
            content_type: "video/mp2t",
        }
    );
}

#[test]
fn rejects_unsupported_artifact_paths() {
    for artifact_path in [
        "source",
        "thumbnail.jpg",
        "hls",
        "hls/",
        "hls/master.m3u8/extra",
        "hls/segment_00000.m4s",
        "hls/segment_abc.ts",
        "hls/nested/segment_00000.ts",
        "../opener.mp4",
        "hls/../opener.mp4",
        "videos/asset-123/opener.mp4",
    ] {
        assert!(
            map_playback_artifact("asset-123", artifact_path).is_err(),
            "{artifact_path} should be rejected"
        );
    }
}

#[test]
fn rejects_unsafe_asset_ids() {
    for asset_id in [
        "",
        ".",
        "..",
        "../asset",
        "asset/123",
        "asset.123",
        "asset%2f123",
    ] {
        assert!(
            map_playback_artifact(asset_id, "opener.mp4").is_err(),
            "{asset_id} should be rejected"
        );
    }
}

#[tokio::test]
async fn warm_rejects_missing_or_wrong_internal_token() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let state = test_state(test_cache_dir("warm-auth"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));
    let body = warm_body("asset-123", &["opener.mp4"]);

    let response = post_warm(app.clone(), body.clone(), None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = post_warm(app, body, Some("wrong-token")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn warm_rejects_malformed_json_request() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let state = test_state(test_cache_dir("warm-malformed"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(app, "{", Some("test-internal-token")).await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn warm_rejects_unsupported_artifact_path() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let state = test_state(test_cache_dir("warm-unsupported"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(
        app,
        warm_body("asset-123", &["thumbnail.jpg"]),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn warm_rejects_unsafe_asset_id() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let state = test_state(test_cache_dir("warm-unsafe-asset"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(
        app,
        warm_body("../asset", &["opener.mp4"]),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn purge_rejects_missing_or_wrong_internal_token() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let state = test_state(test_cache_dir("purge-auth"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));
    let body = purge_body("asset-123", Some(&["opener.mp4"]));

    let response = post_purge(app.clone(), body.clone(), None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = post_purge(app, body, Some("wrong-token")).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn purge_rejects_unsafe_asset_id() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let state = test_state(test_cache_dir("purge-unsafe-asset"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_purge(
        app,
        purge_body("../asset", Some(&["opener.mp4"])),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn purge_explicit_paths_remove_cache_and_report_missing_and_rejected() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let cache_dir = test_cache_dir("purge-explicit");
    let opener_path = cache_dir.join("videos/asset-123/opener.mp4");
    fs::create_dir_all(opener_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&opener_path, b"cached").await.unwrap();
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_purge(
        app,
        purge_body(
            "asset-123",
            Some(&["opener.mp4", "hls/master.m3u8", "thumbnail.jpg"]),
        ),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let json = response_json(response).await;
    assert_eq!(json["asset_id"], "asset-123");
    assert_eq!(json["purged"][0]["artifact_path"], "opener.mp4");
    assert_eq!(json["missing"][0]["artifact_path"], "hls/master.m3u8");
    assert_eq!(json["rejected"][0]["artifact_path"], "thumbnail.jpg");
    assert!(json["errors"].as_array().unwrap().is_empty());
    assert!(!opener_path.exists());
}

#[tokio::test]
async fn purge_omitted_paths_remove_supported_cached_playback_files_only() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let cache_dir = test_cache_dir("purge-all");
    let opener_path = cache_dir.join("videos/asset-123/opener.mp4");
    let manifest_path = cache_dir.join("videos/asset-123/hls/master.m3u8");
    let segment_path = cache_dir.join("videos/asset-123/hls/segment_00000.ts");
    let thumbnail_path = cache_dir.join("videos/asset-123/thumbnail.jpg");
    fs::create_dir_all(manifest_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&opener_path, b"opener").await.unwrap();
    fs::write(&manifest_path, b"manifest").await.unwrap();
    fs::write(&segment_path, b"segment").await.unwrap();
    fs::write(&thumbnail_path, b"thumbnail").await.unwrap();
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_purge(
        app,
        purge_body("asset-123", None),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let json = response_json(response).await;
    let purged = json["purged"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["artifact_path"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(purged.contains(&"opener.mp4"));
    assert!(purged.contains(&"hls/master.m3u8"));
    assert!(purged.contains(&"hls/segment_00000.ts"));
    assert_eq!(json["rejected"][0]["artifact_path"], "thumbnail.jpg");
    assert!(!opener_path.exists());
    assert!(!manifest_path.exists());
    assert!(!segment_path.exists());
    assert!(thumbnail_path.exists());
}

#[tokio::test]
async fn warm_skips_existing_nonempty_cache_file() {
    let (origin_endpoint, requests) = spawn_fake_origin(HashMap::new()).await;
    let cache_dir = test_cache_dir("warm-already");
    let cache_path = cache_dir.join("videos/asset-123/opener.mp4");
    fs::create_dir_all(cache_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&cache_path, b"cached").await.unwrap();
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(
        app,
        warm_body("asset-123", &["opener.mp4"]),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let json = response_json(response).await;
    assert_eq!(json["results"][0]["status"], "already_warm");
    assert_eq!(json["results"][0]["byte_size"], 6);
    assert_eq!(json["summary"]["already_warm"], 1);
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn warm_reports_origin_not_found_per_artifact() {
    let (origin_endpoint, requests) = spawn_fake_origin(HashMap::new()).await;
    let state = test_state(test_cache_dir("warm-not-found"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(
        app,
        warm_body("asset-123", &["opener.mp4"]),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let json = response_json(response).await;
    assert_eq!(json["results"][0]["artifact_path"], "opener.mp4");
    assert_eq!(
        json["results"][0]["object_key"],
        "videos/asset-123/opener.mp4"
    );
    assert_eq!(
        json["results"][0]["cache_key"],
        "videos/asset-123/opener.mp4"
    );
    assert_eq!(json["results"][0]["status"], "not_found");
    assert_eq!(json["summary"]["not_found"], 1);
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        ["rend-local/videos/asset-123/opener.mp4"]
    );
}

#[tokio::test]
async fn warm_reports_origin_failure_per_artifact() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/opener.mp4".to_owned(),
        FakeOriginObject::Error(StatusCode::INTERNAL_SERVER_ERROR),
    );
    let (origin_endpoint, _requests) = spawn_fake_origin(objects).await;
    let state = test_state(test_cache_dir("warm-failed"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(
        app,
        warm_body("asset-123", &["opener.mp4"]),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let json = response_json(response).await;
    assert_eq!(json["results"][0]["status"], "failed");
    assert_eq!(json["summary"]["failed"], 1);
}

#[tokio::test]
async fn warm_fetches_origin_and_writes_same_cache_key_as_playback() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/hls/master.m3u8".to_owned(),
        FakeOriginObject::Body(b"#EXTM3U\n".to_vec()),
    );
    let (origin_endpoint, requests) = spawn_fake_origin(objects).await;
    let cache_dir = test_cache_dir("warm-success");
    let cache_path = cache_dir.join("videos/asset-123/hls/master.m3u8");
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(
        app,
        warm_body("asset-123", &["hls/master.m3u8"]),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let json = response_json(response).await;
    assert_eq!(json["results"][0]["artifact_path"], "hls/master.m3u8");
    assert_eq!(
        json["results"][0]["object_key"],
        "videos/asset-123/hls/master.m3u8"
    );
    assert_eq!(
        json["results"][0]["cache_key"],
        "videos/asset-123/hls/master.m3u8"
    );
    assert_eq!(json["results"][0]["status"], "warmed");
    assert_eq!(json["results"][0]["byte_size"], 8);
    assert_eq!(json["summary"]["warmed"], 1);
    assert_eq!(fs::read(cache_path).await.unwrap(), b"#EXTM3U\n");
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        ["rend-local/videos/asset-123/hls/master.m3u8"]
    );
}

#[tokio::test]
async fn playback_serves_existing_cache_hit_without_origin() {
    let (origin_endpoint, requests) = spawn_fake_origin(HashMap::new()).await;
    let cache_dir = test_cache_dir("playback-hit");
    let cache_path = cache_dir.join("videos/asset-123/opener.mp4");
    fs::create_dir_all(cache_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&cache_path, b"cached-opener").await.unwrap();
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let response = get_playback(app, signed_playback_uri("asset-123", "opener.mp4")).await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.cache_status.as_deref(), Some("HIT"));
    assert_eq!(response.content_type.as_deref(), Some("video/mp4"));
    assert_eq!(response.body, b"cached-opener");
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn playback_succeeds_when_telemetry_ingest_is_down() {
    let (origin_endpoint, requests) = spawn_fake_origin(HashMap::new()).await;
    let cache_dir = test_cache_dir("playback-telemetry-down");
    let cache_path = cache_dir.join("videos/asset-123/opener.mp4");
    fs::create_dir_all(cache_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&cache_path, b"cached-opener").await.unwrap();
    let telemetry_config = telemetry::TelemetryConfig {
        enabled: true,
        ingest_url: Some("http://127.0.0.1:1/internal/telemetry/playback".to_owned()),
        internal_token: "test-internal-token".to_owned(),
        queue_capacity: 1,
        batch_size: 1,
        flush_interval: Duration::from_millis(10),
        request_timeout: Duration::from_millis(50),
        spool_dir: test_cache_dir("playback-telemetry-down-spool"),
        spool_max_bytes: 1024 * 1024,
    };
    let telemetry_handle =
        telemetry::TelemetryHandle::start(telemetry_config.clone(), reqwest::Client::new());
    let state = test_state_with_max_in_flight_and_telemetry(
        cache_dir,
        origin_endpoint,
        DEFAULT_MAX_IN_FLIGHT_FILLS,
        telemetry_config,
        telemetry_handle,
    );
    let app = build_app(state, Duration::from_secs(10));

    let response = get_playback(app, signed_playback_uri("asset-123", "opener.mp4")).await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.cache_status.as_deref(), Some("HIT"));
    assert_eq!(response.body, b"cached-opener");
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn metrics_include_cache_fill_and_telemetry_series() {
    let (origin_endpoint, _requests) = spawn_fake_origin(HashMap::new()).await;
    let cache_dir = test_cache_dir("metrics");
    let cache_path = cache_dir.join("videos/asset-123/opener.mp4");
    fs::create_dir_all(cache_path.parent().unwrap())
        .await
        .unwrap();
    fs::write(&cache_path, b"cached-opener").await.unwrap();
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));

    let hit = get_playback(app.clone(), signed_playback_uri("asset-123", "opener.mp4")).await;
    assert_eq!(hit.status, StatusCode::OK);
    let unauthorized = get_playback(app.clone(), "/v/asset-123/opener.mp4").await;
    assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);

    let response = get_metrics(app, Some("test-internal-token")).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let metrics = String::from_utf8(body.to_vec()).unwrap();
    assert!(metrics.contains("# TYPE rend_edge_cache_requests_total counter"));
    assert!(
        metrics.contains(
            "rend_edge_cache_requests_total{edge_id=\"test-edge\",region=\"test\",cache_status=\"HIT\"} 1"
        )
    );
    assert!(
        metrics.contains(
            "rend_edge_cache_requests_total{edge_id=\"test-edge\",region=\"test\",cache_status=\"error\"} 1"
        )
    );
    assert!(metrics.contains("rend_edge_in_flight_fills{edge_id=\"test-edge\",region=\"test\"} 0"));
    assert!(metrics.contains("rend_edge_telemetry_events_total"));
    assert!(metrics.contains("rend_edge_telemetry_spool_bytes"));
}

#[tokio::test]
async fn playback_miss_fetches_origin_writes_cache_then_hits() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/hls/master.m3u8".to_owned(),
        FakeOriginObject::Body(b"#EXTM3U\n".to_vec()),
    );
    let (origin_endpoint, requests) = spawn_fake_origin(objects).await;
    let cache_dir = test_cache_dir("playback-miss");
    let cache_path = cache_dir.join("videos/asset-123/hls/master.m3u8");
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));
    let uri = signed_playback_uri("asset-123", "hls/master.m3u8");

    let first = get_playback(app.clone(), uri.clone()).await;
    let second = get_playback(app, uri).await;

    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.cache_status.as_deref(), Some("MISS"));
    assert_eq!(
        first.content_type.as_deref(),
        Some("application/vnd.apple.mpegurl")
    );
    assert_eq!(first.body, b"#EXTM3U\n");
    assert_eq!(second.status, StatusCode::OK);
    assert_eq!(second.cache_status.as_deref(), Some("HIT"));
    assert_eq!(second.body, first.body);
    assert_eq!(fs::read(cache_path).await.unwrap(), b"#EXTM3U\n");
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        ["rend-local/videos/asset-123/hls/master.m3u8"]
    );
}

#[tokio::test]
async fn playback_rejects_origin_artifact_over_configured_limit() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/opener.mp4".to_owned(),
        FakeOriginObject::Body(b"too-large".to_vec()),
    );
    let (origin_endpoint, _requests) = spawn_fake_origin(objects).await;
    let cache_dir = test_cache_dir("origin-size-guard");
    let cache_path = cache_dir.join("videos/asset-123/opener.mp4");
    let state = test_state_with_resource_limits(cache_dir, origin_endpoint, 3, None, 0);
    let app = build_app(state, Duration::from_secs(10));

    let response = get_playback(app, signed_playback_uri("asset-123", "opener.mp4")).await;

    assert_eq!(response.status, StatusCode::BAD_GATEWAY);
    assert!(!cache_path.exists());
}

#[tokio::test]
async fn playback_cache_size_guard_rejects_write_before_cache_mutation() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/opener.mp4".to_owned(),
        FakeOriginObject::Body(b"opener-bytes".to_vec()),
    );
    let (origin_endpoint, _requests) = spawn_fake_origin(objects).await;
    let cache_dir = test_cache_dir("cache-size-guard");
    let cache_path = cache_dir.join("videos/asset-123/opener.mp4");
    let state = test_state_with_resource_limits(cache_dir, origin_endpoint, 1024, Some(3), 0);
    let app = build_app(state, Duration::from_secs(10));

    let response = get_playback(app, signed_playback_uri("asset-123", "opener.mp4")).await;

    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!cache_path.exists());
    let json: Value = serde_json::from_slice(&response.body).unwrap();
    assert!(json["error"].as_str().unwrap().contains("cache size guard"));
}

#[tokio::test]
async fn warm_cache_size_guard_reports_failed_entry() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/opener.mp4".to_owned(),
        FakeOriginObject::Body(b"opener-bytes".to_vec()),
    );
    let (origin_endpoint, _requests) = spawn_fake_origin(objects).await;
    let cache_dir = test_cache_dir("warm-cache-size-guard");
    let cache_path = cache_dir.join("videos/asset-123/opener.mp4");
    let state = test_state_with_resource_limits(cache_dir, origin_endpoint, 1024, Some(3), 0);
    let app = build_app(state, Duration::from_secs(10));

    let response = post_warm(
        app,
        warm_body("asset-123", &["opener.mp4"]),
        Some("test-internal-token"),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let json = response_json(response).await;
    assert_eq!(json["results"][0]["status"], "failed");
    assert_eq!(json["summary"]["failed"], 1);
    assert!(!cache_path.exists());
}

#[tokio::test]
async fn concurrent_same_artifact_misses_share_one_origin_fill() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/hls/segment_00000.ts".to_owned(),
        FakeOriginObject::DelayedBody {
            bytes: b"segment-bytes".to_vec(),
            delay: Duration::from_millis(250),
        },
    );
    let (origin_endpoint, metrics) = spawn_fake_origin_with_metrics(objects).await;
    let state = test_state(test_cache_dir("coalesce-same"), origin_endpoint);
    let app = build_app(state.clone(), Duration::from_secs(10));
    let uri = signed_playback_uri("asset-123", "hls/segment_00000.ts");

    let responses = get_playback_concurrently(app, uri, 6).await;

    let miss_count = responses
        .iter()
        .filter(|response| response.cache_status.as_deref() == Some("MISS"))
        .count();
    let coalesced_count = responses
        .iter()
        .filter(|response| response.cache_status.as_deref() == Some("COALESCED"))
        .count();
    assert_eq!(miss_count, 1);
    assert_eq!(coalesced_count, 5);
    for response in &responses {
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(response.body, b"segment-bytes");
    }
    assert_eq!(metrics.request_count(), 1);
    assert_eq!(
        fs::read(
            state
                .config
                .cache_dir
                .join("videos/asset-123/hls/segment_00000.ts")
        )
        .await
        .unwrap(),
        b"segment-bytes"
    );
    assert_eq!(state.in_flight_fills.len(), 0);
}

#[tokio::test]
async fn different_artifact_misses_fill_concurrently() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/opener.mp4".to_owned(),
        FakeOriginObject::DelayedBody {
            bytes: b"opener-bytes".to_vec(),
            delay: Duration::from_millis(250),
        },
    );
    objects.insert(
        "videos/asset-123/hls/master.m3u8".to_owned(),
        FakeOriginObject::DelayedBody {
            bytes: b"#EXTM3U\n".to_vec(),
            delay: Duration::from_millis(250),
        },
    );
    let (origin_endpoint, metrics) = spawn_fake_origin_with_metrics(objects).await;
    let state = test_state(test_cache_dir("coalesce-different"), origin_endpoint);
    let app = build_app(state, Duration::from_secs(10));
    let barrier = Arc::new(tokio::sync::Barrier::new(2));

    let opener_handle = {
        let app = app.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            get_playback(app, signed_playback_uri("asset-123", "opener.mp4")).await
        })
    };
    let manifest_handle = {
        let app = app.clone();
        let barrier = barrier.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            get_playback(app, signed_playback_uri("asset-123", "hls/master.m3u8")).await
        })
    };

    let opener = opener_handle.await.unwrap();
    let manifest = manifest_handle.await.unwrap();

    assert_eq!(opener.status, StatusCode::OK);
    assert_eq!(opener.cache_status.as_deref(), Some("MISS"));
    assert_eq!(opener.body, b"opener-bytes");
    assert_eq!(manifest.status, StatusCode::OK);
    assert_eq!(manifest.cache_status.as_deref(), Some("MISS"));
    assert_eq!(manifest.body, b"#EXTM3U\n");
    assert_eq!(metrics.request_count(), 2);
    assert_eq!(metrics.max_active_requests(), 2);
}

#[tokio::test]
async fn origin_failure_wakes_waiters_and_removes_in_flight_entry() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-123/opener.mp4".to_owned(),
        FakeOriginObject::DelayedNoSuchKey {
            delay: Duration::from_millis(250),
        },
    );
    let (origin_endpoint, metrics) = spawn_fake_origin_with_metrics(objects).await;
    let state = test_state(test_cache_dir("coalesce-failure"), origin_endpoint);
    let app = build_app(state.clone(), Duration::from_secs(10));
    let uri = signed_playback_uri("asset-123", "opener.mp4");

    let responses = get_playback_concurrently(app.clone(), uri.clone(), 5).await;

    for response in &responses {
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert!(response.cache_status.is_none());
    }
    assert_eq!(metrics.request_count(), 1);
    assert_eq!(state.in_flight_fills.len(), 0);

    let retry = get_playback(app, uri).await;

    assert_eq!(retry.status, StatusCode::NOT_FOUND);
    assert_eq!(metrics.request_count(), 2);
    assert_eq!(state.in_flight_fills.len(), 0);
}

#[tokio::test]
async fn in_flight_registry_bound_is_enforced_for_new_artifacts() {
    let mut objects = HashMap::new();
    objects.insert(
        "videos/asset-a/opener.mp4".to_owned(),
        FakeOriginObject::DelayedBody {
            bytes: b"asset-a-opener".to_vec(),
            delay: Duration::from_millis(300),
        },
    );
    objects.insert(
        "videos/asset-b/opener.mp4".to_owned(),
        FakeOriginObject::Body(b"asset-b-opener".to_vec()),
    );
    let (origin_endpoint, metrics) = spawn_fake_origin_with_metrics(objects).await;
    let state = test_state_with_max_in_flight(test_cache_dir("coalesce-bound"), origin_endpoint, 1);
    let app = build_app(state.clone(), Duration::from_secs(10));
    let first_handle = {
        let app = app.clone();
        tokio::spawn(async move {
            get_playback(app, signed_playback_uri("asset-a", "opener.mp4")).await
        })
    };

    wait_for_in_flight_count(&state, 1).await;
    let rejected = get_playback(app, signed_playback_uri("asset-b", "opener.mp4")).await;

    assert_eq!(rejected.status, StatusCode::SERVICE_UNAVAILABLE);
    let json: Value = serde_json::from_slice(&rejected.body).unwrap();
    assert!(
        json["error"]
            .as_str()
            .unwrap()
            .contains("too many in-flight edge cache fills")
    );

    let first = first_handle.await.unwrap();
    assert_eq!(first.status, StatusCode::OK);
    assert_eq!(first.cache_status.as_deref(), Some("MISS"));
    assert_eq!(first.body, b"asset-a-opener");
    assert_eq!(metrics.request_count(), 1);
    assert_eq!(state.in_flight_fills.len(), 0);
}

#[tokio::test]
async fn unauthorized_playback_is_rejected_before_cache_origin_or_coalescing() {
    let (origin_endpoint, metrics) = spawn_fake_origin_with_metrics(HashMap::new()).await;
    let cache_dir = test_cache_dir("auth-before-cache");
    fs::write(&cache_dir, b"not-a-directory").await.unwrap();
    let state = test_state(cache_dir, origin_endpoint);
    let app = build_app(state.clone(), Duration::from_secs(10));

    let response = get_playback(app, "/v/asset-123/opener.mp4").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert!(response.cache_status.is_none());
    assert_eq!(metrics.request_count(), 0);
    assert_eq!(state.in_flight_fills.len(), 0);
}

#[test]
fn playback_auth_rejects_missing_token() {
    let (keyring, _issuer) = test_auth();

    assert!(matches!(
        validate_playback_request(&keyring, "asset-123", "opener.mp4", None, NOW),
        Err(PlaybackError::Unauthorized)
    ));
}

#[test]
fn playback_auth_rejects_malformed_token() {
    let (keyring, _issuer) = test_auth();

    assert!(matches!(
        validate_playback_request(
            &keyring,
            "asset-123",
            "opener.mp4",
            Some("not-a-valid-token"),
            NOW
        ),
        Err(PlaybackError::Unauthorized)
    ));
}

#[test]
fn playback_auth_rejects_expired_token() {
    let (keyring, issuer) = test_auth();
    let token = issuer.issue_asset_playback_token("asset-123", NOW).unwrap();

    assert!(matches!(
        validate_playback_request(&keyring, "asset-123", "opener.mp4", Some(&token), NOW + 300),
        Err(PlaybackError::Unauthorized)
    ));
}

#[test]
fn playback_auth_rejects_wrong_asset_token() {
    let (keyring, issuer) = test_auth();
    let token = issuer.issue_asset_playback_token("asset-123", NOW).unwrap();

    assert!(matches!(
        validate_playback_request(&keyring, "asset-456", "opener.mp4", Some(&token), NOW + 1),
        Err(PlaybackError::Unauthorized)
    ));
}

#[test]
fn playback_auth_rejects_tampered_token() {
    let (keyring, issuer) = test_auth();
    let token = issuer.issue_asset_playback_token("asset-123", NOW).unwrap();
    let tampered = tamper_last_char(&token);

    assert!(matches!(
        validate_playback_request(
            &keyring,
            "asset-123",
            "opener.mp4",
            Some(&tampered),
            NOW + 1
        ),
        Err(PlaybackError::Unauthorized)
    ));
}

#[test]
fn playback_auth_accepts_valid_token_for_playback_artifacts() {
    let (keyring, issuer) = test_auth();
    let token = issuer.issue_asset_playback_token("asset-123", NOW).unwrap();

    for artifact_path in ["opener.mp4", "hls/master.m3u8", "hls/segment_00000.ts"] {
        validate_playback_request(&keyring, "asset-123", artifact_path, Some(&token), NOW + 1)
            .unwrap();
    }
}
