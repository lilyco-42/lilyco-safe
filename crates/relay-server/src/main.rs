use std::net::SocketAddr;
use std::path::Path;

use relay_server::{build_app, init_state, shutdown_signal};

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
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use axum::Router;
    use axum::routing::post;
    use relay_core::config::{
        ChannelConfig, ModelConfig, RiskSection, SecuritySection, ServerSection, StorageSection,
    };
    use relay_core::{GatewayConfig, I18nBundle, KeyIssueReq, KeyScope, ModelsCatalog};
    use relay_engine::{RelayLedger, UpstreamRouter};
    use relay_risk::RiskEngine;
    use relay_server::state::{AppState, RuntimeBundle};

    async fn spawn_mock_upstream() -> String {
        let mock = Router::new().route(
            "/chat/completions",
            post(|axum::Json(request): axum::Json<serde_json::Value>| async move {
                let content = if request["messages"][0]["content"] == ysm_web::DESIGN_PROMPT
                    && request["messages"][1]["content"] != "broken design"
                {
                    serde_json::json!({
                        "name": "Smoke test",
                        "hair": "braids",
                        "outfit": "ranger",
                        "palette": {"skin":"#E9BC9F","hair":"#332326","eyes":"#478D7B","primary":"#314D42","secondary":"#50786C","accent":"#D7AD63","boots":"#43302D"},
                        "details": []
                    }).to_string()
                } else {
                    "Hello from MIT lilyco-relay!".to_string()
                };
                axum::Json(serde_json::json!({
                    "id": "chatcmpl-mock-1",
                    "choices": [{ "message": { "role": "assistant", "content": content } }],
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

        let generated = client
            .post(format!("http://{addr}/v1/ysm/generations"))
            .bearer_auth(&api_key)
            .json(&serde_json::json!({"model":"gemini-2.5-flash","prompt":"A blocky forest traveller"}))
            .send()
            .await
            .unwrap();
        assert_eq!(generated.status(), 200);
        assert_eq!(generated.headers()["content-type"], "application/zip");
        let bytes = generated.bytes().await.unwrap();
        assert!(bytes.starts_with(b"PK\x03\x04"));
        assert!(bytes.windows(b"textures/default.png".len()).any(|w| w == b"textures/default.png"));
        assert!(bytes.windows(b"renders/turnaround.png".len()).any(|w| w == b"renders/turnaround.png"));

        assert_eq!(ledger.get_wallet("alice").await.unwrap().paid_credits, 97);
        let invalid_design = client
            .post(format!("http://{addr}/v1/ysm/generations"))
            .bearer_auth(&api_key)
            .json(&serde_json::json!({"model":"gemini-2.5-flash","prompt":"broken design"}))
            .send()
            .await
            .unwrap();
        assert_eq!(invalid_design.status(), 502);
        assert_eq!(ledger.get_wallet("alice").await.unwrap().paid_credits, 97);

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
