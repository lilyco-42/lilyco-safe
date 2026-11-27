use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use relay_core::{
    AnthropicMsgReq, ChatReq, ClientIp, EmbeddingReq, ImageGenReq, PricingRate, RelayError,
    RerankReq, TokenUsage, UserRolePolicy,
};
use relay_engine::{HoldReceipt, UpstreamReply};
use serde::Deserialize;
use serde_json::json;

use super::client_ip_from;
use crate::state::AppState;


pub async fn api_health(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "lilyco-relay",
        "license": "MIT",
        "models_count": st.router.all_models().len(),
        "risk": st.risk.stats()
    }))
}

pub async fn api_list_models(State(st): State<AppState>) -> impl IntoResponse {
    let data: Vec<_> = st
        .router
        .all_models()
        .into_iter()
        .map(|m| {
            json!({
                "id": m.id,
                "object": "model",
                "owned_by": m.channel_id,
                "input_per_m": m.input_per_m,
                "output_per_m": m.output_per_m,
                "allow_free": m.allow_free,
                "billing_mode": m.billing_mode,
                "unit_credits": m.unit_credits
            })
        })
        .collect();
    Json(json!({ "object": "list", "data": data }))
}

pub async fn api_model_companies(State(st): State<AppState>) -> impl IntoResponse {
    let models = st.router.all_models();
    Json(json!({ "data": crate::model_companies::cards(&models) }))
}

