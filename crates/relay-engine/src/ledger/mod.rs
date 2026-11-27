mod channels;
mod ops;
mod wallet;

use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use relay_core::{ChannelPolicy, RelayError};
use ring::digest::{digest, SHA256};
use secrecy::SecretString;
use serde::Serialize;
use turso::{Builder, Connection, Database, Value};

/// User dual-wallet state (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct UserWallet {
    pub username: String,
    pub paid_credits: u64,
    pub bonus_credits: u64,
    pub affiliate_credits: u64,
}

/// Active API key metadata (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct ApiKeyRecord {
    pub id: String,
    pub username: String,
    pub quota_limit: u64,
    pub used_credits: u64,
}

/// Extended key access policy (<= 4 fields, Rule of 4).
#[derive(Debug, Clone)]
pub struct VerifiedKey {
    pub record: ApiKeyRecord,
    pub allowed_ips: String,
    pub expired_unix: i64,
}

/// Dynamic DB-backed channel view.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelRecord {
    pub id: String,
    pub provider: String,
    pub base_url: String,
    pub meta: ChannelMeta,
    pub policy: ChannelPolicy,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelMeta {
    pub name: String,
    pub models: Vec<String>,
    pub priority: i32,
    pub enabled: bool,
}

/// Live upstream channel credentials for routing pool (zeroized SecretString).
#[derive(Debug, Clone)]
pub struct LiveChannel {
    pub id: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: SecretString,
    pub policy: ChannelPolicy,
}

/// Dashboard aggregate stats (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    pub total_requests: u64,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_credits_charged: u64,
}

/// Usage audit log entry (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct UsageEntry {
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub credits_charged: u64,
}

/// Pre-hold receipt for atomic settlement or refund (4 fields, Rule of 4).
#[derive(Debug, Clone)]
pub struct HoldReceipt {
    pub hold_id: String,
    pub username: String,
    pub key_id: String,
    pub held_credits: u64,
}

