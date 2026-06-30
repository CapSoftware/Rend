use std::{
    error::Error,
    fmt,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const TOKEN_VERSION: &str = "v1";
pub const POLICY_ASSET_PLAYBACK_V1: &str = "asset_playback_v1";
const HLS_RENDITION_NAMES: [&str; 6] = ["360p", "480p", "720p", "1080p", "2k", "4k"];

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct SigningKey {
    kid: String,
    secret: Arc<[u8]>,
}

#[derive(Clone)]
pub struct SingleKeyring {
    key: SigningKey,
}

pub trait PlaybackKeyring {
    fn secret_for_kid(&self, kid: &str) -> Option<&[u8]>;
}

#[derive(Clone)]
pub struct PlaybackTokenIssuer {
    key: SigningKey,
    ttl: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaybackClaims {
    pub asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    pub exp: u64,
    pub kid: String,
    pub policy: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PlaybackAuthError {
    EmptyKeyId,
    EmptySigningSecret,
    InvalidTtl,
    SystemClockBeforeUnixEpoch,
    MalformedToken,
    MalformedClaims,
    UnknownKey,
    InvalidSignature,
    Expired,
    WrongAsset,
    UnsupportedPolicy,
    PathNotAllowed,
}

impl SigningKey {
    pub fn new(
        kid: impl Into<String>,
        secret: impl Into<Vec<u8>>,
    ) -> Result<Self, PlaybackAuthError> {
        let kid = kid.into();
        if kid.trim().is_empty() {
            return Err(PlaybackAuthError::EmptyKeyId);
        }

        let secret = secret.into();
        if secret.iter().all(|byte| byte.is_ascii_whitespace()) {
            return Err(PlaybackAuthError::EmptySigningSecret);
        }

        Ok(Self {
            kid: kid.trim().to_owned(),
            secret: Arc::from(secret.into_boxed_slice()),
        })
    }

    pub fn kid(&self) -> &str {
        &self.kid
    }

    fn secret(&self) -> &[u8] {
        &self.secret
    }
}

impl SingleKeyring {
    pub fn new(
        kid: impl Into<String>,
        secret: impl Into<Vec<u8>>,
    ) -> Result<Self, PlaybackAuthError> {
        Ok(Self {
            key: SigningKey::new(kid, secret)?,
        })
    }

    pub fn from_key(key: SigningKey) -> Self {
        Self { key }
    }
}

impl PlaybackKeyring for SingleKeyring {
    fn secret_for_kid(&self, kid: &str) -> Option<&[u8]> {
        (kid == self.key.kid()).then(|| self.key.secret())
    }
}

impl PlaybackTokenIssuer {
    pub fn new(key: SigningKey, ttl: Duration) -> Result<Self, PlaybackAuthError> {
        if ttl.is_zero() {
            return Err(PlaybackAuthError::InvalidTtl);
        }

        Ok(Self { key, ttl })
    }

    pub fn issue_asset_playback_token(
        &self,
        asset_id: &str,
        now: u64,
    ) -> Result<String, PlaybackAuthError> {
        self.issue_asset_playback_token_with_organization(asset_id, None, now)
    }

    pub fn issue_asset_playback_token_with_organization(
        &self,
        asset_id: &str,
        organization_id: Option<&str>,
        now: u64,
    ) -> Result<String, PlaybackAuthError> {
        let exp = now
            .checked_add(self.ttl.as_secs())
            .ok_or(PlaybackAuthError::InvalidTtl)?;
        let claims = PlaybackClaims {
            asset_id: asset_id.to_owned(),
            organization_id: organization_id.map(str::to_owned),
            exp,
            kid: self.key.kid().to_owned(),
            policy: POLICY_ASSET_PLAYBACK_V1.to_owned(),
        };

        sign_claims(&claims, self.key.secret())
    }

    pub fn issue_asset_playback_token_now(
        &self,
        asset_id: &str,
    ) -> Result<String, PlaybackAuthError> {
        self.issue_asset_playback_token(asset_id, current_unix_timestamp()?)
    }

    pub fn ttl(&self) -> Duration {
        self.ttl
    }
}

pub fn current_unix_timestamp() -> Result<u64, PlaybackAuthError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PlaybackAuthError::SystemClockBeforeUnixEpoch)?
        .as_secs())
}

pub fn decode_unverified_claims(token: &str) -> Result<PlaybackClaims, PlaybackAuthError> {
    let (_signing_input, claims, _signature) = parse_token(token)?;
    Ok(claims)
}

