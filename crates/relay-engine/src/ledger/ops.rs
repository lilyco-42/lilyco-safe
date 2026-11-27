use std::collections::HashMap;

use relay_core::{
    AdminRoleUpdateReq, AdminUserSummary, AsyncTaskMeta, AsyncTaskRecord, AsyncTaskResult,
    BillingMode, ModelPricingOverride, ModelRateSpec, RedemptionCreateReq, RedemptionRecord,
    RelayError, TrialCardItem, UserRole, UserRolePolicy,
};

use super::{RelayLedger, col_str, col_u64, map_db, now_unix, sha256_b64};
use crate::query;

impl RelayLedger {
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


    /// Persist a live admin model pricing override (takes effect immediately without restart).
    pub async fn upsert_model_pricing(&self, ov: &ModelPricingOverride) -> Result<(), RelayError> {
        let mid = ov.model_id.trim();
        if mid.is_empty() {
            return Err(RelayError::InvalidInput("model_id required".into()));
        }
        let mode_str = match ov.billing_mode {
            BillingMode::Token => "token",
            BillingMode::PerCall => "per_call",
            BillingMode::PerSecond => "per_second",
        };
        self.conn
            .execute(
                "INSERT INTO relay_model_pricing (model_id, billing_mode, input_per_m, output_per_m, unit_credits, allow_free, updated_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(model_id) DO UPDATE SET
                   billing_mode=excluded.billing_mode, input_per_m=excluded.input_per_m,
                   output_per_m=excluded.output_per_m, unit_credits=excluded.unit_credits,
                   allow_free=excluded.allow_free, updated_unix=excluded.updated_unix",
                (
                    mid,
                    mode_str,
                    ov.rates.input_per_m as i64,
                    ov.rates.output_per_m as i64,
                    ov.rates.unit_credits as i64,
                    i64::from(ov.rates.allow_free),
                    now_unix(),
                ),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

    pub async fn delete_model_pricing(&self, model_id: &str) -> Result<(), RelayError> {
        self.conn
            .execute("DELETE FROM relay_model_pricing WHERE model_id = ?1", [model_id.trim()])
            .await
            .map_err(map_db)?;
        Ok(())
    }

    pub async fn list_model_pricing(&self) -> Result<Vec<ModelPricingOverride>, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT model_id, billing_mode, input_per_m, output_per_m, unit_credits, allow_free FROM relay_model_pricing",
                (),
            )
            .await
            .map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            let billing_mode = match col_str(&row, 1).as_str() {
                "per_call" => BillingMode::PerCall,
                "per_second" => BillingMode::PerSecond,
                _ => BillingMode::Token,
            };
            out.push(ModelPricingOverride {
                model_id: col_str(&row, 0),
                billing_mode,
                rates: ModelRateSpec {
                    input_per_m: col_u64(&row, 2),
                    output_per_m: col_u64(&row, 3),
                    unit_credits: col_u64(&row, 4),
                    allow_free: col_u64(&row, 5) != 0,
                },
            });
        }
        Ok(out)
    }

    /// Create a unified async multimodal task entry (video / music / image).
    pub async fn create_async_task(
        &self,
        meta: &AsyncTaskMeta,
        credits_charged: u64,
        result_json: &str,
    ) -> Result<AsyncTaskRecord, RelayError> {
        let ts = now_unix();
        let seed = format!("task:{}:{}:{}:{ts}", meta.username, meta.model, meta.provider_op);
        let id = format!("task_{}", &sha256_b64(&seed)[..16]);
        let status = if meta.task_type == "video" { "queued" } else { "succeeded" };
        self.conn
            .execute(
                "INSERT INTO relay_async_tasks (id, username, task_type, model, provider_op, status, credits_charged, result_json, created_unix, updated_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                (
                    id.as_str(),
                    meta.username.trim().to_ascii_lowercase().as_str(),
                    meta.task_type.as_str(),
                    meta.model.as_str(),
                    meta.provider_op.as_str(),
                    status,
                    credits_charged as i64,
                    result_json,
                    ts,
                ),
            )
            .await
            .map_err(map_db)?;
        Ok(AsyncTaskRecord {
            id,
            status: status.to_string(),
            meta: meta.clone(),
            result: AsyncTaskResult {
                credits_charged,
                result_json: result_json.to_string(),
                created_unix: ts,
                updated_unix: ts,
            },
        })
    }

    pub async fn update_async_task_by_op(
        &self,
        provider_op: &str,
        status: &str,
        result_json: &str,
    ) -> Result<(), RelayError> {
        self.conn
            .execute(
                "UPDATE relay_async_tasks SET status = ?1, result_json = ?2, updated_unix = ?3 WHERE provider_op = ?4",
                (status, result_json, now_unix(), provider_op.trim()),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

    pub async fn list_async_tasks(
        &self,
        username: Option<&str>,
        limit: i64,
    ) -> Result<Vec<AsyncTaskRecord>, RelayError> {
        let lim = limit.clamp(1, 100);
        let mut rows = match username {
            Some(u) => {
                let low = u.trim().to_ascii_lowercase();
                self.conn
                    .query(
                        "SELECT id, status, username, task_type, model, provider_op, credits_charged, result_json, created_unix, updated_unix
                         FROM relay_async_tasks WHERE username = ?1 ORDER BY created_unix DESC LIMIT ?2",
                        (low.as_str(), lim),
                    )
                    .await
                    .map_err(map_db)?
            }
            None => self
                .conn
                .query(
                    "SELECT id, status, username, task_type, model, provider_op, credits_charged, result_json, created_unix, updated_unix
                     FROM relay_async_tasks ORDER BY created_unix DESC LIMIT ?1",
                    [lim],
                )
                .await
                .map_err(map_db)?,
        };
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            out.push(AsyncTaskRecord {
                id: col_str(&row, 0),
                status: col_str(&row, 1),
                meta: AsyncTaskMeta {
                    username: col_str(&row, 2),
                    task_type: col_str(&row, 3),
                    model: col_str(&row, 4),
                    provider_op: col_str(&row, 5),
                },
                result: AsyncTaskResult {
                    credits_charged: col_u64(&row, 6),
                    result_json: col_str(&row, 7),
                    created_unix: col_u64(&row, 8) as i64,
                    updated_unix: col_u64(&row, 9) as i64,
                },
            });
        }
        Ok(out)
    }

    pub async fn get_async_task(&self, id: &str) -> Result<AsyncTaskRecord, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT id, status, username, task_type, model, provider_op, credits_charged, result_json, created_unix, updated_unix
                 FROM relay_async_tasks WHERE id = ?1",
                [id.trim()],
            )
            .await
            .map_err(map_db)?;
        let row = rows
            .next()
            .await
            .map_err(map_db)?
            .ok_or_else(|| RelayError::ModelNotFound(format!("task {id} not found")))?;
        Ok(AsyncTaskRecord {
            id: col_str(&row, 0),
            status: col_str(&row, 1),
            meta: AsyncTaskMeta {
                username: col_str(&row, 2),
                task_type: col_str(&row, 3),
                model: col_str(&row, 4),
                provider_op: col_str(&row, 5),
            },
            result: AsyncTaskResult {
                credits_charged: col_u64(&row, 6),
                result_json: col_str(&row, 7),
                created_unix: col_u64(&row, 8) as i64,
                updated_unix: col_u64(&row, 9) as i64,
            },
        })
    }


    pub async fn list_redemptions(&self, limit: i64) -> Result<Vec<RedemptionRecord>, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT code, credits, wallet_type, used_by FROM relay_redemptions ORDER BY created_unix DESC LIMIT ?1",
                [limit.clamp(1, 200)],
            )
            .await
            .map_err(map_db)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            out.push(RedemptionRecord {
                code: col_str(&row, 0),
                credits: col_u64(&row, 1),
                wallet_type: col_str(&row, 2),
                used_by: col_str(&row, 3),
            });
        }
        Ok(out)
    }

    pub async fn delete_redemption(&self, code: &str) -> Result<(), RelayError> {
        let c = code.trim().to_ascii_uppercase();
        self.conn
            .execute("DELETE FROM relay_redemptions WHERE code = ?1 AND used_by = ''", [c.as_str()])
            .await
            .map_err(map_db)?;
        Ok(())
    }

    pub async fn get_options(&self) -> Result<HashMap<String, String>, RelayError> {
        let mut rows = self
            .conn
            .query("SELECT opt_key, opt_val FROM relay_options", ())
            .await
            .map_err(map_db)?;
        let mut map = HashMap::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            map.insert(col_str(&row, 0), col_str(&row, 1));
        }
        Ok(map)
    }

    pub async fn set_option(&self, key: &str, value: &str) -> Result<(), RelayError> {
        let k = key.trim();
        if k.is_empty() || k.len() > 64 {
            return Err(RelayError::InvalidInput("option key must be 1..64 chars".into()));
        }
        self.conn
            .execute(
                "INSERT INTO relay_options (opt_key, opt_val, updated_unix) VALUES (?1, ?2, ?3)
                 ON CONFLICT(opt_key) DO UPDATE SET opt_val=excluded.opt_val, updated_unix=excluded.updated_unix",
                (k, value, now_unix()),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

}
