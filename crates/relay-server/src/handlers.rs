use std::convert::Infallible;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use relay_core::{
    ActivateTrialReq, AdminRoleUpdateReq, AnthropicMsgReq, ChannelUpsertReq, ChatReq, ClientIp,
    EmbeddingReq, ImageGenReq, KeyIssueReq, PortalAuthReq, PricingRate, RedeemCodeReq,
    RedemptionCreateReq, RelayError, RerankReq, ResellKeyBatchReq, TokenUsage, UserRole,
    UserRolePolicy,
};
use relay_engine::{HoldReceipt, UpstreamReply};
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
    let verified = match st.ledger.verify_api_key(&raw_key, &model.id).await {
        Ok(k) => k,
        Err(e) => {
            st.risk.record_auth_failure(ip);
            return Err(e);
        }
    };
    st.risk.check_key_ip_whitelist(ip, &verified.allowed_ips)?;
    let key_rec = verified.record;
    let policy = st.ledger.get_user_policy(&key_rec.username).await?;
    if policy.banned {
        return Err(RelayError::Forbidden("account is suspended".into()));
    }
    let rate = PricingRate {
        input_per_m: model.input_per_m,
        output_per_m: model.output_per_m,
        allow_free: model.allow_free,
    };
    let est_out = req.max_tokens.unwrap_or(512) as u64;
    let raw_est = rate.calculate_credits(relay_core::TokenUsage {
        prompt_tokens: req.estimate_prompt_tokens(),
        completion_tokens: est_out,
    });
    let est_hold = policy.apply_discount(raw_est);
    st.risk.check_key_spend(&key_rec.id, est_hold)?;
    let hold = st.ledger.pre_hold_paid(&key_rec, est_hold).await?;

    let pool = st.ledger.find_live_channels(&model.id).await.unwrap_or_default();
    match st.router.call_chat_with_pool(model, req, &pool).await {
        Ok(reply) => {
            let actual = policy.apply_discount(rate.calculate_credits(reply.usage));
            let _ = st.ledger.settle_hold(&hold, &model.id, reply.usage, actual).await;
            Ok(reply)
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &model.id).await;
            Err(e)
        }
    }
}

struct StreamBilling {
    hold: HoldReceipt,
    model_id: String,
    rate: PricingRate,
    policy: UserRolePolicy,
}

