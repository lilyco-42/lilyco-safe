pub mod admin;
pub mod chat;
pub mod media;

pub use admin::*;
pub use chat::*;
pub use media::*;

use std::net::SocketAddr;

use axum::http::HeaderMap;
use relay_core::{ClientIp, RelayError, UserRole};
use serde::Deserialize;

use crate::state::AppState;


/// Strict IP action payload (<= 4 fields, deny_unknown_fields).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IpActionReq {
    pub ip: String,
}

/// Strict key revoke payload (<= 4 fields, deny_unknown_fields).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevokeKeyReq {
    pub key_id: String,
}

/// Strict affiliate referrer bind payload (<= 4 fields, deny_unknown_fields).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AffiliateBindReq {
    pub referrer: String,
}

/// Strict real-money topup webhook payload (<= 4 fields, deny_unknown_fields).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TopupReq {
    pub order_id: String,
    pub username: String,
    pub credits: u64,
}

/// Strict MCP JSON-RPC 2.0 request (<= 4 fields).
#[derive(Deserialize)]
pub struct McpReq {
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<McpParams>,
}

#[derive(Deserialize)]
pub struct McpParams {
    pub name: Option<String>,
}

pub(crate) fn client_ip_from(state: &AppState, peer: SocketAddr, headers: &HeaderMap) -> Result<ClientIp, RelayError> {
    let xff = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
    state.risk.resolve_ip(&peer.ip().to_string(), xff)
}


pub(crate) async fn resolve_portal_user(st: &AppState, headers: &HeaderMap) -> Result<String, RelayError> {
    let tok = AppState::extract_bearer(headers)
        .ok_or_else(|| RelayError::Unauthorized("missing portal token".into()))?;
    let verify_url = &st.runtime.cfg.server.portal_verify_url;
    let r = st
        .runtime
        .portal_client
        .get(verify_url)
        .bearer_auth(&tok)
        .send()
        .await
        .map_err(|_| RelayError::Unauthorized("portal auth unavailable".into()))?;
    let v: serde_json::Value = r
        .json()
        .await
        .map_err(|_| RelayError::Unauthorized("invalid portal response".into()))?;
    let uname = v
        .get("username")
        .or_else(|| v.pointer("/account/username"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| RelayError::Unauthorized("portal token invalid".into()))?;
    let paid = v
        .get("points_balance")
        .or_else(|| v.pointer("/points/balance"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    st.ledger.sync_portal_wallet(uname, paid).await?;
    Ok(uname.to_string())
}

/// Allow admin access via either `X-Admin-Key` header OR an authenticated `admin`-role JWT.
pub(crate) async fn verify_admin_access(st: &AppState, headers: &HeaderMap) -> Result<(), RelayError> {
    if st.verify_admin(headers).is_ok() {
        return Ok(());
    }
    if AppState::extract_bearer(headers).is_some() {
        let uname = resolve_portal_user(st, headers).await?;
        let policy = st.ledger.get_user_policy(&uname).await?;
        if policy.role == UserRole::Admin && !policy.banned {
            return Ok(());
        }
        return Err(RelayError::Forbidden("admin role required".into()));
    }
    Err(RelayError::Unauthorized("admin auth required".into()))
}

