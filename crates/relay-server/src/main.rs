mod handlers;
mod state;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;
use relay_core::{GatewayConfig, I18nBundle, ModelsCatalog, RelayError};
use relay_engine::{RelayLedger, UpstreamRouter};
use relay_risk::RiskEngine;
use state::{AppState, RuntimeBundle};
use tower_governor::governor::GovernorConfigBuilder;
use tower_governor::GovernorLayer;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

pub fn build_app(state: AppState) -> Router {
    let web_dir = std::env::var("RELAY_WEB_DIR").unwrap_or_else(|_| "./web_dist".into());
    let rpm = state.runtime.cfg.risk.max_rpm_per_ip.max(1);
    let burst = (rpm / 2).max(5);
    let gov_cfg = Arc::new(
        GovernorConfigBuilder::default()
            .per_second((rpm / 60).max(1) as u64)
            .burst_size(burst)
            .finish()
            .expect("valid governor config"),
    );

    Router::new()
        .route("/api/v1/health", get(handlers::api_health))
        .route("/api/v1/me", get(handlers::api_me))
        .route("/api/v1/dashboard/stats", get(handlers::api_dashboard_stats))
        .route("/api/v1/logs", get(handlers::api_usage_logs))
        .route("/v1/models", get(handlers::api_list_models))
        .route("/v1/models/{model}", get(handlers::api_get_model))
        .route("/v1/chat/completions", post(handlers::api_openai_chat))
        .route("/v1/messages", post(handlers::api_anthropic_messages))
        .route("/v1/embeddings", post(handlers::api_embeddings))
        .route("/v1/images/generations", post(handlers::api_images))
        .route("/v1/rerank", post(handlers::api_rerank))
        .route("/api/v1/keys", post(handlers::api_issue_key))
        .route("/api/v1/keys/revoke", post(handlers::api_revoke_key))
        .route("/api/v1/redeem", post(handlers::api_redeem))
        .route("/api/v1/affiliate/bind", post(handlers::api_bind_affiliate))
        .route("/api/v1/affiliate/transfer", post(handlers::api_affiliate_transfer))
        .route("/api/v1/admin/channels", get(handlers::api_admin_list_channels).post(handlers::api_admin_upsert_channel))
        .route("/api/v1/admin/channels/{id}", delete(handlers::api_admin_delete_channel))
        .route("/api/v1/admin/users", get(handlers::api_admin_list_users))
        .route("/api/v1/admin/users/role", post(handlers::api_admin_update_role))
        .route("/api/v1/admin/redemptions", post(handlers::api_admin_create_redemptions))
        .route("/api/v1/admin/risk/block_ip", post(handlers::api_admin_block_ip))
        .route("/api/v1/admin/risk/unblock_ip", post(handlers::api_admin_unblock_ip))
        .route("/api/v1/admin/topup", post(handlers::api_admin_topup))
        .route("/mcp", post(handlers::api_mcp))
        .fallback_service(ServeDir::new(web_dir))
        .layer(GovernorLayer::new(gov_cfg))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn init_state(cfg_path: &Path) -> Result<AppState, RelayError> {
    let cfg = GatewayConfig::load(cfg_path)?;
    let catalog = ModelsCatalog::load(Path::new(&cfg.storage.models_file))?;
    let i18n = I18nBundle::load(Path::new(&cfg.storage.i18n_dir), &cfg.storage.default_lang)?;
    let admin_key = std::env::var(&cfg.server.admin_key_env).unwrap_or_default();
    let ledger = RelayLedger::open(&cfg.storage.db_path).await?;
    let risk = Arc::new(RiskEngine::new(&cfg.risk, &cfg.security));
    let router = Arc::new(UpstreamRouter::new(catalog)?);
    let runtime = Arc::new(RuntimeBundle {
        cfg,
        i18n,
        admin_key,
        portal_client: reqwest::Client::new(),
    });
    Ok(AppState { runtime, risk, ledger, router })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg_path = std::env::var("RELAY_CONFIG").unwrap_or_else(|_| "./config/gateway.toml".into());
    let state = init_state(Path::new(&cfg_path)).await?;
    let bind = state.runtime.cfg.server.bind.clone();
    let app = build_app(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    println!("lilyco-relay (MIT · Zero-Trust Rust AI Gateway) listening on http://{bind}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_core::config::{
        ChannelConfig, ModelConfig, RiskSection, SecuritySection, ServerSection, StorageSection,
    };
    use relay_core::{KeyIssueReq, KeyScope};

    async fn spawn_mock_upstream() -> String {
        let mock = Router::new().route(
            "/chat/completions",
            post(|| async {
                axum::Json(serde_json::json!({
                    "id": "chatcmpl-mock-1",
                    "choices": [{ "message": { "role": "assistant", "content": "Hello from MIT lilyco-relay!" } }],
                    "usage": { "prompt_tokens": 12, "completion_tokens": 8 }
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, mock).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn full_e2e_openai_anthropic_risk_and_zero_trust() {
        let up_url = spawn_mock_upstream().await;
        unsafe { std::env::set_var("TEST_UP_KEY", "upstream-secret-never-leaked"); }

        let cfg = GatewayConfig {
            server: ServerSection {
                bind: "127.0.0.1:0".into(),
                public_url: "http://127.0.0.1".into(),
                portal_verify_url: "http://127.0.0.1:1".into(),
                admin_key_env: "TEST_ADM".into(),
            },
            storage: StorageSection {
                db_path: ":memory:".into(),
                i18n_dir: "./config/i18n".into(),
                models_file: "./config/models.toml".into(),
                default_lang: "zh".into(),
            },
            risk: RiskSection {
                max_rpm_per_ip: 20,
                max_auth_fail_per_ip: 2,
                lockout_secs: 300,
                max_credits_per_req: 500,
            },
            security: SecuritySection {
                trusted_proxies: vec!["127.0.0.1".into()],
                blocked_ips: vec![],
                require_paid_wallet: true,
                affiliate_rate_bps: 1500,
            },
        };
        let catalog = ModelsCatalog {
            channels: vec![ChannelConfig {
                id: "mock-gemini".into(),
                provider: "gemini_openai".into(),
                base_url: up_url,
                api_key_env: "TEST_UP_KEY".into(),
                weight: 100,
                enabled: true,
            }],
            models: vec![ModelConfig {
                id: "gemini-2.5-flash".into(),
                channel_id: "mock-gemini".into(),
                upstream_model: "gemini-2.5-flash".into(),
                input_per_m: 10,
                output_per_m: 40,
                allow_free: false,
            }],
        };

        let ledger = RelayLedger::open(":memory:").await.unwrap();
        ledger.sync_portal_wallet("alice", 100).await.unwrap();
        let (api_key, _) = ledger
            .issue_key(
                "alice",
                &KeyIssueReq {
                    name: "prod".into(),
                    quota_limit: 100,
                    rpm_limit: 60,
                    scope: KeyScope {
                        allowed_models: vec!["gemini-2.5-flash".into()],
                        allowed_ips: String::new(),
                        expired_unix: 0,
                        group_name: "default".into(),
                    },
                },
            )
            .await
            .unwrap();

        let state = AppState {
            runtime: Arc::new(RuntimeBundle {
                cfg: cfg.clone(),
                i18n: I18nBundle::default(),
                admin_key: "adm123".into(),
                portal_client: reqwest::Client::new(),
            }),
            risk: Arc::new(RiskEngine::new(&cfg.risk, &cfg.security)),
            ledger: ledger.clone(),
            router: Arc::new(UpstreamRouter::new(catalog).unwrap()),
        };

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        let client = reqwest::Client::new();
        // 1. OpenAI chat completion succeeds & charges exactly 1 credit
        let r1 = client
            .post(format!("http://{addr}/v1/chat/completions"))
            .bearer_auth(&api_key)
            .json(&serde_json::json!({
                "model": "gemini-2.5-flash",
                "messages": [{"role": "user", "content": "ping"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r1.status(), 200);
        let j1: serde_json::Value = r1.json().await.unwrap();
        assert_eq!(j1["choices"][0]["message"]["content"], "Hello from MIT lilyco-relay!");
        assert_eq!(ledger.get_wallet("alice").await.unwrap().paid_credits, 99);

        // 2. Anthropic /v1/messages (Claude Code) succeeds & charges 1 credit
        let r2 = client
            .post(format!("http://{addr}/v1/messages"))
            .header("x-api-key", &api_key)
            .json(&serde_json::json!({
                "model": "gemini-2.5-flash",
                "max_tokens": 64,
                "messages": [{"role": "user", "content": "ping"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r2.status(), 200);
        let j2: serde_json::Value = r2.json().await.unwrap();
        assert_eq!(j2["content"][0]["text"], "Hello from MIT lilyco-relay!");
        assert_eq!(ledger.get_wallet("alice").await.unwrap().paid_credits, 98);

        // 3. Zero-trust unknown field injection rejected with 422/400
        let r_bad = client
            .post(format!("http://{addr}/v1/chat/completions"))
            .bearer_auth(&api_key)
            .json(&serde_json::json!({
                "model": "gemini-2.5-flash",
                "messages": [{"role": "user", "content": "hi"}],
                "injected_field": true
            }))
            .send()
            .await
            .unwrap();
        assert!(r_bad.status().is_client_error());

        // 4. Brute-force invalid auth from spoofed-free client IP locks out attacker IP!
        for _ in 0..2 {
            let rf = client
                .post(format!("http://{addr}/v1/chat/completions"))
                .header("x-forwarded-for", "203.0.113.99")
                .bearer_auth("sk-l42-wrong")
                .json(&serde_json::json!({
                    "model": "gemini-2.5-flash",
                    "messages": [{"role": "user", "content": "hi"}]
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(rf.status(), 401);
        }
        let r_locked = client
            .post(format!("http://{addr}/v1/chat/completions"))
            .header("x-forwarded-for", "203.0.113.99")
            .bearer_auth(&api_key)
            .json(&serde_json::json!({
                "model": "gemini-2.5-flash",
                "messages": [{"role": "user", "content": "hi"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r_locked.status(), 403);
    }
}
