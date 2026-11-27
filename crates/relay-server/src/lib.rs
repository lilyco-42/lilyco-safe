pub mod handlers;
mod model_companies;
pub mod state;
pub mod ysm_catalog;

use std::path::Path;
use std::sync::Arc;

use axum::http::{HeaderValue, header};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::{Router, extract::Request};
use relay_core::{GatewayConfig, I18nBundle, ModelsCatalog, RelayError};
use relay_engine::{RelayLedger, UpstreamRouter};
use relay_risk::RiskEngine;
use state::{AppState, RuntimeBundle};
use tower_governor::GovernorLayer;
use tower_governor::governor::GovernorConfigBuilder;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

/// Zero-downtime graceful shutdown signal (SIGINT / SIGTERM).
pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

/// Ensure `index.html` is never stale-cached so frontend hot-swap takes effect immediately
/// without restarting any backend binary; hashed `/assets/*` files remain immutable-cached.
async fn hot_frontend_cache_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;
    if path == "/" || path.ends_with(".html") {
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, no-store, must-revalidate"),
        );
    } else if path.contains("/assets/") {
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    resp
}

fn attach_common_layers(router: Router<AppState>, state: AppState) -> Router {
    let rpm = state.runtime.cfg.risk.max_rpm_per_ip.max(1);
    let burst = (rpm / 2).max(5);
    let gov_cfg = Arc::new(
        GovernorConfigBuilder::default()
            .per_second((rpm / 60).max(1) as u64)
            .burst_size(burst)
            .finish()
            .expect("valid governor config"),
    );
    router
        .layer(middleware::from_fn(hot_frontend_cache_headers))
        .layer(GovernorLayer::new(gov_cfg))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

fn proxy_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/health", get(handlers::api_health))
        .route("/v1/models", get(handlers::api_list_models))
        .route("/v1/model-companies", get(handlers::api_model_companies))
        .route("/v1/models/{model}", get(handlers::api_get_model))
        .route("/v1/chat/completions", post(handlers::api_openai_chat))
        .route("/v1/responses", post(handlers::api_openai_responses))
        .route("/v1/messages", post(handlers::api_anthropic_messages))
        .route("/v1beta/models/{*model_action}", post(handlers::api_gemini_v1beta))
        .route("/v1/embeddings", post(handlers::api_embeddings))
        .route("/v1/images/generations", post(handlers::api_images))
        .route("/v1/audio/speech", post(handlers::api_audio_speech))
        .route("/v1/music/generations", post(handlers::api_music_generations))
        .route("/v1/videos/generations", post(handlers::api_video_generations))
        .route("/v1/videos/operations/{*op}", get(handlers::api_video_operation))
        .route("/v1/ysm/generations", post(handlers::api_ysm))
        .route("/api/v1/ysm/catalog", get(ysm_catalog::api_ysm_catalog))
        .route("/v1/rerank", post(handlers::api_rerank))
        .route("/mcp", post(handlers::api_mcp))
}

