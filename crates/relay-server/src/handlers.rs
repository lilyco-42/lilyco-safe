use std::convert::Infallible;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use relay_core::{
    AnthropicMsgReq, ChatReq, ClientIp, KeyIssueReq, PricingRate, RelayError,
};
use relay_engine::UpstreamReply;
use serde::Deserialize;
use serde_json::json;

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

fn client_ip_from(state: &AppState, peer: SocketAddr, headers: &HeaderMap) -> Result<ClientIp, RelayError> {
    let xff = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok());
    state.risk.resolve_ip(&peer.ip().to_string(), xff)
}

pub async fn api_health(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "lilyco-relay",
        "license": "MIT",
        "models_count": st.router.catalog().models.len(),
        "risk": st.risk.stats()
    }))
}

pub async fn api_list_models(State(st): State<AppState>) -> impl IntoResponse {
    let data: Vec<_> = st
        .router
        .catalog()
        .models
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "object": "model",
                "owned_by": m.channel_id,
                "input_per_m": m.input_per_m,
                "output_per_m": m.output_per_m,
                "allow_free": m.allow_free
            })
        })
        .collect();
    Json(json!({ "object": "list", "data": data }))
}

async fn execute_chat_pipeline(
    st: &AppState,
    ip: &ClientIp,
    headers: &HeaderMap,
    req: &ChatReq,
) -> Result<UpstreamReply, RelayError> {
    st.risk.check_ip(ip)?;
    req.validate()?;
    let raw_key = AppState::extract_bearer(headers).ok_or_else(|| {
        st.risk.record_auth_failure(ip);
        RelayError::Unauthorized("missing bearer api key".into())
    })?;
    let model = st
        .router
        .catalog()
        .find_model(&req.model)
        .ok_or_else(|| RelayError::ModelNotFound(format!("unknown model {}", req.model)))?;
    let key_rec = match st.ledger.verify_api_key(&raw_key, &model.id).await {
        Ok(k) => k,
        Err(e) => {
            st.risk.record_auth_failure(ip);
            return Err(e);
        }
    };
    let rate = PricingRate {
        input_per_m: model.input_per_m,
        output_per_m: model.output_per_m,
        allow_free: model.allow_free,
    };
    let est_out = req.max_tokens.unwrap_or(512) as u64;
    let est_hold = rate.calculate_credits(relay_core::TokenUsage {
        prompt_tokens: req.estimate_prompt_tokens(),
        completion_tokens: est_out,
    });
    st.risk.check_key_spend(&key_rec.id, est_hold)?;
    let hold = st.ledger.pre_hold_paid(&key_rec, est_hold).await?;

    match st.router.call_chat(model, req).await {
        Ok(reply) => {
            let actual = rate.calculate_credits(reply.usage);
            let _ = st.ledger.settle_hold(&hold, &model.id, reply.usage, actual).await;
            Ok(reply)
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &model.id).await;
            Err(e)
        }
    }
}

pub async fn api_openai_chat(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ChatReq>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let reply = match execute_chat_pipeline(&st, &ip, &headers, &req).await {
        Ok(r) => r,
        Err(e) => return st.err_response(&headers, e),
    };
    if req.stream {
        let id = reply.id.clone();
        let model = reply.model.clone();
        let text = reply.content.clone();
        let stream = async_stream::stream! {
            let chunk = json!({
                "id": id,
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [{ "index": 0, "delta": { "role": "assistant", "content": text }, "finish_reason": "stop" }]
            });
            yield Ok::<Event, Infallible>(Event::default().data(chunk.to_string()));
            yield Ok::<Event, Infallible>(Event::default().data("[DONE]"));
        };
        return Sse::new(stream).keep_alive(KeepAlive::default()).into_response();
    }
    Json(json!({
        "id": reply.id,
        "object": "chat.completion",
        "model": reply.model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": reply.content },
            "finish_reason": "stop"
        }],
        "usage": {
            "prompt_tokens": reply.usage.prompt_tokens,
            "completion_tokens": reply.usage.completion_tokens,
            "total_tokens": reply.usage.prompt_tokens + reply.usage.completion_tokens
        }
    }))
    .into_response()
}