pub fn validate_playback_token(
    token: &str,
    expected_asset_id: &str,
    artifact_path: &str,
    now: u64,
    keyring: &impl PlaybackKeyring,
) -> Result<PlaybackClaims, PlaybackAuthError> {
    let (signing_input, claims, signature) = parse_token(token)?;
    let secret = keyring
        .secret_for_kid(&claims.kid)
        .ok_or(PlaybackAuthError::UnknownKey)?;
    let mac =
        HmacSha256::new_from_slice(secret).map_err(|_| PlaybackAuthError::InvalidSignature)?;
    verify_signature(mac, signing_input.as_bytes(), &signature)?;

    if now >= claims.exp {
        return Err(PlaybackAuthError::Expired);
    }

    if claims.asset_id != expected_asset_id {
        return Err(PlaybackAuthError::WrongAsset);
    }

    ensure_policy_allows_path(&claims.policy, artifact_path)?;

    Ok(claims)
}

pub fn ensure_policy_allows_path(
    policy: &str,
    artifact_path: &str,
) -> Result<(), PlaybackAuthError> {
    if policy != POLICY_ASSET_PLAYBACK_V1 {
        return Err(PlaybackAuthError::UnsupportedPolicy);
    }

    if is_asset_playback_path(artifact_path) {
        Ok(())
    } else {
        Err(PlaybackAuthError::PathNotAllowed)
    }
}

pub fn is_asset_playback_path(artifact_path: &str) -> bool {
    if artifact_path == "opener.mp4" || artifact_path == "hls/master.m3u8" {
        return true;
    }

    match artifact_path.split('/').collect::<Vec<_>>().as_slice() {
        ["hls", segment_name] => is_valid_hls_segment_name(segment_name),
        ["hls", rendition_name, "index.m3u8"] => is_valid_hls_rendition_name(rendition_name),
        ["hls", rendition_name, "progressive.mp4"] => is_valid_hls_rendition_name(rendition_name),
        ["hls", rendition_name, media_name] => {
            is_valid_hls_rendition_name(rendition_name)
                && (is_valid_hls_segment_name(media_name)
                    || is_valid_hls_init_segment_name_for_rendition(media_name, rendition_name))
        }
        _ => false,
    }
}

pub fn is_valid_hls_rendition_name(rendition_name: &str) -> bool {
    HLS_RENDITION_NAMES.contains(&rendition_name)
}

pub fn is_valid_hls_segment_name(segment_name: &str) -> bool {
    let Some(number) = segment_name.strip_prefix("segment_").and_then(|name| {
        name.strip_suffix(".ts")
            .or_else(|| name.strip_suffix(".m4s"))
    }) else {
        return false;
    };

    is_non_empty_ascii_digits(number)
}

pub fn is_valid_hls_init_segment_name(segment_name: &str) -> bool {
    let Some(rendition_name) = segment_name
        .strip_prefix("init_")
        .and_then(|name| name.strip_suffix(".mp4"))
    else {
        return false;
    };

    is_valid_hls_rendition_name(rendition_name)
}

pub fn is_valid_hls_init_segment_name_for_rendition(
    segment_name: &str,
    rendition_name: &str,
) -> bool {
    let Some(init_rendition_name) = segment_name
        .strip_prefix("init_")
        .and_then(|name| name.strip_suffix(".mp4"))
    else {
        return false;
    };

    init_rendition_name == rendition_name && is_valid_hls_rendition_name(init_rendition_name)
}

