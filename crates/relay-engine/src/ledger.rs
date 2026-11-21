use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use relay_core::{KeyIssueReq, RelayError, TokenUsage};
use ring::digest::{digest, SHA256};
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
        ];
        for s in stmts {
            self.conn.execute(s, ()).await.map_err(map_db)?;
        }
        Ok(())
    }

    /// Sync user from dev.lain42.top portal: ONLY real paid balance updates `paid_credits`!
    pub async fn sync_portal_wallet(
        &self,
        username: &str,
        portal_paid_credits: u64,
    ) -> Result<UserWallet, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let now = now_unix();
        self.conn
            .execute(
                "INSERT INTO relay_users (username, paid_credits, bonus_credits, affiliate_credits, created_unix)
                 VALUES (?1, ?2, 0, 0, ?3)
                 ON CONFLICT(username) DO UPDATE SET paid_credits = MAX(paid_credits, excluded.paid_credits)",
                (u.as_str(), portal_paid_credits as i64, now),
            )
            .await
            .map_err(map_db)?;
        self.get_wallet(&u).await
    }

    pub async fn get_wallet(&self, username: &str) -> Result<UserWallet, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let mut rows = self
            .conn
            .query(
                "SELECT username, paid_credits, bonus_credits, affiliate_credits FROM relay_users WHERE username = ?1",
                [u.as_str()],
            )
            .await
            .map_err(map_db)?;
        let Some(row) = rows.next().await.map_err(map_db)? else {
            return Err(RelayError::Unauthorized("user wallet not found".into()));
        };
        Ok(UserWallet {
            username: col_str(&row, 0),
            paid_credits: col_u64(&row, 1),
            bonus_credits: col_u64(&row, 2),
            affiliate_credits: col_u64(&row, 3),
        })
    }

    /// Issue a scoped `sk-l42-...` API key; stores only SHA-256 hash at rest.
    pub async fn issue_key(
        &self,
        username: &str,
        req: &KeyIssueReq,
    ) -> Result<(String, ApiKeyRecord), RelayError> {
        req.validate()?;
        let u = username.trim().to_ascii_lowercase();
        let ts = now_unix();
        let raw_seed = format!("l42key:{u}:{}:{ts}", req.name);
        let secret = format!("sk-l42-{}", &sha256_b64(&raw_seed)[..32]);
        let key_hash = sha256_b64(&secret);
        let key_id = format!("key_{}", &key_hash[..12]);
        let allowed = req.allowed_models.join(",");
        self.conn
            .execute(
                "INSERT INTO relay_keys (id, username, name, key_hash, quota_limit, used_credits, rpm_limit, allowed_models, active, created_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, 1, ?8)",
                (
                    key_id.as_str(),
                    u.as_str(),
                    req.name.trim(),
                    key_hash.as_str(),
                    req.quota_limit as i64,
                    req.rpm_limit as i64,
                    allowed.as_str(),
                    ts,
                ),
            )
            .await
            .map_err(map_db)?;
        let rec = ApiKeyRecord {
            id: key_id,
            username: u,
            quota_limit: req.quota_limit,
            used_credits: 0,
        };
        Ok((secret, rec))
    }

    pub async fn verify_api_key(
        &self,
        raw_key: &str,
        model_id: &str,
    ) -> Result<ApiKeyRecord, RelayError> {
        let key_hash = sha256_b64(raw_key.trim());
        let mut rows = self
            .conn
            .query(
                "SELECT id, username, quota_limit, used_credits, allowed_models, active FROM relay_keys WHERE key_hash = ?1",
                [key_hash.as_str()],
            )
            .await
            .map_err(map_db)?;
        let Some(row) = rows.next().await.map_err(map_db)? else {
            return Err(RelayError::Unauthorized("invalid api key".into()));
        };
        if col_u64(&row, 5) == 0 {
            return Err(RelayError::Unauthorized("api key revoked".into()));
        }
        let allowed = col_str(&row, 4);
        if !allowed.is_empty() && !allowed.split(',').any(|m| m.trim() == model_id) {
            return Err(RelayError::Unauthorized(format!("model {model_id} not allowed on this key")));
        }
        Ok(ApiKeyRecord {
            id: col_str(&row, 0),
            username: col_str(&row, 1),
            quota_limit: col_u64(&row, 2),
            used_credits: col_u64(&row, 3),
        })
    }

    /// Atomic pre-hold on REAL PAID credits ONLY (strictly blocks free/bonus points!).
    pub async fn pre_hold_paid(
        &self,
        key: &ApiKeyRecord,
        hold_credits: u64,
    ) -> Result<HoldReceipt, RelayError> {
        if hold_credits > 0
            && key.quota_limit > 0
            && key.used_credits.saturating_add(hold_credits) > key.quota_limit
        {
            return Err(RelayError::InsufficientPaid("sub-key quota limit reached".into()));
        }
        let wallet = self.get_wallet(&key.username).await?;
        if wallet.paid_credits < hold_credits {
            return Err(RelayError::InsufficientPaid(format!(
                "need {hold_credits} paid credits, have {} (bonus {} excluded)",
                wallet.paid_credits, wallet.bonus_credits
            )));
        }
        if hold_credits > 0 {
            self.conn
                .execute(
                    "UPDATE relay_users SET paid_credits = paid_credits - ?1 WHERE username = ?2 AND paid_credits >= ?1",
                    (hold_credits as i64, key.username.as_str()),
                )
                .await
                .map_err(map_db)?;
        }
        let hold_id = format!("h_{}_{}", key.id, now_unix());
        Ok(HoldReceipt {
            hold_id,
            username: key.username.clone(),
            key_id: key.id.clone(),
            held_credits: hold_credits,
        })
    }

    /// Settle exact credits after upstream completion or SSE disconnect EOF (refunds unused hold).
    pub async fn settle_hold(
        &self,
        hold: &HoldReceipt,
        model: &str,
        usage: TokenUsage,
        actual_credits: u64,
    ) -> Result<(), RelayError> {
        if actual_credits < hold.held_credits {
            let refund = hold.held_credits - actual_credits;
            self.conn
                .execute(
                    "UPDATE relay_users SET paid_credits = paid_credits + ?1 WHERE username = ?2",
                    (refund as i64, hold.username.as_str()),
                )
                .await
                .map_err(map_db)?;
        } else if actual_credits > hold.held_credits {
            let extra = actual_credits - hold.held_credits;
            self.conn
                .execute(
                    "UPDATE relay_users SET paid_credits = MAX(0, paid_credits - ?1) WHERE username = ?2",
                    (extra as i64, hold.username.as_str()),
                )
                .await
                .map_err(map_db)?;
        }
        if actual_credits > 0 {
            self.conn
                .execute(
                    "UPDATE relay_keys SET used_credits = used_credits + ?1 WHERE id = ?2",
                    (actual_credits as i64, hold.key_id.as_str()),
                )
                .await
                .map_err(map_db)?;
        }
        self.conn
            .execute(
                "INSERT INTO relay_usage_logs (id, username, key_id, model, prompt_tokens, completion_tokens, credits_charged, status, created_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'settled', ?8)",
                (
                    hold.hold_id.as_str(),
                    hold.username.as_str(),
                    hold.key_id.as_str(),
                    model,
                    usage.prompt_tokens as i64,
                    usage.completion_tokens as i64,
                    actual_credits as i64,
                    now_unix(),
                ),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

    /// Full 100% refund when upstream fails (0 credits charged).
    pub async fn refund_hold(&self, hold: &HoldReceipt, model: &str) -> Result<(), RelayError> {
        self.settle_hold(hold, model, TokenUsage::default(), 0).await
    }

    /// Bind lifelong referrer (anti-self-referral guard).
    pub async fn bind_referrer(&self, buyer: &str, referrer: &str) -> Result<(), RelayError> {
        let b = buyer.trim().to_ascii_lowercase();
        let r = referrer.trim().to_ascii_lowercase();
        if b.is_empty() || r.is_empty() || b == r {
            return Err(RelayError::InvalidInput("cannot self-refer".into()));
        }
        self.conn
            .execute(
                "UPDATE relay_users SET referrer = ?1 WHERE username = ?2 AND referrer = ''",
                (r.as_str(), b.as_str()),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

    /// Credit real-money topup and grant affiliate commission ONLY on settled paid orders.
    pub async fn credit_real_topup(
        &self,
        order_id: &str,
        buyer: &str,
        credits: u64,
        rate_bps: u32,
    ) -> Result<u64, RelayError> {
        let b = buyer.trim().to_ascii_lowercase();
        self.conn
            .execute(
                "UPDATE relay_users SET paid_credits = paid_credits + ?1 WHERE username = ?2",
                (credits as i64, b.as_str()),
            )
            .await
            .map_err(map_db)?;
        let mut rows = self
            .conn
            .query("SELECT referrer FROM relay_users WHERE username = ?1", [b.as_str()])
            .await
            .map_err(map_db)?;
        let referrer = rows.next().await.map_err(map_db)?.map(|r| col_str(&r, 0)).unwrap_or_default();
        if referrer.is_empty() || rate_bps == 0 {
            return Ok(0);
        }
        let comm = credits.saturating_mul(rate_bps as u64) / 10_000;
        if comm == 0 {
            return Ok(0);
        }
        self.conn
            .execute(
                "INSERT OR IGNORE INTO relay_affiliate_logs (order_id, referrer, buyer, topup_credits, commission_credits, created_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                (order_id, referrer.as_str(), b.as_str(), credits as i64, comm as i64, now_unix()),
            )
            .await
            .map_err(map_db)?;
        self.conn
            .execute(
                "UPDATE relay_users SET affiliate_credits = affiliate_credits + ?1 WHERE username = ?2",
                (comm as i64, referrer.as_str()),
            )
            .await
            .map_err(map_db)?;
        Ok(comm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dual_wallet_prehold_refund_and_affiliate_work() {
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
            allowed_models: vec!["gemini-2.5-flash".into()],
        };
        let (a_key, _) = db.issue_key("alice", &req).await.unwrap();
        let a_rec = db.verify_api_key(&a_key, "gemini-2.5-flash").await.unwrap();
        assert!(matches!(db.pre_hold_paid(&a_rec, 10).await, Err(RelayError::InsufficientPaid(_))));

        // Model whitelist enforced on sub-key
        assert!(db.verify_api_key(&a_key, "claude-sonnet-4").await.is_err());

        // Bob pre-holds 20, upstream fails -> 100% refunded!
        let (b_key, _) = db.issue_key("bob", &req).await.unwrap();
        let b_rec = db.verify_api_key(&b_key, "gemini-2.5-flash").await.unwrap();
        let hold = db.pre_hold_paid(&b_rec, 20).await.unwrap();
        assert_eq!(db.get_wallet("bob").await.unwrap().paid_credits, 1080);
        db.refund_hold(&hold, "gemini-2.5-flash").await.unwrap();
        assert_eq!(db.get_wallet("bob").await.unwrap().paid_credits, 1100);
    }
}
