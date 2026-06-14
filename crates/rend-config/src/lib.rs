use std::{
    collections::{BTreeMap, HashSet},
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use anyhow::{Context, Result};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RendEnv {
    Local,
    Production,
}

impl RendEnv {
    pub fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "local" => Ok(Self::Local),
            // Deprecated compatibility alias. New env files and scripts must use production.
            "trial" | "production" | "prod" => Ok(Self::Production),
            _ => anyhow::bail!("REND_ENV must be one of: local, production"),
        }
    }

    pub fn from_env() -> Result<Self> {
        Self::parse(&env_string("REND_ENV", "local"))
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Production => "production",
        }
    }

    pub fn is_strict(self) -> bool {
        matches!(self, Self::Production)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExpectedEdges {
    edges: BTreeMap<String, ExpectedEdge>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedEdge {
    pub edge_id: String,
    pub region: String,
    pub base_url: String,
}

impl ExpectedEdges {
    pub fn parse(value: &str, rend_env: RendEnv, allow_insecure_edge_urls: bool) -> Result<Self> {
        let value = value.trim();
        if value.is_empty() {
            anyhow::ensure!(
                !rend_env.is_strict(),
                "REND_EXPECTED_EDGES must list expected edge_id=region=base_url entries in {} mode",
                rend_env.as_str()
            );
            return Ok(Self::default());
        }

        let mut edges = BTreeMap::new();
        for raw_entry in value.split(',') {
            let raw_entry = raw_entry.trim();
            if raw_entry.is_empty() {
                continue;
            }
            let mut parts = raw_entry.splitn(3, '=');
            let edge_id = parts.next().unwrap_or_default().trim();
            let region = parts.next().unwrap_or_default().trim();
            let base_url = parts.next().unwrap_or_default().trim();
            anyhow::ensure!(
                !edge_id.is_empty() && !region.is_empty() && !base_url.is_empty(),
                "REND_EXPECTED_EDGES entries must use edge_id=region=base_url"
            );
            ensure_safe_edge_name("edge_id", edge_id)?;
            ensure_safe_edge_name("region", region)?;
            let base_url = normalize_edge_base_url(base_url, rend_env, allow_insecure_edge_urls)?;
            let previous = edges.insert(
                edge_id.to_owned(),
                ExpectedEdge {
                    edge_id: edge_id.to_owned(),
                    region: region.to_owned(),
                    base_url,
                },
            );
            anyhow::ensure!(
                previous.is_none(),
                "REND_EXPECTED_EDGES contains duplicate edge_id {edge_id}"
            );
        }

        anyhow::ensure!(
            !rend_env.is_strict() || !edges.is_empty(),
            "REND_EXPECTED_EDGES must not be empty in {} mode",
            rend_env.as_str()
        );

        Ok(Self { edges })
    }

    pub fn from_env(key: &str, rend_env: RendEnv, allow_insecure_edge_urls: bool) -> Result<Self> {
        Self::parse(&env_string(key, ""), rend_env, allow_insecure_edge_urls)
            .with_context(|| format!("{key} is invalid"))
    }

    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }

    pub fn get(&self, edge_id: &str) -> Option<&ExpectedEdge> {
        self.edges.get(edge_id)
    }

    pub fn contains_match(&self, edge_id: &str, region: &str, base_url: &str) -> bool {
        self.get(edge_id).is_some_and(|expected| {
            expected.region == region && expected.base_url == base_url.trim_end_matches('/')
        })
    }

    pub fn iter(&self) -> impl Iterator<Item = &ExpectedEdge> {
        self.edges.values()
    }
}

pub fn load_dotenv() -> Result<()> {
    let inherited = env::vars().map(|(key, _)| key).collect::<HashSet<_>>();
    if let Ok(env_file) = env::var("REND_ENV_FILE") {
        let env_file = env_file.trim();
        if !env_file.is_empty() {
            return load_dotenv_file(Path::new(env_file), &inherited);
        }
    }

    match dotenv_profile()? {
        RendEnv::Local => load_dotenv_file(Path::new(".env.local"), &inherited)?,
        RendEnv::Production => {
            load_dotenv_file(Path::new(".env.production"), &inherited)?;
            load_dotenv_file(Path::new(".env.production.local"), &inherited)?;
        }
    }

    Ok(())
}

fn dotenv_profile() -> Result<RendEnv> {
    if let Ok(profile) = env::var("REND_ENV_PROFILE") {
        let profile = profile.trim();
        if !profile.is_empty() {
            return RendEnv::parse(profile);
        }
    }
    if let Ok(rend_env) = env::var("REND_ENV") {
        let rend_env = rend_env.trim();
        if !rend_env.is_empty() {
            return RendEnv::parse(rend_env);
        }
    }
    Ok(RendEnv::Local)
}

fn load_dotenv_file(path: &Path, inherited: &HashSet<String>) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }

    for entry in dotenvy::from_path_iter(path)
        .with_context(|| format!("failed to read env file {}", path.display()))?
    {
        let (key, value) =
            entry.with_context(|| format!("failed to parse env file {}", path.display()))?;
        if inherited.contains(&key) {
            continue;
        }
        // SAFETY: services call load_dotenv at process startup before spawning worker
        // threads. Shell-provided env vars are preserved and profile files are local.
        unsafe {
            env::set_var(key, value);
        }
    }
    Ok(())
}

