//! Full new-api compatible Data-Plane & Control-Plane endpoints.
//! - Data Plane: `/v1/completions`, `/v1/moderations`, `/v1/messages/count_tokens`,
//!   `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/images/edits`,
//!   `/v1/dashboard/billing/{subscription,usage,credit_grants}`
//! - Control Plane: `/api/v1/pricing`, `/api/v1/options/public`, `/api/v1/dashboard/breakdown`,
//!   `PUT /api/v1/keys/{id}`, `PATCH /api/v1/admin/channels/{id}/toggle`,
//!   `POST /api/v1/admin/channels/probe-all`, `GET/DELETE /api/v1/admin/redemptions`,
//!   `GET/PUT /api/v1/admin/options`

use std::net::SocketAddr;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::Json;
use relay_core::{
    ChannelToggleReq, KeyUpdateReq, OptionUpdateReq, PricingRate, RelayError, TokenUsage,
};
use serde_json::{Value, json};

use crate::handlers::{client_ip_from, resolve_portal_user, verify_admin_access};
use crate::state::AppState;

const MAX_MULTIPART_BYTES: usize = 25 * 1024 * 1024;
const CREDITS_PER_USD: f64 = 72.0; // 1 CNY = 10 credits, ~7.2 CNY/USD

fn extract_any_api_key(headers: &HeaderMap) -> Option<String> {
    if let Some(k) = AppState::extract_bearer(headers) {
        return Some(k);
    }
    for name in ["x-api-key", "x-goog-api-key"] {
        if let Some(v) = headers.get(name).and_then(|h| h.to_str().ok()).map(str::trim)
            && !v.is_empty()
        {
            return Some(v.to_string());
        }
    }
    None
}

/// Extract `model` form field from raw multipart/form-data bytes without extra dependencies.
pub fn extract_multipart_model(body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let marker = "name=\"model\"";
    let pos = text.find(marker)?;
    let rest = &text[pos + marker.len()..];
    let sep = if let Some(i) = rest.find("\r\n\r\n") {
        &rest[i + 4..]
    } else if let Some(i) = rest.find("\n\n") {
        &rest[i + 2..]
    } else {
        return None;
    };
    let val = sep
        .split(['\r', '\n'])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 128)?;
    Some(val.to_string())
}

async fn forward_generic_json(
    st: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    path_suffix: &str,
    body: Value,
) -> Response {
    let ip = match client_ip_from(st, peer, headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(headers, e),
    };
    if let Err(e) = st.risk.check_ip(&ip) {
        return st.err_response(headers, e);
    }
    let Some(model_id) = body.get("model").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) else {
        return st.err_response(headers, RelayError::InvalidInput("missing model field".into()));
    };
    let Some(raw_key) = extract_any_api_key(headers) else {
        st.risk.record_auth_failure(&ip);
        return st.err_response(headers, RelayError::Unauthorized("missing api key".into()));
    };
    let Some(model) = st.router.find_model(model_id) else {
        return st.err_response(headers, RelayError::ModelNotFound(format!("unknown model {model_id}")));
    };
    let verified = match st.ledger.verify_api_key(&raw_key, &model.id).await {
        Ok(k) => k,
        Err(e) => {
            st.risk.record_auth_failure(&ip);
            return st.err_response(headers, e);
        }
    };
    if let Err(e) = st.risk.check_key_ip_whitelist(&ip, &verified.allowed_ips) {
        return st.err_response(headers, e);
    }
    let policy = match st.ledger.get_user_policy(&verified.record.username).await {
        Ok(p) => p,
        Err(e) => return st.err_response(headers, e),
    };
    if policy.banned {
        return st.err_response(headers, RelayError::Forbidden("account is suspended".into()));
    }
    let rate = PricingRate {
        input_per_m: model.input_per_m,
        output_per_m: model.output_per_m,
        allow_free: model.allow_free,
    };
    let est_in = (body.to_string().len() / 4).max(64) as u64;
    let est_hold = policy.apply_discount(rate.calculate_credits(TokenUsage {
        prompt_tokens: est_in,
        completion_tokens: 256,
    }));
    if let Err(e) = st.risk.check_key_spend(&verified.record.id, est_hold) {
        return st.err_response(headers, e);
    }
    let hold = match st.ledger.pre_hold_paid(&verified.record, est_hold).await {
        Ok(h) => h,
        Err(e) => return st.err_response(headers, e),
    };
    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    match st.router.forward_json_endpoint_with_pool(&model, path_suffix, &body, &pool).await {
        Ok(val) => {
            let p = val.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(est_in);
            let c = val.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(64);
            let usage = TokenUsage { prompt_tokens: p, completion_tokens: c };
            let actual = policy.apply_discount(rate.calculate_credits(usage));
            let _ = st.ledger.settle_hold(&hold, &model.id, usage, actual).await;
            Json(val).into_response()
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &model.id).await;
            st.err_response(headers, e)
        }
    }
}

