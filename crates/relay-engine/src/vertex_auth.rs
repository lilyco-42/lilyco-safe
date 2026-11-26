//! Zero-extra-dependency Google Cloud Vertex AI OAuth2 signer & daily spend guard.
//! Supports both `service_account` (RS256 via `ring`) and `authorized_user` (OAuth2 refresh_token).

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use relay_core::RelayError;
use reqwest::Client;
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde::Deserialize;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
enum VertexCred {
    #[serde(rename = "service_account")]
    ServiceAccount {
        client_email: String,
        private_key: String,
        project_id: String,
        #[serde(default = "default_token_uri")]
        token_uri: String,
    },
    #[serde(rename = "authorized_user")]
    AuthorizedUser {
        client_id: String,
        client_secret: String,
        refresh_token: String,
        #[serde(default = "default_project_id")]
        project_id: String,
    },
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

fn default_project_id() -> String {
    std::env::var("VERTEX_PROJECT_ID").unwrap_or_else(|_| "project-f29a64c9-3ee2-474a-bb1".into())
}

#[derive(Default)]
struct CachedToken {
    access_token: String,
    expires_unix: u64,
}

/// Hard daily call cap to prevent runaway credit drain (3 fields, Rule of 4).
pub struct VertexBudgetGuard {
    day_bucket: AtomicU64,
    used_today: AtomicU64,
    daily_limit: u64,
}

impl VertexBudgetGuard {
    pub fn from_env() -> Self {
        let daily_limit = std::env::var("VERTEX_DAILY_MAX_CALLS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(30)
            .clamp(1, 500);
        Self {
            day_bucket: AtomicU64::new(current_utc_day()),
            used_today: AtomicU64::new(0),
            daily_limit,
        }
    }

    pub fn check_and_consume(&self) -> Result<(), RelayError> {
        let today = current_utc_day();
        let prev = self.day_bucket.load(Ordering::Relaxed);
        if prev != today
            && self
                .day_bucket
                .compare_exchange(prev, today, Ordering::SeqCst, Ordering::Relaxed)
                .is_ok()
        {
            self.used_today.store(0, Ordering::SeqCst);
        }
        let count = self.used_today.fetch_add(1, Ordering::SeqCst) + 1;
        if count > self.daily_limit {
            self.used_today.fetch_sub(1, Ordering::SeqCst);
            return Err(RelayError::RateLimited(format!(
                "daily vertex safety budget cap reached ({}/{})",
                self.daily_limit, self.daily_limit
            )));
        }
        Ok(())
    }
}

/// Vertex AI OAuth2 token provider + daily safety budget guard (3 fields, Rule of 4).
pub struct VertexAuth {
    cred: Option<VertexCred>,
    cache: RwLock<CachedToken>,
    budget: VertexBudgetGuard,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn current_utc_day() -> u64 {
    now_unix() / 86_400
}

fn pem_to_pkcs8_der(pem: &str) -> Result<Vec<u8>, RelayError> {
    let b64: String = pem
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("-----"))
        .collect();
    STANDARD
        .decode(b64)
        .map_err(|_| RelayError::Config("invalid vertex private_key PEM".into()))
}

impl VertexAuth {
    pub fn load_from_env() -> Self {
        let path = std::env::var("VERTEX_SA_FILE")
            .unwrap_or_else(|_| "/opt/lilyco-relay/config/vertex-sa.json".to_string());
        let cred = Path::new(&path)
            .exists()
            .then(|| std::fs::read_to_string(&path).ok())
            .flatten()
            .and_then(|raw| serde_json::from_str::<VertexCred>(&raw).ok());
        Self {
            cred,
            cache: RwLock::new(CachedToken::default()),
            budget: VertexBudgetGuard::from_env(),
        }
    }

    pub fn is_configured(&self) -> bool {
        self.cred.is_some()
    }

    pub fn project_id(&self) -> Option<&str> {
        match self.cred.as_ref()? {
            VertexCred::ServiceAccount { project_id, .. }
            | VertexCred::AuthorizedUser { project_id, .. } => Some(project_id.as_str()),
        }
    }

    pub fn check_daily_budget(&self) -> Result<(), RelayError> {
        self.budget.check_and_consume()
    }

    pub async fn access_token(&self, client: &Client) -> Result<String, RelayError> {
        let Some(ref cred) = self.cred else {
            return Err(RelayError::UpstreamFailed("vertex credentials not configured".into()));
        };
        let now = now_unix();
        {
            let guard = self.cache.read().await;
            if !guard.access_token.is_empty() && now + 120 < guard.expires_unix {
                return Ok(guard.access_token.clone());
            }
        }
        let resp = match cred {
            VertexCred::ServiceAccount {
                client_email,
                private_key,
                token_uri,
                ..
            } => {
                let assertion = sign_sa_jwt(client_email, private_key, token_uri, now)?;
                client
                    .post(token_uri)
                    .form(&[
                        ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                        ("assertion", assertion.as_str()),
                    ])
                    .send()
                    .await
            }
            VertexCred::AuthorizedUser {
                client_id,
                client_secret,
                refresh_token,
                ..
            } => {
                client
                    .post("https://oauth2.googleapis.com/token")
                    .form(&[
                        ("grant_type", "refresh_token"),
                        ("client_id", client_id.as_str()),
                        ("client_secret", client_secret.as_str()),
                        ("refresh_token", refresh_token.as_str()),
                    ])
                    .send()
                    .await
            }
        }
        .map_err(|_| RelayError::UpstreamFailed("vertex oauth2 network timeout".into()))?;

        if !resp.status().is_success() {
            return Err(RelayError::UpstreamFailed(format!(
                "vertex oauth2 HTTP {}",
                resp.status().as_u16()
            )));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|_| RelayError::UpstreamFailed("invalid vertex oauth2 json".into()))?;
        let token = body
            .get("access_token")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        if token.is_empty() {
            return Err(RelayError::UpstreamFailed("vertex oauth2 empty access_token".into()));
        }
        let ttl = body
            .get("expires_in")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(3300);
        let mut guard = self.cache.write().await;
        guard.access_token = token.clone();
        guard.expires_unix = now + ttl;
        Ok(token)
    }
}

fn sign_sa_jwt(email: &str, private_key: &str, token_uri: &str, now: u64) -> Result<String, RelayError> {
    let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = serde_json::json!({
        "iss": email,
        "scope": "https://www.googleapis.com/auth/cloud-platform",
        "aud": token_uri,
        "iat": now,
        "exp": now + 3600,
    });
    let claims_b64 = URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes());
    let signing_input = format!("{header_b64}.{claims_b64}");

    let der = pem_to_pkcs8_der(private_key)?;
    let key_pair = RsaKeyPair::from_pkcs8(&der)
        .map_err(|_| RelayError::Config("failed to parse vertex RSA PKCS8 key".into()))?;
    let rng = SystemRandom::new();
    let mut sig = vec![0u8; key_pair.public().modulus_len()];
    key_pair
        .sign(&RSA_PKCS1_SHA256, &rng, signing_input.as_bytes(), &mut sig)
        .map_err(|_| RelayError::UpstreamFailed("vertex jwt rs256 sign failed".into()))?;
    Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(&sig)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_budget_guard_enforces_hard_cap() {
        let g = VertexBudgetGuard {
            day_bucket: AtomicU64::new(current_utc_day()),
            used_today: AtomicU64::new(0),
            daily_limit: 2,
        };
        assert!(g.check_and_consume().is_ok());
        assert!(g.check_and_consume().is_ok());
        assert!(g.check_and_consume().is_err());
    }
}