#[derive(Clone)]
pub struct RelayLedger {
    _db: Arc<Database>,
    conn: Connection,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn sha256_b64(input: &str) -> String {
    let d = digest(&SHA256, input.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(d.as_ref())
}

fn col_str(row: &turso::Row, idx: usize) -> String {
    match row.get_value(idx) {
        Ok(Value::Text(s)) => s,
        Ok(Value::Integer(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn col_u64(row: &turso::Row, idx: usize) -> u64 {
    match row.get_value(idx) {
        Ok(Value::Integer(n)) if n > 0 => n as u64,
        _ => 0,
    }
}

fn map_db(e: turso::Error) -> RelayError {
    RelayError::Storage(e.to_string())
}

impl RelayLedger {
    pub async fn open(db_path: &str) -> Result<Self, RelayError> {
        if db_path != ":memory:"
            && let Some(p) = Path::new(db_path).parent()
            && !p.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(p);
        }
        let db = Builder::new_local(db_path).build().await.map_err(map_db)?;
        let conn = db.connect().map_err(map_db)?;
        let ledger = Self { _db: Arc::new(db), conn };
        ledger.init_schema().await?;
        Ok(ledger)
    }

    async fn init_schema(&self) -> Result<(), RelayError> {
        let stmts = [
            "CREATE TABLE IF NOT EXISTS relay_users (
                username TEXT PRIMARY KEY,
                paid_credits INTEGER NOT NULL DEFAULT 0,
                bonus_credits INTEGER NOT NULL DEFAULT 0,
                affiliate_credits INTEGER NOT NULL DEFAULT 0,
                referrer TEXT NOT NULL DEFAULT '',
                created_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_keys (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                name TEXT NOT NULL,
                key_hash TEXT UNIQUE NOT NULL,
                quota_limit INTEGER NOT NULL DEFAULT 0,
                used_credits INTEGER NOT NULL DEFAULT 0,
                rpm_limit INTEGER NOT NULL DEFAULT 60,
                allowed_models TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                created_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_usage_logs (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                key_id TEXT NOT NULL,
                model TEXT NOT NULL,
                prompt_tokens INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                credits_charged INTEGER NOT NULL,
                status TEXT NOT NULL,
                created_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_affiliate_logs (
                order_id TEXT PRIMARY KEY,
                referrer TEXT NOT NULL,
                buyer TEXT NOT NULL,
                topup_credits INTEGER NOT NULL,
                commission_credits INTEGER NOT NULL,
                created_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_channels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                provider TEXT NOT NULL,
                base_url TEXT NOT NULL,
                api_key TEXT NOT NULL,
                models TEXT NOT NULL DEFAULT '',
                priority INTEGER NOT NULL DEFAULT 10,
                weight INTEGER NOT NULL DEFAULT 100,
                enabled INTEGER NOT NULL DEFAULT 1,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                created_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_redemptions (
                code TEXT PRIMARY KEY,
                credits INTEGER NOT NULL,
                wallet_type TEXT NOT NULL DEFAULT 'paid',
                used_by TEXT NOT NULL DEFAULT '',
                created_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_user_roles (
                username TEXT PRIMARY KEY,
                role TEXT NOT NULL DEFAULT 'user',
                discount_pct INTEGER NOT NULL DEFAULT 0,
                banned INTEGER NOT NULL DEFAULT 0,
                updated_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_trial_cards (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                card_type TEXT NOT NULL,
                title TEXT NOT NULL,
                spec TEXT NOT NULL,
                duration_secs INTEGER NOT NULL DEFAULT 3600,
                expires_unix INTEGER NOT NULL DEFAULT 0,
                created_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_model_pricing (
                model_id TEXT PRIMARY KEY,
                billing_mode TEXT NOT NULL DEFAULT 'token',
                input_per_m INTEGER NOT NULL DEFAULT 0,
                output_per_m INTEGER NOT NULL DEFAULT 0,
                unit_credits INTEGER NOT NULL DEFAULT 0,
                allow_free INTEGER NOT NULL DEFAULT 0,
                updated_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_async_tasks (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                task_type TEXT NOT NULL,
                model TEXT NOT NULL,
                provider_op TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                credits_charged INTEGER NOT NULL DEFAULT 0,
                result_json TEXT NOT NULL DEFAULT '{}',
                created_unix INTEGER NOT NULL,
                updated_unix INTEGER NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS relay_options (
                opt_key TEXT PRIMARY KEY,
                opt_val TEXT NOT NULL DEFAULT '',
                updated_unix INTEGER NOT NULL
            )",
        ];
        for s in stmts {
            self.conn.execute(s, ()).await.map_err(map_db)?;
        }
        // Safe migrations for existing production DBs
        let _ = self.conn.execute("ALTER TABLE relay_keys ADD COLUMN allowed_ips TEXT NOT NULL DEFAULT ''", ()).await;
        let _ = self.conn.execute("ALTER TABLE relay_keys ADD COLUMN expired_unix INTEGER NOT NULL DEFAULT 0", ()).await;
        let _ = self.conn.execute("ALTER TABLE relay_channels ADD COLUMN model_mapping TEXT NOT NULL DEFAULT '{}'", ()).await;
        let _ = self.conn.execute("ALTER TABLE relay_channels ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 0", ()).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_core::{
        AdminRoleUpdateReq, AsyncTaskMeta, BillingMode, ChannelUpsertReq, KeyIssueReq, KeyScope,
        KeyUpdateReq, ModelPricingOverride, ModelRateSpec, RedemptionCreateReq, UserRole,
    };

    #[tokio::test]
    async fn rbac_roles_key_quotas_and_usage_logs_work() {
        let db = RelayLedger::open(":memory:").await.unwrap();
        db.sync_portal_wallet("alice", 100).await.unwrap();

        let p0 = db.get_user_policy("alice").await.unwrap();
        assert_eq!(p0.role, UserRole::User);
        assert_eq!(p0.max_keys, 5);
        assert_eq!(p0.discount_pct, 0);

        let p_vip = db
            .set_user_role(&AdminRoleUpdateReq {
                username: "alice".into(),
                role: UserRole::Vip,
                discount_pct: Some(20),
                banned: Some(false),
            })
            .await
            .unwrap();
        assert_eq!(p_vip.role, UserRole::Vip);
        assert_eq!(p_vip.max_keys, 20);
        assert_eq!(p_vip.discount_pct, 20);
        assert_eq!(p_vip.apply_discount(100), 80);

        let users = db.list_users(10).await.unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].policy.role, UserRole::Vip);
    }

    #[tokio::test]
    async fn dual_wallet_prehold_refund_redemption_and_affiliate_work() {
        let db = RelayLedger::open(":memory:").await.unwrap();
        db.sync_portal_wallet("alice", 0).await.unwrap();
        db.sync_portal_wallet("bob", 100).await.unwrap();
        db.bind_referrer("bob", "alice").await.unwrap();

        // Real topup triggers 15% affiliate commission to alice (1000 * 15% = 150)
        let comm = db.credit_real_topup("ORD-1", "bob", 1000, 1500).await.unwrap();
        assert_eq!(comm, 150);
        let alice = db.get_wallet("alice").await.unwrap();
        assert_eq!(alice.affiliate_credits, 150);
        assert_eq!(alice.paid_credits, 0);

        // Alice has 0 paid credits -> pre_hold_paid MUST fail!
        let req = KeyIssueReq {
            name: "dev".into(),
            quota_limit: 500,
            rpm_limit: 60,
            scope: KeyScope {
                allowed_models: vec!["gemini-2.5-flash".into()],
                allowed_ips: "10.0.0.1".into(),
                expired_unix: 0,
                group_name: "default".into(),
            },
        };
        let (a_key, _) = db.issue_key("alice", &req).await.unwrap();
        let a_rec = db.verify_api_key(&a_key, "gemini-2.5-flash").await.unwrap();
        assert_eq!(a_rec.allowed_ips, "10.0.0.1");
        assert!(matches!(db.pre_hold_paid(&a_rec.record, 10).await, Err(RelayError::InsufficientPaid(_))));

        // Alice transfers affiliate credits -> paid credits, then can spend!
        assert_eq!(db.transfer_affiliate_to_paid("alice").await.unwrap(), 150);
        assert_eq!(db.get_wallet("alice").await.unwrap().paid_credits, 150);

        // Redemption code batch generation & single-use redemption
        let codes = db
            .create_redemptions(&RedemptionCreateReq {
                count: 2,
                credits: 200,
                wallet_type: "paid".into(),
                prefix: "VIP".into(),
            })
            .await
            .unwrap();
        assert_eq!(codes.len(), 2);
        let (c_amt, wtype) = db.redeem_code("alice", &codes[0]).await.unwrap();
        assert_eq!((c_amt, wtype.as_str()), (200, "paid"));
        assert!(db.redeem_code("alice", &codes[0]).await.is_err());

        // Bob pre-holds 20, upstream fails -> 100% refunded!
        let (b_key, _) = db.issue_key("bob", &req).await.unwrap();
        let b_rec = db.verify_api_key(&b_key, "gemini-2.5-flash").await.unwrap();
        let hold = db.pre_hold_paid(&b_rec.record, 20).await.unwrap();
        assert_eq!(db.get_wallet("bob").await.unwrap().paid_credits, 1080);
        db.refund_hold(&hold, "gemini-2.5-flash").await.unwrap();
        assert_eq!(db.get_wallet("bob").await.unwrap().paid_credits, 1100);
    }

    #[tokio::test]
    async fn channel_policy_live_pricing_and_async_tasks_work() {
        let db = RelayLedger::open(":memory:").await.unwrap();
        let mut mapping = std::collections::HashMap::new();
        mapping.insert("deepseek-v3".to_string(), "deepseek-v4.1-flash".to_string());
        db.upsert_channel(&ChannelUpsertReq {
            id: "ch-map-1".into(),
            provider: "openai_compat".into(),
            endpoint: relay_core::ChannelEndpoint {
                name: "Mapped Pool".into(),
                base_url: "https://api.example.com/v1".into(),
                api_key: "sk-test-secret".into(),
                policy: ChannelPolicy {
                    model_mapping: mapping,
                    daily_limit: 50,
                },
            },
            routing: relay_core::ChannelRouting {
                models: vec!["deepseek-v3".into()],
                priority: 95,
                weight: 100,
                enabled: true,
            },
        })
        .await
        .unwrap();

        let live = db.find_live_channels("deepseek-v3").await.unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].policy.daily_limit, 50);
        assert_eq!(
            live[0].policy.model_mapping.get("deepseek-v3").map(String::as_str),
            Some("deepseek-v4.1-flash")
        );

        let ov = ModelPricingOverride {
            model_id: "veo-3.1-fast-generate-001".into(),
            billing_mode: BillingMode::PerSecond,
            rates: ModelRateSpec {
                input_per_m: 150,
                output_per_m: 150,
                unit_credits: 10,
                allow_free: false,
            },
        };
        assert!(!ov.anomaly_warnings().is_empty());
        db.upsert_model_pricing(&ov).await.unwrap();
        assert_eq!(db.list_model_pricing().await.unwrap().len(), 1);

        let task = db
            .create_async_task(
                &AsyncTaskMeta {
                    username: "alice".into(),
                    task_type: "video".into(),
                    model: "veo-3.1-fast-generate-001".into(),
                    provider_op: "projects/p/locations/us-central1/operations/op1".into(),
                },
                80,
                "{}",
            )
            .await
            .unwrap();
        assert_eq!(task.status, "queued");
        db.update_async_task_by_op(
            "projects/p/locations/us-central1/operations/op1",
            "succeeded",
            "{\"done\":true}",
        )
        .await
        .unwrap();
        let fetched = db.get_async_task(&task.id).await.unwrap();
        assert_eq!(fetched.status, "succeeded");
        assert_eq!(db.list_async_tasks(Some("alice"), 10).await.unwrap().len(), 1);

        // Channel toggle, system options, redemptions list/delete, key update & billing summary
        db.toggle_channel("ch-map-1", false).await.unwrap();
        assert!(db.find_live_channels("deepseek-v3").await.unwrap().is_empty());
        db.set_option("site_notice", "维护公告").await.unwrap();
        assert_eq!(db.get_options().await.unwrap().get("site_notice").map(String::as_str), Some("维护公告"));

        let codes = db
            .create_redemptions(&RedemptionCreateReq {
                count: 1,
                credits: 50,
                wallet_type: "paid".into(),
                prefix: "OPT".into(),
            })
            .await
            .unwrap();
        assert_eq!(db.list_redemptions(10).await.unwrap().len(), 1);
        db.delete_redemption(&codes[0]).await.unwrap();
        assert_eq!(db.list_redemptions(10).await.unwrap().len(), 0);

        db.sync_portal_wallet("alice", 300).await.unwrap();
        let (k_sec, k_rec) = db
            .issue_key(
                "alice",
                &KeyIssueReq {
                    name: "old".into(),
                    quota_limit: 100,
                    rpm_limit: 30,
                    scope: KeyScope::default(),
                },
            )
            .await
            .unwrap();
        db.update_key(
            "alice",
            &k_rec.id,
            &KeyUpdateReq {
                name: Some("renamed".into()),
                quota_limit: Some(500),
                active: Some(true),
                scope: None,
            },
        )
        .await
        .unwrap();
        let (bill_k, bill_w) = db.verify_key_for_billing(&k_sec).await.unwrap();
        assert_eq!(bill_k.quota_limit, 500);
        assert_eq!(bill_w.paid_credits, 300);
    }
}