pub fn env_string(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
}

pub fn env_bool(key: &str, default: bool) -> Result<bool> {
    match env::var(key) {
        Ok(value) => match value.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => anyhow::bail!("{key} must be a boolean"),
        },
        Err(_) => Ok(default),
    }
}

pub fn env_socket_addr(key: &str, default: &str) -> Result<SocketAddr> {
    env_string(key, default)
        .parse::<SocketAddr>()
        .with_context(|| format!("{key} must be a socket address, for example 127.0.0.1:4000"))
}

pub fn env_path(key: &str, default: &str) -> PathBuf {
    PathBuf::from(env_string(key, default))
}

pub fn env_duration_secs(key: &str, default_secs: u64) -> Result<Duration> {
    let value = env_string(key, &default_secs.to_string());
    let secs =
        u64::from_str(&value).with_context(|| format!("{key} must be a number of seconds"))?;
    Ok(Duration::from_secs(secs))
}

pub fn env_usize(key: &str, default: usize) -> Result<usize> {
    let value = env_string(key, &default.to_string());
    usize::from_str(&value).with_context(|| format!("{key} must be a positive integer"))
}

pub fn env_u64(key: &str, default: u64) -> Result<u64> {
    let value = env_string(key, &default.to_string());
    u64::from_str(&value).with_context(|| format!("{key} must be a non-negative integer"))
}

pub fn optional_env_url(key: &str) -> Option<String> {
    let value = env_string(key, "");
    let value = value.trim().trim_end_matches('/').to_owned();
    (!value.is_empty()).then_some(value)
}

pub fn validate_required_secret(rend_env: RendEnv, key: &str, value: &str) -> Result<()> {
    let value = value.trim();
    anyhow::ensure!(!value.is_empty(), "{key} must not be empty");
    if rend_env.is_strict() {
        anyhow::ensure!(
            !is_known_dev_default(key, value),
            "{key} must not use a known local/dev default in {} mode",
            rend_env.as_str()
        );
        anyhow::ensure!(
            !is_placeholder(value),
            "{key} must not use a placeholder value in {} mode",
            rend_env.as_str()
        );
    } else {
        anyhow::ensure!(
            !is_production_secret_like(key, value),
            "{key} looks like a production secret; local mode must use dev/local-only secrets"
        );
    }
    Ok(())
}

pub fn validate_required_url(rend_env: RendEnv, key: &str, value: &str) -> Result<()> {
    let value = value.trim();
    anyhow::ensure!(!value.is_empty(), "{key} must not be empty");
    let parsed = ensure_absolute_http_url(key, value)?;
    if rend_env == RendEnv::Local {
        anyhow::ensure!(
            is_local_url(&parsed),
            "{key} must point at localhost, loopback, .local, or a Docker service in local mode"
        );
    }
    if rend_env.is_strict() {
        if requires_https_in_production(key) {
            anyhow::ensure!(
                parsed.scheme() == "https",
                "{key} must use https in {} mode",
                rend_env.as_str()
            );
        }
        anyhow::ensure!(
            !is_local_url(&parsed),
            "{key} must not point at localhost or a local service name in {} mode",
            rend_env.as_str()
        );
    }
    Ok(())
}