fn is_non_empty_ascii_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn sign_claims(claims: &PlaybackClaims, secret: &[u8]) -> Result<String, PlaybackAuthError> {
    let claims_json = serde_json::to_vec(claims).map_err(|_| PlaybackAuthError::MalformedClaims)?;
    let encoded_claims = URL_SAFE_NO_PAD.encode(claims_json);
    let signing_input = format!("{TOKEN_VERSION}.{encoded_claims}");
    let mut mac =
        HmacSha256::new_from_slice(secret).map_err(|_| PlaybackAuthError::InvalidSignature)?;
    mac.update(signing_input.as_bytes());
    let signature = mac.finalize().into_bytes();

    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

fn parse_token(token: &str) -> Result<(String, PlaybackClaims, Vec<u8>), PlaybackAuthError> {
    let mut parts = token.split('.');
    let version = parts.next().ok_or(PlaybackAuthError::MalformedToken)?;
    let encoded_claims = parts.next().ok_or(PlaybackAuthError::MalformedToken)?;
    let encoded_signature = parts.next().ok_or(PlaybackAuthError::MalformedToken)?;
    if parts.next().is_some()
        || version != TOKEN_VERSION
        || encoded_claims.is_empty()
        || encoded_signature.is_empty()
    {
        return Err(PlaybackAuthError::MalformedToken);
    }

    let claims_json = URL_SAFE_NO_PAD
        .decode(encoded_claims)
        .map_err(|_| PlaybackAuthError::MalformedToken)?;
    let claims: PlaybackClaims =
        serde_json::from_slice(&claims_json).map_err(|_| PlaybackAuthError::MalformedClaims)?;
    if claims.asset_id.is_empty() || claims.kid.is_empty() || claims.policy.is_empty() {
        return Err(PlaybackAuthError::MalformedClaims);
    }

    let signature = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .map_err(|_| PlaybackAuthError::MalformedToken)?;
    let signing_input = format!("{version}.{encoded_claims}");

    Ok((signing_input, claims, signature))
}

fn verify_signature(
    mut mac: HmacSha256,
    signing_input: &[u8],
    signature: &[u8],
) -> Result<(), PlaybackAuthError> {
    mac.update(signing_input);
    mac.verify_slice(signature)
        .map_err(|_| PlaybackAuthError::InvalidSignature)
}

impl fmt::Display for PlaybackAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::EmptyKeyId => "playback signing key id must not be empty",
            Self::EmptySigningSecret => "playback signing secret must not be empty",
            Self::InvalidTtl => "playback token ttl must be a positive number of seconds",
            Self::SystemClockBeforeUnixEpoch => "system clock is before unix epoch",
            Self::MalformedToken => "playback token is malformed",
            Self::MalformedClaims => "playback token claims are malformed",
            Self::UnknownKey => "playback token key id is unknown",
            Self::InvalidSignature => "playback token signature is invalid",
            Self::Expired => "playback token has expired",
            Self::WrongAsset => "playback token asset does not match request",
            Self::UnsupportedPolicy => "playback token policy is unsupported",
            Self::PathNotAllowed => "playback token policy does not allow request path",
        };

        formatter.write_str(message)
    }
}