async fn open_chat_stream_pipeline(
    st: &AppState,
    ip: &ClientIp,
    headers: &HeaderMap,
    req: &ChatReq,
) -> Result<(reqwest::Response, StreamBilling, u64), RelayError> {
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
    let verified = match st.ledger.verify_api_key(&raw_key, &model.id).await {
        Ok(k) => k,
        Err(e) => {
            st.risk.record_auth_failure(ip);
            return Err(e);
        }
    };
    st.risk.check_key_ip_whitelist(ip, &verified.allowed_ips)?;
    let key_rec = verified.record;
    let policy = st.ledger.get_user_policy(&key_rec.username).await?;
    if policy.banned {
        return Err(RelayError::Forbidden("account is suspended".into()));
    }
    let rate = PricingRate {
        input_per_m: model.input_per_m,
        output_per_m: model.output_per_m,
        allow_free: model.allow_free,
    };
    let prompt_est = req.estimate_prompt_tokens();
    let est_out = req.max_tokens.unwrap_or(512) as u64;
    let est_hold = policy.apply_discount(rate.calculate_credits(TokenUsage {
        prompt_tokens: prompt_est,
        completion_tokens: est_out,
    }));
    st.risk.check_key_spend(&key_rec.id, est_hold)?;
    let hold = st.ledger.pre_hold_paid(&key_rec, est_hold).await?;
    let pool = st.ledger.find_live_channels(&model.id).await.unwrap_or_default();
    match st.router.open_chat_stream_with_pool(model, req, &pool).await {
        Ok(resp) => Ok((
            resp,
            StreamBilling { hold, model_id: model.id.clone(), rate, policy },
            prompt_est,
        )),
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
    if req.stream {
        let (upstream_resp, billing, prompt_est) =
            match open_chat_stream_pipeline(&st, &ip, &headers, &req).await {
                Ok(v) => v,
                Err(e) => return st.err_response(&headers, e),
            };
        let ledger = st.ledger.clone();
        let stream = async_stream::stream! {
            let mut es = upstream_resp.bytes_stream().eventsource();
            let mut final_usage: Option<TokenUsage> = None;
            let mut est_chars: u64 = 0;
            let mut saw_done = false;
            while let Some(item) = es.next().await {
                if let Ok(ev) = item {
                    let data = ev.data;
                    if data.trim() == "[DONE]" {
                        saw_done = true;
                        yield Ok::<Event, Infallible>(Event::default().data("[DONE]"));
                        break;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                        if let Some(u) = v.get("usage")
                            && u.is_object()
                        {
                            let p = u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(prompt_est);
                            let c = u.get("completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                            if p > 0 || c > 0 {
                                final_usage = Some(TokenUsage { prompt_tokens: p, completion_tokens: c });
                            }
                        }
                        if let Some(delta) = v.pointer("/choices/0/delta/content").and_then(|x| x.as_str()) {
                            est_chars = est_chars.saturating_add(delta.len() as u64);
                        }
                    }
                    yield Ok::<Event, Infallible>(Event::default().data(data));
                }
            }
            if !saw_done {
                yield Ok::<Event, Infallible>(Event::default().data("[DONE]"));
            }
            let usage = final_usage.unwrap_or(TokenUsage {
                prompt_tokens: prompt_est,
                completion_tokens: (est_chars / 3).max(1),
            });
            let actual = billing.policy.apply_discount(billing.rate.calculate_credits(usage));
            let _ = ledger.settle_hold(&billing.hold, &billing.model_id, usage, actual).await;
        };
        let mut resp = Sse::new(stream).keep_alive(KeepAlive::default()).into_response();
        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        resp.headers_mut().insert("x-accel-buffering", HeaderValue::from_static("no"));
        return resp;
    }
    let reply = match execute_chat_pipeline(&st, &ip, &headers, &req).await {
        Ok(r) => r,
        Err(e) => return st.err_response(&headers, e),
    };
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

/// Allow admin access via either `X-Admin-Key` header OR an authenticated `admin`-role JWT.
async fn verify_admin_access(st: &AppState, headers: &HeaderMap) -> Result<(), RelayError> {
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

pub async fn api_me(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if AppState::extract_bearer(&headers).is_none() {
        return Json(json!({
            "ok": true,
            "authenticated": false,
            "role": UserRole::Guest.as_str(),
            "policy": { "role": "guest", "max_keys": 0, "discount_pct": 0, "banned": false },
            "permissions": UserRole::Guest.permissions()
        }))
        .into_response();
    }
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    let wallet = match st.ledger.get_wallet(&uname).await {
        Ok(w) => w,
        Err(e) => return st.err_response(&headers, e),
    };
    let policy = match st.ledger.get_user_policy(&uname).await {
        Ok(p) => p,
        Err(e) => return st.err_response(&headers, e),
    };
    let keys = st.ledger.list_keys(&uname).await.unwrap_or_default();
    let usage = st.ledger.list_usage(&uname).await.unwrap_or_default();
    let trial_cards = st.ledger.list_trial_cards(&uname).await.unwrap_or_default();
    Json(json!({
        "ok": true,
        "authenticated": true,
        "role": policy.role.as_str(),
        "policy": policy,
        "permissions": policy.role.permissions(),
        "wallet": wallet,
        "keys": keys,
        "usage": usage,
        "trial_cards": trial_cards,
        "referral_code": uname
    }))
    .into_response()
}

async fn proxy_portal_auth(st: &AppState, endpoint: &str, req: &PortalAuthReq) -> Response {
    let origin = st
        .runtime
        .cfg
        .server
        .portal_verify_url
        .trim_end_matches("/studio/api/me")
        .trim_end_matches('/');
    let url = format!("{origin}/studio/api/{endpoint}");
    let body = if endpoint == "register" {
        json!({
            "username": req.username,
            "password": req.password,
            "email": req.email.clone().unwrap_or_else(|| format!("{}@lain42.top", req.username))
        })
    } else {
        json!({ "username": req.username, "password": req.password })
    };
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(12)).build() {
        Ok(c) => c,
        Err(e) => return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "ok": false, "message": e.to_string() }))).into_response(),
    };
    match client.post(&url).json(&body).send().await {
        Ok(resp) => {
            let status = axum::http::StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
            let val: serde_json::Value = resp.json().await.unwrap_or_else(|_| json!({ "ok": false, "message": "portal invalid json" }));
            (status, Json(val)).into_response()
        }
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "message": format!("lain42.top auth unreachable: {e}") })),
        )
            .into_response(),
    }
}

pub async fn api_portal_login(State(st): State<AppState>, Json(req): Json<PortalAuthReq>) -> Response {
    proxy_portal_auth(&st, "login", &req).await
}

pub async fn api_portal_register(State(st): State<AppState>, Json(req): Json<PortalAuthReq>) -> Response {
    proxy_portal_auth(&st, "register", &req).await
}