pub async fn api_anthropic_messages(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<AnthropicMsgReq>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let chat_req = match req.to_chat_req() {
        Ok(c) => c,
        Err(e) => return st.err_response(&headers, e),
    };
    let reply = match execute_chat_pipeline(&st, &ip, &headers, &chat_req).await {
        Ok(r) => r,
        Err(e) => return st.err_response(&headers, e),
    };
    Json(json!({
        "id": reply.id,
        "type": "message",
        "role": "assistant",
        "model": reply.model,
        "content": [{ "type": "text", "text": reply.content }],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": reply.usage.prompt_tokens,
            "output_tokens": reply.usage.completion_tokens
        }
    }))
    .into_response()
}

async fn resolve_portal_user(st: &AppState, headers: &HeaderMap) -> Result<String, RelayError> {
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

pub async fn api_me(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    let wallet = match st.ledger.get_wallet(&uname).await {
        Ok(w) => w,
        Err(e) => return st.err_response(&headers, e),
    };
    let keys = st.ledger.list_keys(&uname).await.unwrap_or_default();
    let usage = st.ledger.list_usage(&uname).await.unwrap_or_default();
    Json(json!({
        "ok": true,
        "wallet": wallet,
        "keys": keys,
        "usage": usage,
        "referral_code": uname
    }))
    .into_response()
}

pub async fn api_issue_key(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<KeyIssueReq>,
) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.issue_key(&uname, &req).await {
        Ok((secret, rec)) => Json(json!({ "ok": true, "api_key": secret, "key": rec })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_revoke_key(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RevokeKeyReq>,
) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.revoke_key(&uname, &req.key_id).await {
        Ok(()) => Json(json!({ "ok": true, "revoked": req.key_id })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_bind_affiliate(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AffiliateBindReq>,
) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.bind_referrer(&uname, &req.referrer).await {
        Ok(()) => Json(json!({ "ok": true, "referrer": req.referrer })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_block_ip(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<IpActionReq>,
) -> Response {
    if let Err(e) = st.verify_admin(&headers) {
        return st.err_response(&headers, e);
    }
    match ClientIp::parse(&req.ip) {
        Ok(ip) => {
            st.risk.block_ip(&ip);
            Json(json!({ "ok": true, "blocked": ip.as_str() })).into_response()
        }
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_unblock_ip(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<IpActionReq>,
) -> Response {
    if let Err(e) = st.verify_admin(&headers) {
        return st.err_response(&headers, e);
    }
    match ClientIp::parse(&req.ip) {
        Ok(ip) => {
            st.risk.unblock_ip(&ip);
            Json(json!({ "ok": true, "unblocked": ip.as_str() })).into_response()
        }
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_topup(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TopupReq>,
) -> Response {
    if let Err(e) = st.verify_admin(&headers) {
        return st.err_response(&headers, e);
    }
    let bps = st.runtime.cfg.security.affiliate_rate_bps;
    match st.ledger.credit_real_topup(&req.order_id, &req.username, req.credits, bps).await {
        Ok(comm) => Json(json!({ "ok": true, "credited": req.credits, "affiliate_commission": comm })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Lilyco AI-Native MCP JSON-RPC 2.0 endpoint (zero UI, agent-callable).
pub async fn api_mcp(State(st): State<AppState>, Json(req): Json<McpReq>) -> impl IntoResponse {
    let id = req.id.unwrap_or(json!(1));
    match req.method.as_str() {
        "initialize" => Json(json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "protocolVersion": "2024-11-05", "serverInfo": { "name": "lilyco-relay", "version": "0.1.0" }, "capabilities": { "tools": {} } }
        })),
        "tools/list" => Json(json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": [
                { "name": "list_models", "description": "List available AI models and pricing", "inputSchema": { "type": "object", "properties": {} } },
                { "name": "risk_status", "description": "Inspect live IP & key risk control telemetry", "inputSchema": { "type": "object", "properties": {} } }
            ] }
        })),
        "tools/call" => {
            let name = req.params.and_then(|p| p.name).unwrap_or_default();
            let text = match name.as_str() {
                "list_models" => serde_json::to_string(&st.router.catalog().models).unwrap_or_default(),
                "risk_status" => serde_json::to_string(&st.risk.stats()).unwrap_or_default(),
                _ => "unknown tool".to_string(),
            };
            Json(json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }] } }))
        }
        _ => Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })),
    }
}
