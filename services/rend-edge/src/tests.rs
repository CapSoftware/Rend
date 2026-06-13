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
    requests: Arc<Mutex<Vec<String>>>,
}

#[derive(Clone)]
enum FakeOriginObject {
    Body(Vec<u8>),
    Error(StatusCode),
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
    state
        .requests
        .lock()
        .unwrap()
        .push(format!("{}/{}", path.bucket, path.key));

    let object = state.objects.lock().unwrap().get(&path.key).cloned();
    match object {
        Some(FakeOriginObject::Body(bytes)) => (StatusCode::OK, bytes).into_response(),
        Some(FakeOriginObject::Error(status)) => status.into_response(),
        None => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/xml")],
            format!(
                "<Error><Code>NoSuchKey</Code><Key>{}</Key></Error>",
                path.key
            ),
        )
            .into_response(),
    }
}

async fn spawn_fake_origin(
    objects: HashMap<String, FakeOriginObject>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let state = FakeOriginState {
        objects: Arc::new(Mutex::new(objects)),
        requests: requests.clone(),
    };
    let app = Router::new()
        .route("/{bucket}/{*key}", get(fake_s3_get))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (format!("http://{addr}"), requests)
}

fn test_cache_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("rend-edge-{name}-{}", temp_file_suffix()))
}

fn test_state(cache_dir: PathBuf, origin_endpoint: String) -> Arc<AppState> {
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
        playback_keyring: test_auth().0,
        warm_max_artifacts: 4,
        request_timeout: Duration::from_secs(10),
    };
    let s3 = build_s3_client(&config);

    Arc::new(AppState {
        config,
        http: reqwest::Client::new(),
        s3,
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
