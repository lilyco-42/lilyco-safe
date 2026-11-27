use relay_core::{
    KeyIssueReq, KeyScope, KeyUpdateReq, ModelUsageBreakdown, RelayError, ResellKeyBatchReq,
    TokenUsage, UsageLogItem,
};

use super::{
    ApiKeyRecord, DashboardStats, HoldReceipt, RelayLedger, UsageEntry, UserWallet, VerifiedKey,
    col_str, col_u64, map_db, now_unix, sha256_b64,
};
use crate::query;

impl RelayLedger {

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


    pub async fn count_active_keys(&self, username: &str) -> Result<u32, RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let q = query::sql_count_active_keys();
        let mut rows = self.conn.query(&q, [u.as_str()]).await.map_err(map_db)?;
        if let Some(row) = rows.next().await.map_err(map_db)? {
            return Ok(col_u64(&row, 0) as u32);
        }
        Ok(0)
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


    /// Update an existing API key's name, quota limit, active toggle, or scope restrictions.
    pub async fn update_key(
        &self,
        username: &str,
        key_id: &str,
        req: &KeyUpdateReq,
    ) -> Result<(), RelayError> {
        let u = username.trim().to_ascii_lowercase();
        let kid = key_id.trim();
        let mut rows = self
            .conn
            .query(
                "SELECT name, quota_limit, active, allowed_models, allowed_ips, expired_unix FROM relay_keys WHERE id = ?1 AND username = ?2",
                (kid, u.as_str()),
            )
            .await
            .map_err(map_db)?;
        let Some(row) = rows.next().await.map_err(map_db)? else {
            return Err(RelayError::ModelNotFound(format!("key {kid} not found")));
        };
        let name = req.name.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&col_str(&row, 0)).to_string();
        let quota = req.quota_limit.unwrap_or_else(|| col_u64(&row, 1));
        let active = req.active.map(i64::from).unwrap_or_else(|| col_u64(&row, 2) as i64);
        let allowed_models = req
            .scope
            .as_ref()
            .map(|s| s.allowed_models.join(","))
            .unwrap_or_else(|| col_str(&row, 3));
        let allowed_ips = req
            .scope
            .as_ref()
            .map(|s| s.allowed_ips.trim().to_string())
            .unwrap_or_else(|| col_str(&row, 4));
        let expired_unix = req
            .scope
            .as_ref()
            .map(|s| s.expired_unix)
            .unwrap_or_else(|| col_u64(&row, 5) as i64);
        self.conn
            .execute(
                "UPDATE relay_keys SET name=?1, quota_limit=?2, active=?3, allowed_models=?4, allowed_ips=?5, expired_unix=?6 WHERE id=?7 AND username=?8",
                (name.as_str(), quota as i64, active, allowed_models.as_str(), allowed_ips.as_str(), expired_unix, kid, u.as_str()),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }


    /// Per-model usage breakdown (top models by requests/tokens/credits) for charts.
    pub async fn usage_breakdown_by_model(
        &self,
        username: Option<&str>,
        limit: i64,
    ) -> Result<Vec<ModelUsageBreakdown>, RelayError> {
        let lim = limit.clamp(1, 50);
        let mut rows = match username {
            Some(u) => {
                let low = u.trim().to_ascii_lowercase();
                self.conn
                    .query(
                        "SELECT model, COUNT(*), COALESCE(SUM(prompt_tokens + completion_tokens),0), COALESCE(SUM(credits_charged),0)
                         FROM relay_usage_logs WHERE username = ?1 GROUP BY model ORDER BY COUNT(*) DESC LIMIT ?2",
                        (low.as_str(), lim),
                    )
                    .await
                    .map_err(map_db)?
            }
            None => self
                .conn
                .query(
                    "SELECT model, COUNT(*), COALESCE(SUM(prompt_tokens + completion_tokens),0), COALESCE(SUM(credits_charged),0)
                     FROM relay_usage_logs GROUP BY model ORDER BY COUNT(*) DESC LIMIT ?1",
                    [lim],
                )
                .await
                .map_err(map_db)?,
        };
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            out.push(ModelUsageBreakdown {
                model: col_str(&row, 0),
                requests: col_u64(&row, 1),
                tokens: col_u64(&row, 2),
                credits: col_u64(&row, 3),
            });
        }
        Ok(out)
    }

    /// Resolve API key + owner wallet for OpenAI-compatible `/v1/dashboard/billing/*` endpoints.
    pub async fn verify_key_for_billing(&self, raw_key: &str) -> Result<(ApiKeyRecord, UserWallet), RelayError> {
        let verified = self.verify_api_key(raw_key, "").await?;
        let wallet = self.get_wallet(&verified.record.username).await?;
        Ok((verified.record, wallet))
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