pub async fn api_activate_trial_card(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ActivateTrialReq>,
) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.activate_trial_card(&uname, &req.card_id).await {
        Ok(expires_unix) => Json(json!({ "ok": true, "card_id": req.card_id, "expires_unix": expires_unix })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
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
    let policy = match st.ledger.get_user_policy(&uname).await {
        Ok(p) => p,
        Err(e) => return st.err_response(&headers, e),
    };
    if policy.banned {
        return st.err_response(&headers, RelayError::Forbidden("account is suspended".into()));
    }
    let active_count = st.ledger.count_active_keys(&uname).await.unwrap_or(0);
    if active_count >= policy.max_keys {
        return st.err_response(
            &headers,
            RelayError::Forbidden(format!(
                "role '{}' max active keys limit ({}) reached; upgrade to VIP for up to 20 keys",
                policy.role.as_str(),
                policy.max_keys
            )),
        );
    }
    match st.ledger.issue_key(&uname, &req).await {
        Ok((secret, rec)) => Json(json!({ "ok": true, "api_key": secret, "key": rec })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_usage_logs(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if verify_admin_access(&st, &headers).await.is_ok() {
        return match st.ledger.list_usage_logs(None, 50).await {
            Ok(logs) => Json(json!({ "ok": true, "scope": "all", "logs": logs })).into_response(),
            Err(e) => st.err_response(&headers, e),
        };
    }
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.list_usage_logs(Some(&uname), 50).await {
        Ok(logs) => Json(json!({ "ok": true, "scope": "own", "logs": logs })).into_response(),
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
    if let Err(e) = verify_admin_access(&st, &headers).await {
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
    if let Err(e) = verify_admin_access(&st, &headers).await {
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
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    let bps = st.runtime.cfg.security.affiliate_rate_bps;
    match st.ledger.credit_real_topup(&req.order_id, &req.username, req.credits, bps).await {
        Ok(comm) => Json(json!({ "ok": true, "credited": req.credits, "affiliate_commission": comm })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_get_model(
    State(st): State<AppState>,
    Path(model_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(m) = st.router.catalog().find_model(&model_id) else {
        return st.err_response(&headers, RelayError::ModelNotFound(model_id));
    };
    Json(json!({
        "id": m.id, "object": "model", "owned_by": m.channel_id,
        "input_per_m": m.input_per_m, "output_per_m": m.output_per_m, "allow_free": m.allow_free
    }))
    .into_response()
}

async fn forward_paid_endpoint<T: serde::Serialize>(
    st: &AppState,
    ip: &ClientIp,
    headers: &HeaderMap,
    model_id: &str,
    path_suffix: &str,
    body: &T,
) -> Result<serde_json::Value, RelayError> {
    st.risk.check_ip(ip)?;
    let raw_key = AppState::extract_bearer(headers).ok_or_else(|| {
        st.risk.record_auth_failure(ip);
        RelayError::Unauthorized("missing bearer api key".into())
    })?;
    let model = st
        .router
        .catalog()
        .find_model(model_id)
        .ok_or_else(|| RelayError::ModelNotFound(format!("unknown model {model_id}")))?;
    let verified = st.ledger.verify_api_key(&raw_key, &model.id).await?;
    st.risk.check_key_ip_whitelist(ip, &verified.allowed_ips)?;
    let hold_cost = if model.allow_free { 0 } else { 1 };
    st.risk.check_key_spend(&verified.record.id, hold_cost)?;
    let hold = st.ledger.pre_hold_paid(&verified.record, hold_cost).await?;
    match st.router.forward_json_endpoint(model, path_suffix, body).await {
        Ok(val) => {
            let _ = st.ledger.settle_hold(&hold, &model.id, relay_core::TokenUsage::default(), hold_cost).await;
            Ok(val)
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &model.id).await;
            Err(e)
        }
    }
}

pub async fn api_embeddings(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<EmbeddingReq>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    match forward_paid_endpoint(&st, &ip, &headers, &req.model, "embeddings", &req).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_images(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ImageGenReq>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    match forward_paid_endpoint(&st, &ip, &headers, &req.model, "images/generations", &req).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_rerank(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RerankReq>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    match forward_paid_endpoint(&st, &ip, &headers, &req.model, "rerank", &req).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_dashboard_stats(State(st): State<AppState>, headers: HeaderMap) -> Response {
    match st.ledger.dashboard_stats().await {
        Ok(stats) => Json(json!({ "ok": true, "stats": stats, "risk": st.risk.stats() })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_redeem(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RedeemCodeReq>,
) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.redeem_code(&uname, &req.code).await {
        Ok((credits, wtype)) => Json(json!({ "ok": true, "credits": credits, "wallet_type": wtype })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_affiliate_transfer(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.transfer_affiliate_to_paid(&uname).await {
        Ok(amt) => Json(json!({ "ok": true, "transferred": amt })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_list_channels(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.list_channels().await {
        Ok(channels) => Json(json!({ "ok": true, "channels": channels })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_upsert_channel(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ChannelUpsertReq>,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.upsert_channel(&req).await {
        Ok(()) => Json(json!({ "ok": true, "channel_id": req.id })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_delete_channel(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.delete_channel(&id).await {
        Ok(()) => Json(json!({ "ok": true, "deleted": id })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_probe_channel(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.get_live_channel(&id).await {
        Ok(ch) => Json(st.router.probe_channel(&ch).await).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_mint_resell_keys(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ResellKeyBatchReq>,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.mint_resell_key_batch(&req).await {
        Ok(keys) => Json(json!({
            "ok": true,
            "count": keys.len(),
            "quota_credits": req.quota_credits,
            "keys": keys
        }))
        .into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_create_redemptions(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RedemptionCreateReq>,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.create_redemptions(&req).await {
        Ok(codes) => Json(json!({ "ok": true, "codes": codes })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_list_users(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.list_users(100).await {
        Ok(users) => Json(json!({ "ok": true, "users": users })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

pub async fn api_admin_update_role(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AdminRoleUpdateReq>,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.set_user_role(&req).await {
        Ok(policy) => Json(json!({ "ok": true, "username": req.username, "policy": policy })).into_response(),
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
