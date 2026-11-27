use relay_core::{ChannelPolicy, ChannelUpsertReq, RelayError};
use secrecy::SecretString;

use super::{ChannelMeta, ChannelRecord, LiveChannel, RelayLedger, col_str, col_u64, map_db, now_unix};

impl RelayLedger {
    pub async fn upsert_channel(&self, req: &ChannelUpsertReq) -> Result<(), RelayError> {
        let id = req.id.trim();
        if id.is_empty() || req.endpoint.base_url.trim().is_empty() {
            return Err(RelayError::InvalidInput("channel id and base_url required".into()));
        }
        let models = req.routing.models.join(",");
        let en = i64::from(req.routing.enabled);
        let mapping_json = serde_json::to_string(&req.endpoint.policy.model_mapping)
            .unwrap_or_else(|_| "{}".to_string());
        let daily_limit = req.endpoint.policy.daily_limit as i64;
        self.conn
            .execute(
                "INSERT INTO relay_channels (id, name, provider, base_url, api_key, models, priority, weight, enabled, latency_ms, created_unix, model_mapping, daily_limit)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, provider=excluded.provider, base_url=excluded.base_url,
                   api_key=CASE WHEN excluded.api_key='' THEN relay_channels.api_key ELSE excluded.api_key END,
                   models=excluded.models, priority=excluded.priority, weight=excluded.weight, enabled=excluded.enabled,
                   model_mapping=excluded.model_mapping, daily_limit=excluded.daily_limit",
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
                    mapping_json.as_str(),
                    daily_limit,
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
                "SELECT id, name, provider, base_url, models, priority, enabled, COALESCE(model_mapping, '{}'), COALESCE(daily_limit, 0) FROM relay_channels ORDER BY priority DESC, id ASC",
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
            let model_mapping = serde_json::from_str(&col_str(&row, 7)).unwrap_or_default();
            let daily_limit = col_u64(&row, 8);
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
                policy: ChannelPolicy { model_mapping, daily_limit },
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
        self.find_live_channels_with_owner(model_id, "").await
    }

    /// Return enabled DB-backed channels for `model_id`, prioritizing the model's owning `owner_channel_id` first
    /// so dynamically synced models (e.g. `deepseek-ai/*` from `siliconflow-cn`) always hit their owning channel
    /// before falling back to wildcard (`*`) pools like OpenRouter.
    pub async fn find_live_channels_with_owner(
        &self,
        model_id: &str,
        owner_channel_id: &str,
    ) -> Result<Vec<LiveChannel>, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT id, provider, base_url, api_key, models, COALESCE(model_mapping, '{}'), COALESCE(daily_limit, 0) FROM relay_channels WHERE enabled = 1 ORDER BY priority DESC, weight DESC",
                (),
            )
            .await
            .map_err(map_db)?;
        let mut owned = Vec::new();
        let mut rest = Vec::new();
        while let Some(row) = rows.next().await.map_err(map_db)? {
            let cid = col_str(&row, 0);
            let is_owner = !owner_channel_id.is_empty() && cid == owner_channel_id;
            let models_csv = col_str(&row, 4);
            let matched = is_owner
                || models_csv.trim().is_empty()
                || models_csv.split(',').any(|m| {
                    let p = m.trim();
                    p == "*"
                        || p == model_id
                        || p.strip_suffix('*').is_some_and(|pre| model_id.starts_with(pre))
                });
            let api_key = col_str(&row, 3);
            if matched && !api_key.is_empty() {
                let model_mapping = serde_json::from_str(&col_str(&row, 5)).unwrap_or_default();
                let daily_limit = col_u64(&row, 6);
                let ch = LiveChannel {
                    id: cid,
                    provider: col_str(&row, 1),
                    base_url: col_str(&row, 2),
                    api_key: SecretString::from(api_key),
                    policy: ChannelPolicy { model_mapping, daily_limit },
                };
                if is_owner {
                    owned.push(ch);
                } else {
                    rest.push(ch);
                }
            }
        }
        owned.extend(rest);
        Ok(owned)
    }


    /// Fetch a single live channel by id for probing & balance check.
    pub async fn get_live_channel(&self, id: &str) -> Result<LiveChannel, RelayError> {
        let mut rows = self
            .conn
            .query(
                "SELECT id, provider, base_url, api_key, COALESCE(model_mapping, '{}'), COALESCE(daily_limit, 0) FROM relay_channels WHERE id = ?1",
                [id],
            )
            .await
            .map_err(map_db)?;
        let row = rows
            .next()
            .await
            .map_err(map_db)?
            .ok_or_else(|| RelayError::ModelNotFound(format!("channel {id} not found")))?;
        let model_mapping = serde_json::from_str(&col_str(&row, 4)).unwrap_or_default();
        let daily_limit = col_u64(&row, 5);
        Ok(LiveChannel {
            id: col_str(&row, 0),
            provider: col_str(&row, 1),
            base_url: col_str(&row, 2),
            api_key: SecretString::from(col_str(&row, 3)),
            policy: ChannelPolicy { model_mapping, daily_limit },
        })
    }


    /// Quick enable/disable toggle for a channel without resubmitting credentials.
    pub async fn toggle_channel(&self, id: &str, enabled: bool) -> Result<(), RelayError> {
        self.conn
            .execute(
                "UPDATE relay_channels SET enabled = ?1 WHERE id = ?2",
                (i64::from(enabled), id.trim()),
            )
            .await
            .map_err(map_db)?;
        Ok(())
    }

}