/// Legacy OpenAI text completions (`POST /v1/completions`).
pub async fn api_openai_completions(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    forward_generic_json(&st, peer, &headers, "completions", body).await
}

/// OpenAI content moderation (`POST /v1/moderations`).
pub async fn api_openai_moderations(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    if body.get("model").is_none()
        && let Some(obj) = body.as_object_mut()
    {
        obj.insert("model".into(), json!("omni-moderation-latest"));
    }
    forward_generic_json(&st, peer, &headers, "moderations", body).await
}

/// Anthropic token counter (`POST /v1/messages/count_tokens`) for Claude Code SDKs.
pub async fn api_anthropic_count_tokens(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    if let Err(e) = st.risk.check_ip(&ip) {
        return st.err_response(&headers, e);
    }
    let Some(raw_key) = extract_any_api_key(&headers) else {
        st.risk.record_auth_failure(&ip);
        return st.err_response(&headers, RelayError::Unauthorized("missing api key".into()));
    };
    if let Err(e) = st.ledger.verify_api_key(&raw_key, "").await {
        return st.err_response(&headers, e);
    }
    let raw_len = body.to_string().len() as u64;
    let est_tokens = (raw_len / 3).max(1);
    Json(json!({ "input_tokens": est_tokens })).into_response()
}

async fn forward_multipart_endpoint(
    st: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    path_suffix: &str,
    default_model: &str,
    body: Bytes,
) -> Response {
    let ip = match client_ip_from(st, peer, headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(headers, e),
    };
    if let Err(e) = st.risk.check_ip(&ip) {
        return st.err_response(headers, e);
    }
    if body.is_empty() || body.len() > MAX_MULTIPART_BYTES {
        return st.err_response(headers, RelayError::InvalidInput("multipart payload must be 1B..25MB".into()));
    }
    let Some(raw_key) = extract_any_api_key(headers) else {
        st.risk.record_auth_failure(&ip);
        return st.err_response(headers, RelayError::Unauthorized("missing api key".into()));
    };
    let model_id = extract_multipart_model(&body).unwrap_or_else(|| default_model.to_string());
    let model = st
        .router
        .find_model(&model_id)
        .unwrap_or_else(|| relay_core::ModelConfig {
            id: model_id.clone(),
            channel_id: String::new(),
            upstream_model: model_id.clone(),
            input_per_m: 10,
            output_per_m: 10,
            allow_free: false,
            billing_mode: relay_core::BillingMode::PerCall,
            unit_credits: 2,
        });
    let verified = match st.ledger.verify_api_key(&raw_key, &model.id).await {
        Ok(k) => k,
        Err(e) => {
            st.risk.record_auth_failure(&ip);
            return st.err_response(headers, e);
        }
    };
    if let Err(e) = st.risk.check_key_ip_whitelist(&ip, &verified.allowed_ips) {
        return st.err_response(headers, e);
    }
    let policy = match st.ledger.get_user_policy(&verified.record.username).await {
        Ok(p) => p,
        Err(e) => return st.err_response(headers, e),
    };
    if policy.banned {
        return st.err_response(headers, RelayError::Forbidden("account is suspended".into()));
    }
    let hold_cost = policy.apply_discount(model.compute_fixed_cost(1));
    if let Err(e) = st.risk.check_key_spend(&verified.record.id, hold_cost) {
        return st.err_response(headers, e);
    }
    let hold = match st.ledger.pre_hold_paid(&verified.record, hold_cost).await {
        Ok(h) => h,
        Err(e) => return st.err_response(headers, e),
    };
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("multipart/form-data");
    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    match st.router.forward_raw_bytes_with_pool(path_suffix, ct, body, &pool).await {
        Ok((code, resp_ct, bytes)) => {
            let _ = st.ledger.settle_hold(&hold, &model.id, TokenUsage::default(), hold_cost).await;
            let status = StatusCode::from_u16(code).unwrap_or(StatusCode::OK);
            let mut resp = (status, bytes).into_response();
            if let Ok(hv) = HeaderValue::from_str(&resp_ct) {
                resp.headers_mut().insert(header::CONTENT_TYPE, hv);
            }
            resp
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &model.id).await;
            st.err_response(headers, e)
        }
    }
}

