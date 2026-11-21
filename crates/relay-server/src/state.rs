use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use relay_core::{GatewayConfig, I18nBundle, RelayError};
use relay_engine::{RelayLedger, UpstreamRouter};
use relay_risk::RiskEngine;

/// Immutable runtime config bundle (4 fields, Rule of 4).
pub struct RuntimeBundle {
    pub cfg: GatewayConfig,
    pub i18n: I18nBundle,
    pub admin_key: String,
    pub portal_client: reqwest::Client,
}

/// Shared Axum application state (4 fields, Rule of 4).
#[derive(Clone)]
pub struct AppState {
    pub runtime: Arc<RuntimeBundle>,
    pub risk: Arc<RiskEngine>,
    pub ledger: RelayLedger,
    pub router: Arc<UpstreamRouter>,
}

impl AppState {
    pub fn err_response(&self, headers: &HeaderMap, err: RelayError) -> Response {
        let lang = headers
            .get("accept-language")
            .and_then(|v| v.to_str().ok())
            .filter(|s| s.to_ascii_lowercase().starts_with("en"))
            .map(|_| "en")
            .unwrap_or(&self.runtime.cfg.storage.default_lang);
        let msg = self.runtime.i18n.get(lang, err.code());
        let status = StatusCode::from_u16(err.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(err.to_body(&msg))).into_response()
    }

    pub fn extract_bearer(headers: &HeaderMap) -> Option<String> {
        if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok())
            && let Some(t) = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer "))
            && !t.trim().is_empty()
        {
            return Some(t.trim().to_string());
        }
        headers
            .get("x-api-key")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub fn verify_admin(&self, headers: &HeaderMap) -> Result<(), RelayError> {
        let ok = headers
            .get("x-admin-key")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|k| !self.runtime.admin_key.is_empty() && k.trim() == self.runtime.admin_key);
        if !ok {
            return Err(RelayError::Unauthorized("invalid x-admin-key".into()));
        }
        Ok(())
    }
}