fn admin_routes(web_dir: String) -> Router<AppState> {
    Router::new()
        .route("/api/v1/auth/login", post(handlers::api_portal_login))
        .route("/api/v1/auth/register", post(handlers::api_portal_register))
        .route("/api/v1/me", get(handlers::api_me))
        .route("/api/v1/trial-cards/activate", post(handlers::api_activate_trial_card))
        .route("/api/v1/dashboard/stats", get(handlers::api_dashboard_stats))
        .route("/api/v1/logs", get(handlers::api_usage_logs))
        .route("/api/v1/tasks", get(handlers::api_list_tasks))
        .route("/api/v1/tasks/{id}", get(handlers::api_get_task))
        .route("/api/v1/keys", post(handlers::api_issue_key))
        .route("/api/v1/keys/revoke", post(handlers::api_revoke_key))
        .route("/api/v1/redeem", post(handlers::api_redeem))
        .route("/api/v1/affiliate/bind", post(handlers::api_bind_affiliate))
        .route("/api/v1/affiliate/transfer", post(handlers::api_affiliate_transfer))
        .route("/api/v1/admin/channels", get(handlers::api_admin_list_channels).post(handlers::api_admin_upsert_channel))
        .route("/api/v1/admin/channels/{id}", delete(handlers::api_admin_delete_channel))
        .route("/api/v1/admin/channels/{id}/probe", post(handlers::api_admin_probe_channel))
        .route("/api/v1/admin/models/sync", post(handlers::api_admin_sync_models))
        .route("/api/v1/admin/models/pricing", post(handlers::api_admin_upsert_pricing))
        .route("/api/v1/admin/models/pricing/{model}", delete(handlers::api_admin_delete_pricing))
        .route("/api/v1/admin/resell/keys", post(handlers::api_admin_mint_resell_keys))
        .route("/api/v1/admin/users", get(handlers::api_admin_list_users))
        .route("/api/v1/admin/users/role", post(handlers::api_admin_update_role))
        .route("/api/v1/admin/redemptions", post(handlers::api_admin_create_redemptions))
        .route("/api/v1/admin/risk/block_ip", post(handlers::api_admin_block_ip))
        .route("/api/v1/admin/risk/unblock_ip", post(handlers::api_admin_unblock_ip))
        .route("/api/v1/admin/topup", post(handlers::api_admin_topup))
        .fallback_service(ServeDir::new(web_dir))
}

/// Data-plane router for standalone `relay-proxy` binary (zero-downtime inference plane).
pub fn build_proxy_app(state: AppState) -> Router {
    attach_common_layers(proxy_routes(), state)
}

/// Control-plane + hot-swappable frontend router for standalone `relay-admin` binary.
pub fn build_admin_app(state: AppState) -> Router {
    let web_dir = std::env::var("RELAY_WEB_DIR").unwrap_or_else(|_| "./web_dist".into());
    let router = admin_routes(web_dir).route("/api/v1/health", get(handlers::api_health));
    attach_common_layers(router, state)
}

/// All-in-one router for local development and single-binary deployments.
pub fn build_app(state: AppState) -> Router {
    let web_dir = std::env::var("RELAY_WEB_DIR").unwrap_or_else(|_| "./web_dist".into());
    attach_common_layers(proxy_routes().merge(admin_routes(web_dir)), state)
}

pub async fn init_state(cfg_path: &Path) -> Result<AppState, RelayError> {
    let cfg = GatewayConfig::load(cfg_path)?;
    let catalog = ModelsCatalog::load(Path::new(&cfg.storage.models_file))?;
    let i18n = I18nBundle::load(Path::new(&cfg.storage.i18n_dir), &cfg.storage.default_lang)?;
    let admin_key = std::env::var(&cfg.server.admin_key_env).unwrap_or_default();
    let ledger = RelayLedger::open(&cfg.storage.db_path).await?;
    let risk = Arc::new(RiskEngine::new(&cfg.risk, &cfg.security));
    let router = Arc::new(UpstreamRouter::new(catalog)?);
    if let Ok(overrides) = ledger.list_model_pricing().await {
        router.load_pricing_overrides(overrides);
    }
    let runtime = Arc::new(RuntimeBundle {
        cfg,
        i18n,
        admin_key,
        portal_client: reqwest::Client::new(),
    });
    let state = AppState { runtime, risk, ledger, router };
    // Auto-sync live upstream models on startup (non-blocking) so dynamic catalog survives restarts.
    let bg = state.clone();
    tokio::spawn(async move {
        if let Ok(channels) = bg.ledger.list_channels().await {
            for rec in channels.into_iter().filter(|c| c.meta.enabled) {
                if let Ok(ch) = bg.ledger.get_live_channel(&rec.id).await {
                    let _ = bg.router.sync_channel_models(&ch).await;
                }
            }
        }
    });
    Ok(state)
}