/// Whisper / STT transcription (`POST /v1/audio/transcriptions`).
pub async fn api_audio_transcriptions(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    forward_multipart_endpoint(&st, peer, &headers, "audio/transcriptions", "whisper-1", body).await
}

/// Whisper / STT translation (`POST /v1/audio/translations`).
pub async fn api_audio_translations(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    forward_multipart_endpoint(&st, peer, &headers, "audio/translations", "whisper-1", body).await
}

/// OpenAI image edits (`POST /v1/images/edits`).
pub async fn api_images_edits(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    forward_multipart_endpoint(&st, peer, &headers, "images/edits", "dall-e-2", body).await
}

/// OpenAI-compatible billing subscription (`GET /v1/dashboard/billing/subscription`).
pub async fn api_billing_subscription(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(raw_key) = extract_any_api_key(&headers) else {
        return st.err_response(&headers, RelayError::Unauthorized("missing api key".into()));
    };
    let (key, wallet) = match st.ledger.verify_key_for_billing(&raw_key).await {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let hard_credits = if key.quota_limit > 0 {
        key.quota_limit.min(wallet.paid_credits.saturating_add(key.used_credits))
    } else {
        wallet.paid_credits.saturating_add(key.used_credits)
    };
    let hard_usd = (hard_credits as f64) / CREDITS_PER_USD;
    Json(json!({
        "object": "billing_subscription",
        "has_payment_method": true,
        "hard_limit_usd": hard_usd,
        "system_hard_limit_usd": hard_usd,
        "credits_remaining": wallet.paid_credits,
        "key_quota_limit": key.quota_limit
    }))
    .into_response()
}

/// OpenAI-compatible billing usage (`GET /v1/dashboard/billing/usage`).
pub async fn api_billing_usage(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(raw_key) = extract_any_api_key(&headers) else {
        return st.err_response(&headers, RelayError::Unauthorized("missing api key".into()));
    };
    let (key, _) = match st.ledger.verify_key_for_billing(&raw_key).await {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let used_cents = ((key.used_credits as f64) / CREDITS_PER_USD) * 100.0;
    Json(json!({
        "object": "list",
        "total_usage": used_cents,
        "credits_used": key.used_credits
    }))
    .into_response()
}

/// OpenAI-compatible credit grants (`GET /v1/dashboard/billing/credit_grants`).
pub async fn api_billing_credit_grants(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(raw_key) = extract_any_api_key(&headers) else {
        return st.err_response(&headers, RelayError::Unauthorized("missing api key".into()));
    };
    let (key, wallet) = match st.ledger.verify_key_for_billing(&raw_key).await {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let avail_credits = if key.quota_limit > 0 {
        key.quota_limit.saturating_sub(key.used_credits).min(wallet.paid_credits)
    } else {
        wallet.paid_credits
    };
    let total_used = (key.used_credits as f64) / CREDITS_PER_USD;
    let total_avail = (avail_credits as f64) / CREDITS_PER_USD;
    Json(json!({
        "object": "credit_summary",
        "total_granted": total_used + total_avail,
        "total_used": total_used,
        "total_available": total_avail,
        "credits_available": avail_credits,
        "credits_used": key.used_credits
    }))
    .into_response()
}

// === Control Plane Extensions ===

/// Public pricing catalog (`GET /api/v1/pricing`) with group discounts, exchange rate & all model rates.
pub async fn api_public_pricing(State(st): State<AppState>) -> impl IntoResponse {
    let models: Vec<_> = st
        .router
        .all_models()
        .into_iter()
        .map(|m| {
            json!({
                "id": m.id,
                "owned_by": m.channel_id,
                "billing_mode": m.billing_mode,
                "input_per_m": m.input_per_m,
                "output_per_m": m.output_per_m,
                "unit_credits": m.unit_credits,
                "allow_free": m.allow_free
            })
        })
        .collect();
    Json(json!({
        "ok": true,
        "credits_per_cny": 10,
        "group_ratios": { "guest": 1.0, "user": 1.0, "vip": 0.85, "admin": 0.5 },
        "data": models
    }))
}

/// Public non-secret site options (`GET /api/v1/options/public`).
pub async fn api_public_options(State(st): State<AppState>) -> impl IntoResponse {
    let all = st.ledger.get_options().await.unwrap_or_default();
    let allow = ["site_name", "site_notice", "support_url", "icp_beian", "footer_text"];
    let mut pub_map = serde_json::Map::new();
    for k in allow {
        if let Some(v) = all.get(k) {
            pub_map.insert(k.to_string(), json!(v));
        }
    }
    Json(json!({ "ok": true, "options": pub_map }))
}

/// Per-model usage breakdown (`GET /api/v1/dashboard/breakdown`).
pub async fn api_dashboard_breakdown(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if verify_admin_access(&st, &headers).await.is_ok() {
        return match st.ledger.usage_breakdown_by_model(None, 30).await {
            Ok(items) => Json(json!({ "ok": true, "scope": "all", "items": items })).into_response(),
            Err(e) => st.err_response(&headers, e),
        };
    }
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.usage_breakdown_by_model(Some(&uname), 30).await {
        Ok(items) => Json(json!({ "ok": true, "scope": "own", "items": items })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Update an API key (`PUT /api/v1/keys/{id}`).
pub async fn api_update_key(
    State(st): State<AppState>,
    Path(key_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<KeyUpdateReq>,
) -> Response {
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.update_key(&uname, &key_id, &req).await {
        Ok(()) => Json(json!({ "ok": true, "updated": key_id })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Quick toggle channel enabled state (`PATCH /api/v1/admin/channels/{id}/toggle`).
pub async fn api_admin_toggle_channel(
    State(st): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<ChannelToggleReq>,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.toggle_channel(&id, req.enabled).await {
        Ok(()) => Json(json!({ "ok": true, "id": id, "enabled": req.enabled })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Batch probe all enabled channels (`POST /api/v1/admin/channels/probe-all`).
pub async fn api_admin_probe_all_channels(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    let channels = match st.ledger.list_channels().await {
        Ok(c) => c,
        Err(e) => return st.err_response(&headers, e),
    };
    let mut results = Vec::new();
    for rec in channels {
        if !rec.meta.enabled {
            continue;
        }
        if let Ok(live) = st.ledger.get_live_channel(&rec.id).await {
            let pr = st.router.probe_channel(&live).await;
            results.push(json!({
                "id": rec.id,
                "provider": rec.provider,
                "ok": pr.ok,
                "latency_ms": pr.latency_ms,
                "models_count": pr.models_count,
                "balance_text": pr.balance_text
            }));
        }
    }
    Json(json!({ "ok": true, "count": results.len(), "results": results })).into_response()
}

/// List all redemption codes (`GET /api/v1/admin/redemptions`).
pub async fn api_admin_list_redemptions(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.list_redemptions(100).await {
        Ok(items) => Json(json!({ "ok": true, "redemptions": items })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Delete an unused redemption code (`DELETE /api/v1/admin/redemptions/{code}`).
pub async fn api_admin_delete_redemption(
    State(st): State<AppState>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.delete_redemption(&code).await {
        Ok(()) => Json(json!({ "ok": true, "deleted": code })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Read all system options (`GET /api/v1/admin/options`).
pub async fn api_admin_get_options(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.get_options().await {
        Ok(options) => Json(json!({ "ok": true, "options": options })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Update a system option (`PUT /api/v1/admin/options`).
pub async fn api_admin_set_option(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<OptionUpdateReq>,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    match st.ledger.set_option(&req.key, &req.value).await {
        Ok(()) => Json(json!({ "ok": true, "key": req.key, "value": req.value })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_model_from_multipart_form() {
        let body = b"--bound\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n--bound--\r\n";
        assert_eq!(extract_multipart_model(body).as_deref(), Some("whisper-1"));
    }
}