impl Error for PlaybackAuthError {}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn issuer() -> PlaybackTokenIssuer {
        PlaybackTokenIssuer::new(
            SigningKey::new("kid-a", b"test-playback-secret".to_vec()).unwrap(),
            Duration::from_secs(300),
        )
        .unwrap()
    }

    fn keyring() -> SingleKeyring {
        SingleKeyring::new("kid-a", b"test-playback-secret".to_vec()).unwrap()
    }

    fn tamper_last_char(value: &str) -> String {
        let mut output = value.to_owned();
        let last = output.pop().unwrap();
        output.push(if last == 'A' { 'B' } else { 'A' });
        output
    }

    fn token_parts(token: &str) -> (&str, &str, &str) {
        let mut parts = token.split('.');
        (
            parts.next().unwrap(),
            parts.next().unwrap(),
            parts.next().unwrap(),
        )
    }

    #[test]
    fn valid_token_round_trips_claims() {
        let token = issuer()
            .issue_asset_playback_token("asset-123", NOW)
            .unwrap();
        let claims =
            validate_playback_token(&token, "asset-123", "hls/master.m3u8", NOW + 1, &keyring())
                .unwrap();

        assert_eq!(
            claims,
            PlaybackClaims {
                asset_id: "asset-123".to_owned(),
                organization_id: None,
                exp: NOW + 300,
                kid: "kid-a".to_owned(),
                policy: POLICY_ASSET_PLAYBACK_V1.to_owned(),
            }
        );
    }

    #[test]
    fn organization_claim_round_trips_when_issued() {
        let token = issuer()
            .issue_asset_playback_token_with_organization(
                "asset-123",
                Some("00000000-0000-0000-0000-000000000001"),
                NOW,
            )
            .unwrap();
        let claims =
            validate_playback_token(&token, "asset-123", "hls/master.m3u8", NOW + 1, &keyring())
                .unwrap();

        assert_eq!(
            claims.organization_id.as_deref(),
            Some("00000000-0000-0000-0000-000000000001")
        );
    }

    #[test]
    fn expired_token_is_rejected() {
        let token = issuer()
            .issue_asset_playback_token("asset-123", NOW)
            .unwrap();

        assert_eq!(
            validate_playback_token(&token, "asset-123", "opener.mp4", NOW + 300, &keyring()),
            Err(PlaybackAuthError::Expired)
        );
    }

    #[test]
    fn tampered_claims_are_rejected() {
        let token = issuer()
            .issue_asset_playback_token("asset-123", NOW)
            .unwrap();
        let (version, encoded_claims, signature) = token_parts(&token);
        let mut claims: PlaybackClaims =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded_claims).unwrap()).unwrap();
        claims.asset_id = "asset-456".to_owned();
        let tampered_claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let tampered = format!("{version}.{tampered_claims}.{signature}");

        assert_eq!(
            validate_playback_token(&tampered, "asset-456", "opener.mp4", NOW + 1, &keyring()),
            Err(PlaybackAuthError::InvalidSignature)
        );
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let token = issuer()
            .issue_asset_playback_token("asset-123", NOW)
            .unwrap();

        assert_eq!(
            validate_playback_token(
                &tamper_last_char(&token),
                "asset-123",
                "opener.mp4",
                NOW + 1,
                &keyring()
            ),
            Err(PlaybackAuthError::InvalidSignature)
        );
    }

    #[test]
    fn wrong_kid_or_key_is_rejected() {
        let token = issuer()
            .issue_asset_playback_token("asset-123", NOW)
            .unwrap();
        let missing_keyring =
            SingleKeyring::new("kid-b", b"test-playback-secret".to_vec()).unwrap();
        let wrong_secret_keyring =
            SingleKeyring::new("kid-a", b"different-playback-secret".to_vec()).unwrap();

        assert_eq!(
            validate_playback_token(&token, "asset-123", "opener.mp4", NOW + 1, &missing_keyring),
            Err(PlaybackAuthError::UnknownKey)
        );
        assert_eq!(
            validate_playback_token(
                &token,
                "asset-123",
                "opener.mp4",
                NOW + 1,
                &wrong_secret_keyring
            ),
            Err(PlaybackAuthError::InvalidSignature)
        );
    }

    #[test]
    fn wrong_asset_id_is_rejected() {
        let token = issuer()
            .issue_asset_playback_token("asset-123", NOW)
            .unwrap();

        assert_eq!(
            validate_playback_token(&token, "asset-456", "opener.mp4", NOW + 1, &keyring()),
            Err(PlaybackAuthError::WrongAsset)
        );
    }

    #[test]
    fn unsupported_policy_and_path_are_rejected() {
        let unsupported_policy = sign_claims(
            &PlaybackClaims {
                asset_id: "asset-123".to_owned(),
                organization_id: None,
                exp: NOW + 300,
                kid: "kid-a".to_owned(),
                policy: "thumbnail_only".to_owned(),
            },
            b"test-playback-secret",
        )
        .unwrap();
        let supported_policy = issuer()
            .issue_asset_playback_token("asset-123", NOW)
            .unwrap();

        assert_eq!(
            validate_playback_token(
                &unsupported_policy,
                "asset-123",
                "opener.mp4",
                NOW + 1,
                &keyring()
            ),
            Err(PlaybackAuthError::UnsupportedPolicy)
        );
        assert_eq!(
            validate_playback_token(
                &supported_policy,
                "asset-123",
                "thumbnail.jpg",
                NOW + 1,
                &keyring()
            ),
            Err(PlaybackAuthError::PathNotAllowed)
        );
    }

    #[test]
    fn playback_policy_allows_only_known_hls_ladder_paths() {
        for artifact_path in [
            "opener.mp4",
            "hls/master.m3u8",
            "hls/segment_00000.ts",
            "hls/segment_00000.m4s",
            "hls/360p/index.m3u8",
            "hls/360p/init_360p.mp4",
            "hls/360p/segment_00000.m4s",
            "hls/480p/index.m3u8",
            "hls/480p/init_480p.mp4",
            "hls/480p/segment_00000.m4s",
            "hls/720p/index.m3u8",
            "hls/720p/progressive.mp4",
            "hls/720p/segment_00000.ts",
            "hls/720p/init_720p.mp4",
            "hls/720p/segment_00000.m4s",
            "hls/1080p/index.m3u8",
            "hls/2k/segment_00001.ts",
            "hls/4k/segment_00010.ts",
        ] {
            assert!(
                is_asset_playback_path(artifact_path),
                "{artifact_path} should be allowed"
            );
        }

        for artifact_path in [
            "hls/720p/init_480p.mp4",
            "hls/720p/init_latest.mp4",
            "hls/720p/init_00000.mp4",
            "hls/720p/playlist.m3u8",
            "hls/720p/startup.mp4",
            "hls/720p/nested/segment_00000.ts",
            "hls/720p/segment_latest.ts",
            "hls/../opener.mp4",
            "videos/asset-123/hls/720p/segment_00000.ts",
        ] {
            assert!(
                !is_asset_playback_path(artifact_path),
                "{artifact_path} should be rejected"
            );
        }
    }

    #[test]
    fn empty_signing_secret_is_rejected() {
        assert!(matches!(
            SigningKey::new("kid-a", b" \t\n".to_vec()),
            Err(PlaybackAuthError::EmptySigningSecret)
        ));
    }
}
