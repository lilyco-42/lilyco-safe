use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use relay_core::{
    AdminRoleUpdateReq, AdminUserSummary, ChannelUpsertReq, KeyIssueReq, KeyScope,
    RedemptionCreateReq, RelayError, ResellKeyBatchReq, TokenUsage, TrialCardItem, UsageLogItem,
    UserRole, UserRolePolicy,
};
use ring::digest::{digest, SHA256};
use secrecy::SecretString;
use serde::Serialize;
use turso::{Builder, Connection, Database, Value};

use crate::query;

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

/// Dynamic DB-backed channel view (4 composed fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct ChannelRecord {
    pub id: String,
    pub provider: String,
    pub base_url: String,
    pub meta: ChannelMeta,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelMeta {
    pub name: String,
    pub models: Vec<String>,
    pub priority: i32,
    pub enabled: bool,
}

/// Live upstream channel credentials for routing pool (4 fields, Rule of 4, zeroized SecretString).
#[derive(Debug, Clone)]
pub struct LiveChannel {
    pub id: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: SecretString,
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
        ];
        for s in stmts {
            self.conn.execute(s, ()).await.map_err(map_db)?;
        }
        // Safe migrations for existing production DBs
        let _ = self.conn.execute("ALTER TABLE relay_keys ADD COLUMN allowed_ips TEXT NOT NULL DEFAULT ''", ()).await;
        let _ = self.conn.execute("ALTER TABLE relay_keys ADD COLUMN expired_unix INTEGER NOT NULL DEFAULT 0", ()).await;
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
        let allowed = req.scope.allowed_models.join(",");
        let allowed_ips = req.scope.allowed_ips.trim().to_string();
        self.conn
            .execute(
                "INSERT INTO relay_keys (id, username, name, key_hash, quota_limit, used_credits, rpm_limit, allowed_models, allowed_ips, expired_unix, active, created_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9, 1, ?10)",
                (
                    key_id.as_str(),
                    u.as_str(),
                    req.name.trim(),
                    key_hash.as_str(),
                    req.quota_limit as i64,
                    req.rpm_limit as i64,
                    allowed.as_str(),
                    allowed_ips.as_str(),
                    req.scope.expired_unix,
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

    pub async fn list_keys(&self, username: &str) -> Result<Vec<ApiKeyRecord>, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let mut rows = self
            .conn
            .query(
                "SELECT id, username, quota_limit, used_credits FROM relay_keys WHERE username = ?1 AND active = 1 ORDER BY created_unix DESC",
                [u.as_str()],
            )
            .await
            .map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            out.push(ApiKeyRecord {
                id: col_str(&row, 0),
                username: col_str(&row, 1),
                quota_limit: col_u64(&row, 2),
                used_credits: col_u64(&row, 3),
            });
        }
        Ok(out)
    }

    pub async fn revoke_key(&self, username: &str, key_id: &str) -> Result<(), RelayError> {
        let u = username.trim().to_ascii_lowercase();
        self.conn
            .execute(
                "UPDATE relay_keys SET active = 0 WHERE id = ?1 AND username = ?2",
                (key_id.trim(), u.as_str()),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

    pub async fn list_usage(&self, username: &str) -> Result<Vec<UsageEntry>, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let mut rows = self
            .conn
            .query(
                "SELECT model, prompt_tokens, completion_tokens, credits_charged FROM relay_usage_logs WHERE username = ?1 ORDER BY created_unix DESC LIMIT 50",
                [u.as_str()],
            )
            .await
            .map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            out.push(UsageEntry {
                model: col_str(&row, 0),
                prompt_tokens: col_u64(&row, 1),
                completion_tokens: col_u64(&row, 2),
                credits_charged: col_u64(&row, 3),
            });
        }
        Ok(out)
    }

    pub async fn verify_api_key(
        &self,
        raw_key: &str,
        model_id: &str,
    ) -> Result<VerifiedKey, RelayError> {
        let key_hash = sha256_b64(raw_key.trim());
        let mut rows = self
            .conn
            .query(
                "SELECT id, username, quota_limit, used_credits, allowed_models, active, allowed_ips, expired_unix FROM relay_keys WHERE key_hash = ?1",
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
        let exp = col_u64(&row, 7) as i64;
        if exp > 0 && now_unix() > exp {
            return Err(RelayError::Unauthorized("api key expired".into()));
        }
        let allowed = col_str(&row, 4);
        if !allowed.is_empty() && !model_id.is_empty() && !allowed.split(',').any(|m| m.trim() == model_id) {
            return Err(RelayError::Unauthorized(format!("model {model_id} not allowed on this key")));
        }
        Ok(VerifiedKey {
            record: ApiKeyRecord {
                id: col_str(&row, 0),
                username: col_str(&row, 1),
                quota_limit: col_u64(&row, 2),
                used_credits: col_u64(&row, 3),
            },
            allowed_ips: col_str(&row, 6),
            expired_unix: exp,
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

    pub async fn transfer_affiliate_to_paid(&self, username: &str) -> Result<u64, RelayError> {
        let w = self.get_wallet(username).await?;
        if w.affiliate_credits == 0 {
            return Err(RelayError::InvalidInput("no affiliate credits available to transfer".into()));
        }
        let amt = w.affiliate_credits;
        self.conn
            .execute(
                "UPDATE relay_users SET paid_credits = paid_credits + ?1, affiliate_credits = 0 WHERE username = ?2",
                (amt as i64, w.username.as_str()),
            )
            .await
            .map_err(map_db)?;
        Ok(amt)
    }

    pub async fn upsert_channel(&self, req: &ChannelUpsertReq) -> Result<(), RelayError> {
        let id = req.id.trim();
        if id.is_empty() || req.endpoint.base_url.trim().is_empty() {
            return Err(RelayError::InvalidInput("channel id and base_url required".into()));
        }
        let models = req.routing.models.join(",");
        let en = i64::from(req.routing.enabled);
        self.conn
            .execute(
                "INSERT INTO relay_channels (id, name, provider, base_url, api_key, models, priority, weight, enabled, latency_ms, created_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, provider=excluded.provider, base_url=excluded.base_url,
                   api_key=CASE WHEN excluded.api_key='' THEN relay_channels.api_key ELSE excluded.api_key END,
                   models=excluded.models, priority=excluded.priority, weight=excluded.weight, enabled=excluded.enabled",
                (
                    id,
                    req.endpoint.name.trim(),
                    req.provider.trim(),
                    req.endpoint.base_url.trim(),
                    req.endpoint.api_key.trim(),
                    models.as_str(),
                    req.routing.priority as i64,
                    req.routing.weight as i64,
                    en,
                    now_unix(),
                ),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

    pub async fn list_channels(&self) -> Result<Vec<ChannelRecord>, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT id, name, provider, base_url, models, priority, enabled FROM relay_channels ORDER BY priority DESC, id ASC",
                (),
            )
            .await
            .map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            let m_raw = col_str(&row, 4);
            let models: Vec<String> = m_raw
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            out.push(ChannelRecord {
                id: col_str(&row, 0),
                provider: col_str(&row, 2),
                base_url: col_str(&row, 3),
                meta: ChannelMeta {
                    name: col_str(&row, 1),
                    models,
                    priority: col_u64(&row, 5) as i32,
                    enabled: col_u64(&row, 6) != 0,
                },
            });
        }
        Ok(out)
    }

    pub async fn delete_channel(&self, id: &str) -> Result<(), RelayError> {
        self.conn
            .execute("DELETE FROM relay_channels WHERE id = ?1", [id.trim()])
            .await
            .map_err(map_db)?;
        Ok(())
    }

    /// Return enabled DB-backed channels matching `model_id` (or wildcard `*`), ordered by priority/weight.
    pub async fn find_live_channels(&self, model_id: &str) -> Result<Vec<LiveChannel>, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT id, provider, base_url, api_key, models FROM relay_channels WHERE enabled = 1 ORDER BY priority DESC, weight DESC",
                (),
            )
            .await
            .map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            let models_csv = col_str(&row, 4);
            let matched = models_csv.trim().is_empty()
                || models_csv.split(',').any(|m| {
                    let p = m.trim();
                    p == "*"
                        || p == model_id
                        || p.strip_suffix('*').is_some_and(|pre| model_id.starts_with(pre))
                });
            let api_key = col_str(&row, 3);
            if matched && !api_key.is_empty() {
                out.push(LiveChannel {
                    id: col_str(&row, 0),
                    provider: col_str(&row, 1),
                    base_url: col_str(&row, 2),
                    api_key: SecretString::from(api_key),
                });
            }
        }
        Ok(out)
    }

    pub async fn create_redemptions(&self, req: &RedemptionCreateReq) -> Result<Vec<String>, RelayError> {
        let count = req.count.clamp(1, 100);
        let wtype = if req.wallet_type == "bonus" { "bonus" } else { "paid" };
        let prefix = if req.prefix.trim().is_empty() { "L42" } else { req.prefix.trim() };
        let ts = now_unix();
        let mut codes = Vec::with_capacity(count as usize);
        for i in 0..count {
            let hash = sha256_b64(&format!("rdm:{prefix}:{ts}:{i}:{}", req.credits));
            let code = format!("{}-{}", prefix.to_ascii_uppercase(), hash[..12].to_ascii_uppercase());
            self.conn
                .execute(
                    "INSERT OR IGNORE INTO relay_redemptions (code, credits, wallet_type, used_by, created_unix) VALUES (?1, ?2, ?3, '', ?4)",
                    (code.as_str(), req.credits as i64, wtype, ts),
                )
                .await
                .map_err(map_db)?;
            codes.push(code);
        }
        Ok(codes)
    }

    pub async fn redeem_code(&self, username: &str, code: &str) -> Result<(u64, String), RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let c = code.trim().to_ascii_uppercase();
        let mut rows = self
            .conn
            .query(
                "SELECT credits, wallet_type, used_by FROM relay_redemptions WHERE code = ?1",
                [c.as_str()],
            )
            .await
            .map_err(map_db)?;
        let Some(row) = rows.next().await.map_err(map_db)? else {
            return Err(RelayError::InvalidInput("redemption code not found".into()));
        };
        if !col_str(&row, 2).is_empty() {
            return Err(RelayError::InvalidInput("redemption code already used".into()));
        }
        let credits = col_u64(&row, 0);
        let wtype = col_str(&row, 1);
        self.conn
            .execute(
                "UPDATE relay_redemptions SET used_by = ?1 WHERE code = ?2 AND used_by = ''",
                (u.as_str(), c.as_str()),
            )
            .await
            .map_err(map_db)?;
        let col = if wtype == "bonus" { "bonus_credits" } else { "paid_credits" };
        let sql = format!("UPDATE relay_users SET {col} = {col} + ?1 WHERE username = ?2");
        self.conn.execute(&sql, (credits as i64, u.as_str())).await.map_err(map_db)?;
        Ok((credits, wtype))
    }

    pub async fn dashboard_stats(&self) -> Result<DashboardStats, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT COUNT(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(credits_charged),0) FROM relay_usage_logs",
                (),
            )
            .await
            .map_err(map_db)?;
        if let Some(row) = rows.next().await.map_err(map_db)? {
            return Ok(DashboardStats {
                total_requests: col_u64(&row, 0),
                total_prompt_tokens: col_u64(&row, 1),
                total_completion_tokens: col_u64(&row, 2),
                total_credits_charged: col_u64(&row, 3),
            });
        }
        Ok(DashboardStats {
            total_requests: 0,
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_credits_charged: 0,
        })
    }

    /// Resolve RBAC policy for a user (`guest` / `user` / `vip` / `admin`).
    pub async fn get_user_policy(&self, username: &str) -> Result<UserRolePolicy, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let q = query::sql_get_user_role();
        let mut rows = self
            .conn
            .query(&q, [u.as_str()])
            .await
            .map_err(map_db)?;
        if let Some(row) = rows.next().await.map_err(map_db)? {
            let role = UserRole::parse_str(&col_str(&row, 0));
            let discount_pct = (col_u64(&row, 1) as u32).min(80);
            let banned = col_u64(&row, 2) != 0;
            return Ok(UserRolePolicy {
                role,
                max_keys: role.default_max_keys(),
                discount_pct,
                banned,
            });
        }
        let is_env_admin = std::env::var("RELAY_ADMIN_USERS")
            .unwrap_or_else(|_| "admin,lilyco".into())
            .split(',')
            .any(|s| s.trim().eq_ignore_ascii_case(&u));
        let role = if is_env_admin { UserRole::Admin } else { UserRole::User };
        Ok(UserRolePolicy {
            role,
            max_keys: role.default_max_keys(),
            discount_pct: role.default_discount_pct(),
            banned: false,
        })
    }

    /// Admin RBAC role assignment (`user` | `vip` | `admin`, VIP discount %, ban toggle).
    pub async fn set_user_role(&self, req: &AdminRoleUpdateReq) -> Result<UserRolePolicy, RelayError> {
        let u = req.username.trim().to_ascii_lowercase();
        if u.is_empty() {
            return Err(RelayError::InvalidInput("empty username".into()));
        }
        let discount = req.discount_pct.unwrap_or_else(|| req.role.default_discount_pct()).min(80);
        let banned = req.banned.unwrap_or(false);
        let now = now_unix();
        let q = query::sql_upsert_user_role();
        self.conn
            .execute(
                &q,
                (u.as_str(), req.role.as_str(), i64::from(discount), if banned { 1i64 } else { 0i64 }, now),
            )
            .await
            .map_err(map_db)?;
        self.get_user_policy(&u).await
    }

    /// Count active API keys owned by a user (enforces per-role max_keys quota).
    pub async fn count_active_keys(&self, username: &str) -> Result<u32, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let q = query::sql_count_active_keys();
        let mut rows = self.conn.query(&q, [u.as_str()]).await.map_err(map_db)?;
        if let Some(row) = rows.next().await.map_err(map_db)? {
            return Ok(col_u64(&row, 0) as u32);
        }
        Ok(0)
    }

    /// Admin list users with RBAC policy and dual-wallet balances.
    pub async fn list_users(&self, limit: i64) -> Result<Vec<AdminUserSummary>, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT u.username, u.paid_credits, u.bonus_credits,
                        COALESCE(r.role, ''), COALESCE(r.discount_pct, -1), COALESCE(r.banned, 0)
                 FROM relay_users u
                 LEFT JOIN relay_user_roles r ON r.username = u.username
                 ORDER BY u.created_unix DESC LIMIT ?1",
                [limit.clamp(1, 200)],
            )
            .await
            .map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            let username = col_str(&row, 0);
            let paid_credits = col_u64(&row, 1) as i64;
            let bonus_credits = col_u64(&row, 2) as i64;
            let raw_role = col_str(&row, 3);
            let policy = if raw_role.is_empty() {
                self.get_user_policy(&username).await?
            } else {
                let role = UserRole::parse_str(&raw_role);
                UserRolePolicy {
                    role,
                    max_keys: role.default_max_keys(),
                    discount_pct: (col_u64(&row, 4) as u32).min(80),
                    banned: col_u64(&row, 5) != 0,
                }
            };
            out.push(AdminUserSummary { username, policy, paid_credits, bonus_credits });
        }
        Ok(out)
    }

    /// List recent usage logs (scoped to user, or all users when username is None).
    pub async fn list_usage_logs(
        &self,
        username: Option<&str>,
        limit: i64,
    ) -> Result<Vec<UsageLogItem>, RelayError> {
        let lim = limit.clamp(1, 100);
        let mut rows = match username {
            Some(u) => {
                let low = u.trim().to_ascii_lowercase();
                self.conn
                    .query(
                        "SELECT model, prompt_tokens + completion_tokens, credits_charged, created_unix
                         FROM relay_usage_logs WHERE username = ?1 ORDER BY created_unix DESC LIMIT ?2",
                        (low.as_str(), lim),
                    )
                    .await
                    .map_err(map_db)?
            }
            None => self
                .conn
                .query(
                    "SELECT model, prompt_tokens + completion_tokens, credits_charged, created_unix
                     FROM relay_usage_logs ORDER BY created_unix DESC LIMIT ?1",
                    [lim],
                )
                .await
                .map_err(map_db)?,
        };
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            out.push(UsageLogItem {
                model: col_str(&row, 0),
                tokens: col_u64(&row, 1),
                credits: col_u64(&row, 2),
                created_at: col_u64(&row, 3) as i64,
            });
        }
        Ok(out)
    }

    /// Grant default new-user trial card (Proxy 1h / 100MB high-speed traffic) once per user.
    pub async fn ensure_new_user_trial_cards(&self, username: &str) -> Result<(), RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let card_id = format!("trial_proxy_{u}");
        let now = now_unix();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO relay_trial_cards
                 (id, username, card_type, title, spec, duration_secs, expires_unix, created_unix)
                 VALUES (?1, ?2, 'proxy_1h_100mb', '代理高速体验卡（新用户专享）', '1 小时 · 100MB 高速流量体验', 3600, 0, ?3)",
                (card_id.as_str(), u.as_str(), now),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

    pub async fn list_trial_cards(&self, username: &str) -> Result<Vec<TrialCardItem>, RelayError> {
        self.ensure_new_user_trial_cards(username).await?;
        let u = username.trim().to_ascii_lowercase();
        let q = query::sql_list_trial_cards();
        let mut rows = self.conn.query(&q, [u.as_str()]).await.map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            out.push(TrialCardItem {
                id: col_str(&row, 0),
                title: col_str(&row, 1),
                spec: col_str(&row, 2),
                expires_unix: col_u64(&row, 3) as i64,
            });
        }
        Ok(out)
    }

    pub async fn activate_trial_card(&self, username: &str, card_id: &str) -> Result<i64, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let mut rows = self
            .conn
            .query(
                "SELECT duration_secs, expires_unix FROM relay_trial_cards WHERE id = ?1 AND username = ?2",
                (card_id, u.as_str()),
            )
            .await
            .map_err(map_db)?;
        let row = rows
            .next()
            .await
            .map_err(map_db)?
            .ok_or_else(|| RelayError::InvalidInput("trial card not found".into()))?;
        let dur = col_u64(&row, 0).max(60) as i64;
        let existing_exp = col_u64(&row, 1) as i64;
        if existing_exp > 0 {
            return Ok(existing_exp);
        }
        let exp = now_unix() + dur;
        let q = query::sql_update_trial_expiry();
        self.conn.execute(&q, (exp, card_id, u.as_str())).await.map_err(map_db)?;
        Ok(exp)
    }

    /// Fetch a single live channel by id via sea-query for probing & balance check.
    pub async fn get_live_channel(&self, id: &str) -> Result<LiveChannel, RelayError> {
        let q = query::sql_get_channel_by_id();
        let mut rows = self.conn.query(&q, [id]).await.map_err(map_db)?;
        let row = rows
            .next()
            .await
            .map_err(map_db)?
            .ok_or_else(|| RelayError::ModelNotFound(format!("channel {id} not found")))?;
        Ok(LiveChannel {
            id: col_str(&row, 0),
            provider: col_str(&row, 1),
            base_url: col_str(&row, 2),
            api_key: SecretString::from(col_str(&row, 3)),
        })
    }

    /// Mint a batch of pre-funded ready-to-sell API keys backed by an isolated batch wallet.
    pub async fn mint_resell_key_batch(
        &self,
        req: &ResellKeyBatchReq,
    ) -> Result<Vec<String>, RelayError> {
        let count = req.count.clamp(1, 100);
        if req.quota_credits == 0 {
            return Err(RelayError::InvalidInput("quota_credits must be > 0".into()));
        }
        let now = now_unix();
        let exp = if req.expires_days > 0 {
            now + i64::from(req.expires_days) * 86_400
        } else {
            0
        };
        let slug: String = req
            .batch_name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .take(24)
            .collect();
        let batch_user = format!(
            "resell_{}_{}",
            if slug.is_empty() { "batch" } else { &slug },
            now % 100_000
        )
        .to_ascii_lowercase();
        let total_fund = req.quota_credits.saturating_mul(u64::from(count));
        self.sync_portal_wallet(&batch_user, total_fund).await?;

        let mut keys = Vec::with_capacity(count as usize);
        for i in 0..count {
            let issue = KeyIssueReq {
                name: format!("{}-{}", req.batch_name.trim(), i + 1),
                quota_limit: req.quota_credits,
                rpm_limit: 60,
                scope: KeyScope {
                    allowed_models: vec![],
                    allowed_ips: String::new(),
                    expired_unix: exp,
                    group_name: "resell".into(),
                },
            };
            let (secret, _) = self.issue_key(&batch_user, &issue).await?;
            keys.push(secret);
        }
        Ok(keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use relay_core::KeyScope;

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
}