pub(super) async fn execute_chat_pipeline<T, Finish>(
    st: &AppState,
    client: (&ClientIp, &HeaderMap),
    req: &ChatReq,
    finalize: impl FnOnce(UpstreamReply) -> Finish,
) -> Result<T, RelayError>
where
    Finish: Future<Output = Result<T, RelayError>>,
{
    let (ip, headers) = client;
    st.risk.check_ip(ip)?;
    req.validate()?;
    let raw_key = AppState::extract_bearer(headers).ok_or_else(|| {
        st.risk.record_auth_failure(ip);
        RelayError::Unauthorized("missing bearer api key".into())
    })?;
    let model = st
        .router
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

    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    let result = match st.router.call_chat_with_pool(&model, req, &pool).await {
        Ok(reply) => {
            let usage = reply.usage;
            finalize(reply).await.map(|output| (output, usage))
        }
        Err(error) => Err(error),
    };
    match result {
        Ok((output, usage)) => {
            let actual = policy.apply_discount(rate.calculate_credits(usage));
            let _ = st.ledger.settle_hold(&hold, &model.id, usage, actual).await;
            Ok(output)
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
    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    match st.router.open_chat_stream_with_pool(&model, req, &pool).await {
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
    let reply = match execute_chat_pipeline(&st, (&ip, &headers), &req, |reply| async { Ok(reply) }).await {
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
    mut headers: HeaderMap,
    Json(req): Json<AnthropicMsgReq>,
) -> Response {
    // Support native Anthropic `x-api-key` header in addition to `Authorization: Bearer` (for Claude Code).
    if AppState::extract_bearer(&headers).is_none()
        && let Some(raw) = headers.get("x-api-key").and_then(|v| v.to_str().ok()).map(str::trim)
        && !raw.is_empty()
        && let Ok(val) = HeaderValue::from_str(&format!("Bearer {raw}"))
    {
        headers.insert(header::AUTHORIZATION, val);
    }
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let chat_req = match req.to_chat_req() {
        Ok(c) => c,
        Err(e) => return st.err_response(&headers, e),
    };
    let reply = match execute_chat_pipeline(&st, (&ip, &headers), &chat_req, |reply| async { Ok(reply) }).await {
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


pub async fn api_get_model(
    State(st): State<AppState>,
    Path(model_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(m) = st.router.find_model(&model_id) else {
        return st.err_response(&headers, RelayError::ModelNotFound(model_id));
    };
    Json(json!({
        "id": m.id, "object": "model", "owned_by": m.channel_id,
        "input_per_m": m.input_per_m, "output_per_m": m.output_per_m, "allow_free": m.allow_free,
        "billing_mode": m.billing_mode, "unit_credits": m.unit_credits
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
        .find_model(model_id)
        .ok_or_else(|| RelayError::ModelNotFound(format!("unknown model {model_id}")))?;
    let verified = st.ledger.verify_api_key(&raw_key, &model.id).await?;
    st.risk.check_key_ip_whitelist(ip, &verified.allowed_ips)?;
    let policy = st.ledger.get_user_policy(&verified.record.username).await?;
    if policy.banned {
        return Err(RelayError::Forbidden("account is suspended".into()));
    }
    let hold_cost = policy.apply_discount(model.compute_fixed_cost(1));
    st.risk.check_key_spend(&verified.record.id, hold_cost)?;
    let hold = st.ledger.pre_hold_paid(&verified.record, hold_cost).await?;
    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    match st
        .router
        .forward_json_endpoint_with_pool(&model, path_suffix, body, &pool)
        .await
    {
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


/// OpenAI Responses API passthrough (`POST /v1/responses`) for Codex & modern OpenAI SDKs.
pub async fn api_openai_responses(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let Some(model_id) = body.get("model").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) else {
        return st.err_response(&headers, RelayError::InvalidInput("missing model field".into()));
    };
    if let Err(e) = st.risk.check_ip(&ip) {
        return st.err_response(&headers, e);
    }
    let Some(raw_key) = AppState::extract_bearer(&headers) else {
        st.risk.record_auth_failure(&ip);
        return st.err_response(&headers, RelayError::Unauthorized("missing bearer api key".into()));
    };
    let Some(model) = st.router.find_model(model_id) else {
        return st.err_response(&headers, RelayError::ModelNotFound(format!("unknown model {model_id}")));
    };
    let verified = match st.ledger.verify_api_key(&raw_key, &model.id).await {
        Ok(k) => k,
        Err(e) => {
            st.risk.record_auth_failure(&ip);
            return st.err_response(&headers, e);
        }
    };
    if let Err(e) = st.risk.check_key_ip_whitelist(&ip, &verified.allowed_ips) {
        return st.err_response(&headers, e);
    }
    let policy = match st.ledger.get_user_policy(&verified.record.username).await {
        Ok(p) => p,
        Err(e) => return st.err_response(&headers, e),
    };
    if policy.banned {
        return st.err_response(&headers, RelayError::Forbidden("account is suspended".into()));
    }
    let rate = PricingRate {
        input_per_m: model.input_per_m,
        output_per_m: model.output_per_m,
        allow_free: model.allow_free,
    };
    let est_tokens = (body.to_string().len() / 4).max(128) as u64;
    let est_hold = policy.apply_discount(rate.calculate_credits(TokenUsage {
        prompt_tokens: est_tokens,
        completion_tokens: 512,
    }));
    if let Err(e) = st.risk.check_key_spend(&verified.record.id, est_hold) {
        return st.err_response(&headers, e);
    }
    let hold = match st.ledger.pre_hold_paid(&verified.record, est_hold).await {
        Ok(h) => h,
        Err(e) => return st.err_response(&headers, e),
    };
    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    match st.router.forward_json_endpoint_with_pool(&model, "responses", &body, &pool).await {
        Ok(val) => {
            let p = val.pointer("/usage/input_tokens").and_then(|x| x.as_u64()).unwrap_or(est_tokens);
            let c = val.pointer("/usage/output_tokens").and_then(|x| x.as_u64()).unwrap_or(128);
            let usage = TokenUsage { prompt_tokens: p, completion_tokens: c };
            let actual = policy.apply_discount(rate.calculate_credits(usage));
            let _ = st.ledger.settle_hold(&hold, &model.id, usage, actual).await;
            Json(val).into_response()
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &model.id).await;
            st.err_response(&headers, e)
        }
    }
}

/// Extract Relay API key from `x-goog-api-key`, `Authorization: Bearer`, or `?key=...` query param.
fn extract_google_or_bearer_key(headers: &HeaderMap, query_key: Option<&str>) -> Option<String> {
    if let Some(k) = headers.get("x-goog-api-key").and_then(|v| v.to_str().ok()).map(str::trim)
        && !k.is_empty()
    {
        return Some(k.to_string());
    }
    if let Some(k) = AppState::extract_bearer(headers) {
        return Some(k);
    }
    query_key.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

#[derive(Deserialize, Default)]
pub struct GeminiKeyQuery {
    pub key: Option<String>,
}

/// Native Google Gemini REST passthrough (`POST /v1beta/models/{*model_action}`) for `gemini-api-cli`.
pub async fn api_gemini_v1beta(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(model_action): Path<String>,
    axum::extract::Query(q): axum::extract::Query<GeminiKeyQuery>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let ip = match client_ip_from(&st, peer, &headers) {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    if let Err(e) = st.risk.check_ip(&ip) {
        return st.err_response(&headers, e);
    }
    let Some((model_id, action)) = model_action.trim().trim_start_matches('/').rsplit_once(':') else {
        return st.err_response(&headers, RelayError::InvalidInput("expected {model}:{action}".into()));
    };
    let Some(raw_key) = extract_google_or_bearer_key(&headers, q.key.as_deref()) else {
        st.risk.record_auth_failure(&ip);
        return st.err_response(&headers, RelayError::Unauthorized("missing x-goog-api-key or bearer key".into()));
    };
    let Some(model) = st.router.find_model(model_id) else {
        return st.err_response(&headers, RelayError::ModelNotFound(format!("unknown model {model_id}")));
    };
    let verified = match st.ledger.verify_api_key(&raw_key, &model.id).await {
        Ok(k) => k,
        Err(e) => {
            st.risk.record_auth_failure(&ip);
            return st.err_response(&headers, e);
        }
    };
    if let Err(e) = st.risk.check_key_ip_whitelist(&ip, &verified.allowed_ips) {
        return st.err_response(&headers, e);
    }
    let policy = match st.ledger.get_user_policy(&verified.record.username).await {
        Ok(p) => p,
        Err(e) => return st.err_response(&headers, e),
    };
    if policy.banned {
        return st.err_response(&headers, RelayError::Forbidden("account is suspended".into()));
    }
    let rate = PricingRate {
        input_per_m: model.input_per_m,
        output_per_m: model.output_per_m,
        allow_free: model.allow_free,
    };
    let est_tokens = (body.to_string().len() / 4).max(128) as u64;
    let raw_est = if model.billing_mode == relay_core::BillingMode::Token {
        rate.calculate_credits(TokenUsage { prompt_tokens: est_tokens, completion_tokens: 512 })
    } else {
        model.compute_fixed_cost(1)
    };
    let est_hold = policy.apply_discount(raw_est);
    if let Err(e) = st.risk.check_key_spend(&verified.record.id, est_hold) {
        return st.err_response(&headers, e);
    }
    let hold = match st.ledger.pre_hold_paid(&verified.record, est_hold).await {
        Ok(h) => h,
        Err(e) => return st.err_response(&headers, e),
    };
    let pool = st.ledger.find_live_channels_with_owner(&model.id, &model.channel_id).await.unwrap_or_default();
    match st.router.call_gemini_v1beta_with_pool(&model, action, &body, &pool).await {
        Ok(val) => {
            let p = val.pointer("/usageMetadata/promptTokenCount").and_then(|x| x.as_u64()).unwrap_or(est_tokens);
            let c = val.pointer("/usageMetadata/candidatesTokenCount").and_then(|x| x.as_u64()).unwrap_or(128);
            let usage = TokenUsage { prompt_tokens: p, completion_tokens: c };
            let raw_actual = if model.billing_mode == relay_core::BillingMode::Token {
                rate.calculate_credits(usage)
            } else {
                model.compute_fixed_cost(1)
            };
            let actual = policy.apply_discount(raw_actual);
            let _ = st.ledger.settle_hold(&hold, &model.id, usage, actual).await;
            Json(val).into_response()
        }
        Err(e) => {
            let _ = st.ledger.refund_hold(&hold, &model.id).await;
            st.err_response(&headers, e)
        }
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