pub fn validate_required_service_url(rend_env: RendEnv, key: &str, value: &str) -> Result<()> {
    let value = value.trim();
    anyhow::ensure!(!value.is_empty(), "{key} must not be empty");
    let parsed = Url::parse(value).with_context(|| format!("{key} must be an absolute URL"))?;
    anyhow::ensure!(parsed.host_str().is_some(), "{key} must include a host");
    if rend_env == RendEnv::Local {
        anyhow::ensure!(
            is_local_url(&parsed),
            "{key} must point at localhost, loopback, .local, or a Docker service in local mode"
        );
    }
    if rend_env.is_strict() {
        anyhow::ensure!(
            !is_local_url(&parsed),
            "{key} must not point at localhost or a local service name in {} mode",
            rend_env.as_str()
        );
    }
    Ok(())
}

pub fn validate_optional_url(rend_env: RendEnv, key: &str, value: Option<&str>) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    validate_required_url(rend_env, key, value)
}

pub fn normalize_edge_base_url(
    base_url: &str,
    rend_env: RendEnv,
    _allow_insecure_edge_urls: bool,
) -> Result<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    anyhow::ensure!(!base_url.is_empty(), "base_url must not be empty");
    let parsed = ensure_absolute_http_url("base_url", base_url)?;
    if rend_env == RendEnv::Local {
        anyhow::ensure!(
            is_local_url(&parsed),
            "base_url must point at localhost, loopback, .local, or a Docker service in local mode"
        );
    }
    if rend_env.is_strict() {
        anyhow::ensure!(
            parsed.scheme() == "https",
            "base_url must use https in {} mode",
            rend_env.as_str()
        );
        anyhow::ensure!(
            !is_local_url(&parsed),
            "base_url must not point at localhost or a local service name in {} mode",
            rend_env.as_str()
        );
    }

    Ok(base_url.to_owned())
}

pub fn validate_edge_base_url(
    rend_env: RendEnv,
    key: &str,
    value: &str,
    allow_insecure_edge_urls: bool,
) -> Result<()> {
    normalize_edge_base_url(value, rend_env, allow_insecure_edge_urls)
        .map(|_| ())
        .with_context(|| format!("{key} is invalid"))
}

fn ensure_absolute_http_url(label: &str, value: &str) -> Result<Url> {
    let parsed =
        Url::parse(value).with_context(|| format!("{label} must be an absolute http(s) URL"))?;
    anyhow::ensure!(
        matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some(),
        "{label} must be an absolute http(s) URL"
    );
    anyhow::ensure!(
        parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none(),
        "{label} must not include credentials, query, or fragment"
    );
    Ok(parsed)
}

fn ensure_safe_edge_name(field: &str, value: &str) -> Result<()> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "{field} must be 1-128 characters and contain only letters, numbers, '-', '_', or '.'"
    );
    Ok(())
}

fn requires_https_in_production(key: &str) -> bool {
    matches!(
        key,
        "REND_PLAYBACK_BASE_URL"
            | "REND_EDGE_BASE_URL"
            | "REND_CONTROL_PLANE_URL"
            | "REND_EDGE_TELEMETRY_INGEST_URL"
            | "REND_EDGE_WARM_URL"
            | "REND_EDGE_PURGE_URL"
    )
}

fn is_known_dev_default(key: &str, value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    matches!(
        (key, value.as_str()),
        ("REND_DEV_API_KEY", "dev-api-key")
            | ("REND_EDGE_INTERNAL_TOKEN", "dev-internal-token")
            | ("REND_INTERNAL_TELEMETRY_TOKEN", "dev-internal-token")
            | ("REND_PLAYBACK_SIGNING_KEY_ID", "local-dev-playback-key")
            | ("AWS_ACCESS_KEY_ID", "rend_minio")
            | ("AWS_SECRET_ACCESS_KEY", "rend_minio_password")
            | ("CLICKHOUSE_PASSWORD", "rend")
            | (
                "REND_PLAYBACK_SIGNING_SECRET",
                "local-dev-playback-signing-secret"
            )
    )
}

fn is_production_secret_like(key: &str, value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || is_known_dev_default(key, value) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("local") || lower.contains("dev") || lower.contains("test") {
        return false;
    }
    value.starts_with("sk_live_")
        || value.starts_with("pk_live_")
        || value.starts_with("whsec_")
        || value.starts_with("AKIA") && value.len() == 20
        || value.starts_with("ASIA") && value.len() == 20
        || value.starts_with("eyJ") && value.contains('.')
        || value.starts_with("-----BEGIN ")
        || value.len() >= 40
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'_' | b'-')
            })
}

