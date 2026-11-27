use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;
use relay_core::{
    ActivateTrialReq, AdminRoleUpdateReq, ChannelUpsertReq, ClientIp, KeyIssueReq,
    ModelPricingOverride, PortalAuthReq, RedeemCodeReq, RedemptionCreateReq, RelayError,
    ResellKeyBatchReq, UserRole,
};
use serde_json::json;

use super::{
    AffiliateBindReq, IpActionReq, McpReq, RevokeKeyReq, TopupReq, resolve_portal_user,
    verify_admin_access,
};
use crate::state::AppState;

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

pub async fn api_admin_sync_models(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    let channels = match st.ledger.list_channels().await {
        Ok(v) => v,
        Err(e) => return st.err_response(&headers, e),
    };
    let mut synced_channels = 0usize;
    let mut added_models = 0usize;
    for rec in &channels {
        if !rec.meta.enabled {
            continue;
        }
        if let Ok(ch) = st.ledger.get_live_channel(&rec.id).await
            && let Ok(n) = st.router.sync_channel_models(&ch).await
        {
            synced_channels += 1;
            added_models += n;
        }
    }
    Json(json!({
        "ok": true,
        "synced_channels": synced_channels,
        "added_models": added_models,
        "total_models": st.router.all_models().len()
    }))
    .into_response()
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

/// Admin live model pricing update (persists to DB + hot-applies in memory with zero restart).
pub async fn api_admin_upsert_pricing(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ModelPricingOverride>,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    let warnings = req.anomaly_warnings();
    if let Err(e) = st.ledger.upsert_model_pricing(&req).await {
        return st.err_response(&headers, e);
    }
    st.router.set_pricing_override(req.clone());
    Json(json!({ "ok": true, "override": req, "warnings": warnings })).into_response()
}

/// Admin reset model pricing back to `config/models.toml` default.
pub async fn api_admin_delete_pricing(
    State(st): State<AppState>,
    Path(model_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = verify_admin_access(&st, &headers).await {
        return st.err_response(&headers, e);
    }
    if let Err(e) = st.ledger.delete_model_pricing(&model_id).await {
        return st.err_response(&headers, e);
    }
    st.router.clear_pricing_override(&model_id);
    Json(json!({ "ok": true, "reset": model_id })).into_response()
}

/// Unified async multimodal task list (Admin sees all; authenticated user sees own tasks).
pub async fn api_list_tasks(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if verify_admin_access(&st, &headers).await.is_ok() {
        return match st.ledger.list_async_tasks(None, 50).await {
            Ok(tasks) => Json(json!({ "ok": true, "scope": "all", "tasks": tasks })).into_response(),
            Err(e) => st.err_response(&headers, e),
        };
    }
    let uname = match resolve_portal_user(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return st.err_response(&headers, e),
    };
    match st.ledger.list_async_tasks(Some(&uname), 50).await {
        Ok(tasks) => Json(json!({ "ok": true, "scope": "own", "tasks": tasks })).into_response(),
        Err(e) => st.err_response(&headers, e),
    }
}

/// Unified async multimodal task detail by task ID.
pub async fn api_get_task(
    State(st): State<AppState>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let is_admin = verify_admin_access(&st, &headers).await.is_ok();
    let owner = if is_admin {
        None
    } else {
        match resolve_portal_user(&st, &headers).await {
            Ok(u) => Some(u),
            Err(e) => return st.err_response(&headers, e),
        }
    };
    match st.ledger.get_async_task(&task_id).await {
        Ok(task) => {
            if let Some(u) = owner
                && !task.meta.username.eq_ignore_ascii_case(&u)
            {
                return st.err_response(&headers, RelayError::Forbidden("task belongs to another user".into()));
            }
            Json(json!({ "ok": true, "task": task })).into_response()
        }
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
                "list_models" => serde_json::to_string(&st.router.all_models()).unwrap_or_default(),
                "risk_status" => serde_json::to_string(&st.risk.stats()).unwrap_or_default(),
                _ => "unknown tool".to_string(),
            };
            Json(json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }] } }))
        }
        _ => Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })),
    }
}
