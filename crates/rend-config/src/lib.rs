use std::{env, net::SocketAddr, path::PathBuf, str::FromStr, time::Duration};

use anyhow::{Context, Result};

pub fn load_dotenv() {
    let _ = dotenvy::from_filename(".env.local");
    let _ = dotenvy::dotenv();
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