fn is_placeholder(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.contains("replace-me")
        || value.contains("changeme")
        || value.contains("change-me")
        || value.contains("placeholder")
        || value.starts_with('<') && value.ends_with('>')
}

pub fn is_local_service_url(value: &str) -> bool {
    Url::parse(value).ok().is_some_and(|url| is_local_url(&url))
}

fn is_local_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    host == "localhost"
        || host == "0.0.0.0"
        || host == "::"
        || host == "::1"
        || host.starts_with("127.")
        || host.ends_with(".local")
        || host == "host.docker.internal"
        || matches!(
            host.as_str(),
            "postgres"
                | "redis"
                | "minio"
                | "clickhouse"
                | "rend-api"
                | "rend-edge"
                | "rend-edge-us-east"
                | "rend-edge-london"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rend_env_parses_supported_modes() {
        assert_eq!(RendEnv::parse("local").unwrap(), RendEnv::Local);
        assert_eq!(RendEnv::parse("trial").unwrap(), RendEnv::Production);
        assert_eq!(RendEnv::parse("prod").unwrap(), RendEnv::Production);
        assert!(RendEnv::parse("staging").is_err());
    }

    #[test]
    fn strict_secret_validation_rejects_dev_defaults_and_placeholders() {
        assert!(
            validate_required_secret(RendEnv::Production, "REND_DEV_API_KEY", "dev-api-key")
                .is_err()
        );
        assert!(
            validate_required_secret(
                RendEnv::Production,
                "REND_EDGE_INTERNAL_TOKEN",
                "replace-me"
            )
            .is_err()
        );
        validate_required_secret(RendEnv::Local, "REND_DEV_API_KEY", "dev-api-key").unwrap();
        validate_required_secret(RendEnv::Production, "REND_DEV_API_KEY", "real-secret").unwrap();
    }

    #[test]
    fn local_secret_validation_rejects_production_secret_shapes() {
        assert!(
            validate_required_secret(RendEnv::Local, "AWS_ACCESS_KEY_ID", "AKIA0000000000000000")
                .is_err()
        );
        assert!(
            validate_required_secret(
                RendEnv::Local,
                "REND_PLAYBACK_SIGNING_SECRET",
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"
            )
            .is_err()
        );
        validate_required_secret(
            RendEnv::Local,
            "REND_PLAYBACK_SIGNING_SECRET",
            "local-dev-playback-signing-secret",
        )
        .unwrap();
    }

    #[test]
    fn url_validation_enforces_profile_host_policy() {
        assert!(
            validate_required_url(RendEnv::Local, "S3_ENDPOINT", "https://objects.example.com")
                .is_err()
        );
        validate_required_url(RendEnv::Local, "S3_ENDPOINT", "http://minio:9000").unwrap();
        assert!(
            validate_required_url(RendEnv::Production, "S3_ENDPOINT", "http://minio:9000").is_err()
        );
        assert!(
            validate_required_url(RendEnv::Production, "S3_ENDPOINT", "http://127.0.0.1:9100")
                .is_err()
        );
        validate_required_url(
            RendEnv::Production,
            "S3_ENDPOINT",
            "https://objects.example.com",
        )
        .unwrap();
        assert!(
            validate_required_url(
                RendEnv::Production,
                "REND_CONTROL_PLANE_URL",
                "http://api.example.com"
            )
            .is_err()
        );
    }

    #[test]
    fn expected_edges_parse_and_require_https_in_strict_mode() {
        let edges = ExpectedEdges::parse(
            "edge-a=us-east=https://edge-a.example.com,edge-b=london=https://edge-b.example.com/",
            RendEnv::Production,
            false,
        )
        .unwrap();

        assert!(edges.contains_match("edge-a", "us-east", "https://edge-a.example.com"));
        assert!(!edges.contains_match("edge-a", "us-east", "https://changed.example.com"));
        assert!(
            ExpectedEdges::parse(
                "edge-a=us-east=http://edge-a.example.com",
                RendEnv::Production,
                false
            )
            .is_err()
        );
        assert!(
            ExpectedEdges::parse("edge-a=us-east=http://edge-a", RendEnv::Production, true)
                .is_err()
        );
    }
}
