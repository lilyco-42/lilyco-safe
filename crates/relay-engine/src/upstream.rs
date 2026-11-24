use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use relay_core::{
    ChannelConfig, ChannelProbeResult, ChatReq, ModelConfig, ModelsCatalog, RelayError, TokenUsage,
};
use reqwest::Client;
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};

use crate::ledger::LiveChannel;

/// Sanitized upstream completion reply (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct UpstreamReply {
    pub id: String,
    pub model: String,
    pub content: String,
    pub usage: TokenUsage,
}

#[derive(Deserialize)]
struct OpenAiChoiceMsg {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiChoiceMsg,
}

#[derive(Deserialize)]
struct OpenAiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct OpenAiResp {
    id: Option<String>,
    choices: Option<Vec<OpenAiChoice>>,
    usage: Option<OpenAiUsage>,
}

/// Multi-upstream router with lock-free DashMap circuit-breaker & dynamic model cache (4 fields, Rule of 4).
pub struct UpstreamRouter {
    client: Client,
    catalog: ModelsCatalog,
    cooldowns: DashMap<String, u64>,
    dynamic_models: DashMap<String, ModelConfig>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl UpstreamRouter {
    pub fn new(catalog: ModelsCatalog) -> Result<Self, RelayError> {
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(90));
        if let Ok(proxy_url) = std::env::var("UPSTREAM_PROXY")
            && !proxy_url.trim().is_empty()
            && let Ok(proxy) = reqwest::Proxy::all(proxy_url.trim())
        {
            builder = builder.proxy(proxy);
        }
        let client = builder
            .build()
            .map_err(|e| RelayError::Config(format!("http client init: {e}")))?;
        Ok(Self {
            client,
            catalog,
            cooldowns: DashMap::new(),
            dynamic_models: DashMap::new(),
        })
    }

    fn resolve_upstream_model(ch: &ChannelConfig, model: &ModelConfig) -> String {
        let m = model.upstream_model.as_str();
        if ch.provider == "openrouter" && !m.contains('/') {
            if m.starts_with("gemini-") || m.starts_with("gemma-") {
                return format!("google/{m}");
            }
            if m.starts_with("claude-") {
                return format!("anthropic/{m}");
            }
            if m.starts_with("gpt-") {
                return format!("openai/{m}");
            }
            if m.starts_with("deepseek-") {
                return format!("deepseek/{m}");
            }
        }
        if ch.provider == "gemini_openai"
            && let Some(stripped) = m.strip_prefix("google/")
        {
            return stripped.to_string();
        }
        m.to_string()
    }

    pub fn catalog(&self) -> &ModelsCatalog {
        &self.catalog
    }

    /// Merged view of static `models.toml` + dynamically synced upstream models.
    pub fn all_models(&self) -> Vec<ModelConfig> {
        let mut out = self.catalog.models.clone();
        for entry in self.dynamic_models.iter() {
            let m = entry.value();
            if !out.iter().any(|existing| existing.id == m.id) {
                out.push(m.clone());
            }
        }
        out
    }

    /// Look up a model across both static catalog and dynamically synced models.
    pub fn find_model(&self, id: &str) -> Option<ModelConfig> {
        if let Some(m) = self.catalog.find_model(id) {
            return Some(m.clone());
        }
        self.dynamic_models.get(id).map(|v| v.value().clone())
    }

    /// Dynamically pull `/models` from a live upstream channel and merge new models into memory.
    pub async fn sync_channel_models(&self, ch: &LiveChannel) -> Result<usize, RelayError> {
        let base = ch.base_url.trim_end_matches('/');
        let key = ch.api_key.expose_secret();
        let url = format!("{base}/models");
        let resp = self
            .client
            .get(&url)
            .bearer_auth(key)
            .send()
            .await
            .map_err(|e| RelayError::UpstreamFailed(format!("sync {}: {e}", ch.id)))?;
        if !resp.status().is_success() {
            return Err(RelayError::UpstreamFailed(format!(
                "sync {} http {}",
                ch.id,
                resp.status()
            )));
        }
        let val: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| RelayError::UpstreamFailed(format!("sync {} json: {e}", ch.id)))?;
        let arr = val
            .get("data")
            .and_then(|d| d.as_array())
            .or_else(|| val.get("models").and_then(|d| d.as_array()));
        let Some(items) = arr else {
            return Ok(0);
        };
        let is_free_pool = ch.id.to_lowercase().contains("free");
        let mut added = 0usize;
        for item in items.iter().take(120) {
            let raw_id = item
                .get("id")
                .or_else(|| item.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if raw_id.is_empty() {
                continue;
            }
            let clean = raw_id.strip_prefix("models/").unwrap_or(raw_id);
            let model_id = if is_free_pool && !clean.starts_with("free:") {
                format!("free:{clean}")
            } else {
                clean.to_string()
            };
            if self.catalog.find_model(&model_id).is_some() {
                continue;
            }
            let free_flag = is_free_pool || clean.ends_with(":free");
            self.dynamic_models.insert(
                model_id.clone(),
                ModelConfig {
                    id: model_id,
                    channel_id: ch.id.clone(),
                    upstream_model: clean.to_string(),
                    input_per_m: if free_flag { 0 } else { 20 },
                    output_per_m: if free_flag { 0 } else { 80 },
                    allow_free: free_flag,
                },
            );
            added += 1;
        }
        Ok(added)
    }

    /// Live probe an upstream channel: measure latency, count `/models`, and query upstream balance.
    pub async fn probe_channel(&self, ch: &LiveChannel) -> ChannelProbeResult {
        let base = ch.base_url.trim_end_matches('/');
        let key = ch.api_key.expose_secret();
        let t0 = std::time::Instant::now();
        let models_url = format!("{base}/models");
        let (ok, models_count) = match self.client.get(&models_url).bearer_auth(key).send().await {
            Ok(r) if r.status().is_success() => {
                let cnt = r
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("data").and_then(|d| d.as_array()).map(|a| a.len()))
                    .unwrap_or(0);
                (true, cnt)
            }
            _ => (false, 0),
        };
        let latency_ms = t0.elapsed().as_millis() as u64;
        let balance_text = self.query_upstream_balance(base, &ch.provider, key).await;
        ChannelProbeResult { ok, latency_ms, models_count, balance_text }
    }

    async fn query_upstream_balance(&self, base: &str, provider: &str, key: &str) -> String {
        // 1. OpenRouter: GET /credits -> data.total_credits - data.total_usage
        if provider == "openrouter" || base.contains("openrouter.ai") {
            let url = format!("{base}/credits");
            if let Ok(r) = self.client.get(&url).bearer_auth(key).send().await
                && r.status().is_success()
                && let Ok(v) = r.json::<serde_json::Value>().await
            {
                let total = v.pointer("/data/total_credits").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let used = v.pointer("/data/total_usage").and_then(|x| x.as_f64()).unwrap_or(0.0);
                return format!("${:.4} 可用 (总额 ${:.2})", (total - used).max(0.0), total);
            }
        }
        // 2. DeepSeek Official: GET /user/balance
        if base.contains("api.deepseek.com") {
            let root = base.trim_end_matches("/v1");
            if let Ok(r) = self.client.get(format!("{root}/user/balance")).bearer_auth(key).send().await
                && r.status().is_success()
                && let Ok(v) = r.json::<serde_json::Value>().await
                && let Some(arr) = v.get("balance_infos").and_then(|x| x.as_array())
                && let Some(first) = arr.first()
            {
                let cur = first.get("currency").and_then(|x| x.as_str()).unwrap_or("CNY");
                let bal = first.get("total_balance").and_then(|x| x.as_str()).unwrap_or("0");
                return format!("{bal} {cur}");
            }
        }
        // 3. SiliconFlow: GET /user/info
        if base.contains("siliconflow")
            && let Ok(r) = self.client.get(format!("{base}/user/info")).bearer_auth(key).send().await
            && r.status().is_success()
            && let Ok(v) = r.json::<serde_json::Value>().await
            && let Some(bal) = v.pointer("/data/totalBalance").and_then(|x| x.as_str())
        {
            return format!("¥{bal} CNY");
        }
        // 4. Generic OpenAI / New-API compatible: /dashboard/billing/credit_grants
        let root = base.trim_end_matches("/v1");
        if let Ok(r) = self
            .client
            .get(format!("{root}/v1/dashboard/billing/credit_grants"))
            .bearer_auth(key)
            .send()
            .await
            && r.status().is_success()
            && let Ok(v) = r.json::<serde_json::Value>().await
            && let Some(avail) = v.get("total_available").and_then(|x| x.as_f64())
        {
            return format!("${avail:.4} 可用");
        }
        "该上游未开放余额接口（已测通）".to_string()
    }

    fn is_cooled(&self, channel_id: &str) -> bool {
        let now = now_unix();
        self.cooldowns
            .get(channel_id)
            .is_some_and(|until| *until > now)
    }

    fn trip_cooldown(&self, channel_id: &str, secs: u64) {
        self.cooldowns.insert(channel_id.to_string(), now_unix() + secs);
    }

    /// Try all DB-backed pool channels first (automatic failover on 429/5xx), then fall back to TOML env channel.
    pub async fn call_chat_with_pool(
        &self,
        model: &ModelConfig,
        req: &ChatReq,
        pool: &[LiveChannel],
    ) -> Result<UpstreamReply, RelayError> {
        let mut last_err: Option<RelayError> = None;
        for lc in pool {
            if self.is_cooled(&lc.id) {
                continue;
            }
            let ch = ChannelConfig {
                id: lc.id.clone(),
                provider: lc.provider.clone(),
                base_url: lc.base_url.clone(),
                api_key_env: String::new(),
                weight: 100,
                enabled: true,
            };
            match self.send_openai_compat(&ch, model, req, lc.api_key.expose_secret()).await {
                Ok(reply) => return Ok(reply),
                Err(e) => last_err = Some(e),
            }
        }
        match self.call_chat(model, req).await {
            Ok(r) => Ok(r),
            Err(e) => Err(last_err.unwrap_or(e)),
        }
    }

    /// Open a true token-by-token upstream SSE stream (`stream: true`) with pool failover.
    pub async fn open_chat_stream_with_pool(
        &self,
        model: &ModelConfig,
        req: &ChatReq,
        pool: &[LiveChannel],
    ) -> Result<reqwest::Response, RelayError> {
        let mut last_err: Option<RelayError> = None;
        for lc in pool {
            if self.is_cooled(&lc.id) {
                continue;
            }
            let ch = ChannelConfig {
                id: lc.id.clone(),
                provider: lc.provider.clone(),
                base_url: lc.base_url.clone(),
                api_key_env: String::new(),
                weight: 100,
                enabled: true,
            };
            match self.open_openai_stream(&ch, model, req, lc.api_key.expose_secret()).await {
                Ok(resp) => return Ok(resp),
                Err(e) => last_err = Some(e),
            }
        }
        if let Some(ch) = self.catalog.find_channel(&model.channel_id)
            && !self.is_cooled(&ch.id)
            && let Ok(api_key) = std::env::var(&ch.api_key_env)
            && !api_key.trim().is_empty()
        {
            return self.open_openai_stream(ch, model, req, &api_key).await;
        }
        Err(last_err.unwrap_or_else(|| RelayError::UpstreamFailed("no live upstream channel".into())))
    }

    async fn open_openai_stream(
        &self,
        ch: &ChannelConfig,
        model: &ModelConfig,
        req: &ChatReq,
        api_key: &str,
    ) -> Result<reqwest::Response, RelayError> {
        let url = format!("{}/chat/completions", ch.base_url.trim_end_matches('/'));
        let upstream_model = Self::resolve_upstream_model(ch, model);
        let mut body = serde_json::json!({
            "model": upstream_model,
            "messages": req.messages,
            "stream": true,
            "stream_options": { "include_usage": true }
        });
        if let Some(mt) = req.max_tokens {
            body["max_tokens"] = serde_json::json!(mt);
        }
        let mut builder = self.client.post(&url).bearer_auth(api_key).json(&body);
        if ch.provider == "openrouter" {
            builder = builder
                .header("HTTP-Referer", "https://dev.lain42.top")
                .header("X-Title", "Lilyco Relay");
        }
        let resp = builder.send().await.map_err(|_| {
            self.trip_cooldown(&ch.id, 30);
            RelayError::UpstreamFailed(format!("upstream {} stream connect timeout", ch.id))
        })?;
        let status = resp.status();
        if !status.is_success() {
            if status.as_u16() == 429 || status.is_server_error() {
                self.trip_cooldown(&ch.id, 30);
            }
            return Err(RelayError::UpstreamFailed(format!("upstream {} stream HTTP {}", ch.id, status.as_u16())));
        }
        Ok(resp)
    }

    /// Forward validated ChatReq to Google AI Studio (Gemini), OpenRouter, or OpenAI-compatible upstream.
    /// Sanitizes all upstream errors so API keys or internal URLs are NEVER leaked!
    pub async fn call_chat(
        &self,
        model: &ModelConfig,
        req: &ChatReq,
    ) -> Result<UpstreamReply, RelayError> {
        let ch = self
            .catalog
            .find_channel(&model.channel_id)
            .ok_or_else(|| RelayError::ModelNotFound(format!("channel {} disabled", model.channel_id)))?;
        if self.is_cooled(&ch.id) {
            return Err(RelayError::UpstreamFailed(format!("channel {} cooling down", ch.id)));
        }
        let api_key = std::env::var(&ch.api_key_env)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| RelayError::UpstreamFailed(format!("upstream env {} not set", ch.api_key_env)))?;

        self.send_openai_compat(ch, model, req, &api_key).await
    }

    async fn send_openai_compat(
        &self,
        ch: &ChannelConfig,
        model: &ModelConfig,
        req: &ChatReq,
        api_key: &str,
    ) -> Result<UpstreamReply, RelayError> {
        let url = format!("{}/chat/completions", ch.base_url.trim_end_matches('/'));
        let payload = ChatReq {
            model: Self::resolve_upstream_model(ch, model),
            messages: req.messages.clone(),
            stream: false,
            max_tokens: req.max_tokens,
        };
        let mut builder = self
            .client
            .post(&url)
            .bearer_auth(api_key)
            .json(&payload);
        if ch.provider == "openrouter" {
            builder = builder
                .header("HTTP-Referer", "https://dev.lain42.top")
                .header("X-Title", "Lilyco Relay");
        }
        let resp = builder.send().await.map_err(|_| {
            self.trip_cooldown(&ch.id, 30);
            RelayError::UpstreamFailed(format!("upstream {} network timeout", ch.id))
        })?;
        let status = resp.status();
        if status.as_u16() == 429 || status.is_server_error() {
            self.trip_cooldown(&ch.id, 60);
            return Err(RelayError::UpstreamFailed(format!(
                "upstream {} returned HTTP {}",
                ch.id,
                status.as_u16()
            )));
        }
        if !status.is_success() {
            return Err(RelayError::UpstreamFailed(format!(
                "upstream {} rejected request (HTTP {})",
                ch.id,
                status.as_u16()
            )));
        }
        let parsed: OpenAiResp = resp
            .json()
            .await
            .map_err(|_| RelayError::UpstreamFailed("invalid upstream json".into()))?;
        let content = parsed
            .choices
            .and_then(|mut c| c.pop())
            .and_then(|c| c.message.content)
            .unwrap_or_default();
        let usage = parsed.usage.map_or_else(
            || TokenUsage {
                prompt_tokens: req.estimate_prompt_tokens(),
                completion_tokens: (content.len() / 3).max(1) as u64,
            },
            |u| TokenUsage {
                prompt_tokens: u.prompt_tokens.unwrap_or_else(|| req.estimate_prompt_tokens()),
                completion_tokens: u.completion_tokens.unwrap_or(1),
            },
        );
        Ok(UpstreamReply {
            id: parsed.id.unwrap_or_else(|| format!("chatcmpl-l42-{}", now_unix())),
            model: model.id.clone(),
            content,
            usage,
        })
    }

    /// Forward typed OpenAI-compatible endpoints (`/embeddings`, `/images/generations`, `/rerank`, `/responses`).
    pub async fn forward_json_endpoint<T: Serialize>(
        &self,
        model: &ModelConfig,
        path_suffix: &str,
        body: &T,
    ) -> Result<serde_json::Value, RelayError> {
        let ch = self
            .catalog
            .find_channel(&model.channel_id)
            .ok_or_else(|| RelayError::ModelNotFound(format!("channel {} disabled", model.channel_id)))?;
        if self.is_cooled(&ch.id) {
            return Err(RelayError::UpstreamFailed(format!("channel {} cooling down", ch.id)));
        }
        let api_key = std::env::var(&ch.api_key_env)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| RelayError::UpstreamFailed(format!("upstream env {} not set", ch.api_key_env)))?;
        let url = format!("{}/{}", ch.base_url.trim_end_matches('/'), path_suffix.trim_start_matches('/'));
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&api_key)
            .json(body)
            .send()
            .await
            .map_err(|_| {
                self.trip_cooldown(&ch.id, 30);
                RelayError::UpstreamFailed(format!("upstream {} timeout", ch.id))
            })?;
        if !resp.status().is_success() {
            return Err(RelayError::UpstreamFailed(format!("upstream {} HTTP {}", ch.id, resp.status().as_u16())));
        }
        resp.json::<serde_json::Value>()
            .await
            .map_err(|_| RelayError::UpstreamFailed("invalid upstream json".into()))
    }

    /// Forward JSON endpoint (images/embeddings/rerank) using DB live channel pool first,
    /// rewriting `model` to the channel's `upstream_model`, with fallback to static env channel.
    pub async fn forward_json_endpoint_with_pool<T: Serialize>(
        &self,
        model: &ModelConfig,
        path_suffix: &str,
        body: &T,
        pool: &[LiveChannel],
    ) -> Result<serde_json::Value, RelayError> {
        if pool.is_empty() {
            return self.forward_json_endpoint(model, path_suffix, body).await;
        }
        let mut payload = serde_json::to_value(body)
            .map_err(|_| RelayError::UpstreamFailed("serialize payload failed".into()))?;
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("model".into(), serde_json::Value::String(model.upstream_model.clone()));
        }
        let mut last_err = None;
        for ch in pool {
            if self.is_cooled(&ch.id) {
                continue;
            }
            let url = format!("{}/{}", ch.base_url.trim_end_matches('/'), path_suffix.trim_start_matches('/'));
            match self
                .client
                .post(&url)
                .bearer_auth(ch.api_key.expose_secret())
                .json(&payload)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    return resp
                        .json::<serde_json::Value>()
                        .await
                        .map_err(|_| RelayError::UpstreamFailed("invalid upstream json".into()));
                }
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    if code == 429 || code >= 500 {
                        self.trip_cooldown(&ch.id, 60);
                    }
                    last_err = Some(RelayError::UpstreamFailed(format!("upstream {} HTTP {code}", ch.id)));
                }
                Err(_) => {
                    self.trip_cooldown(&ch.id, 30);
                    last_err = Some(RelayError::UpstreamFailed(format!("upstream {} timeout", ch.id)));
                }
            }
        }
        Err(last_err.unwrap_or_else(|| RelayError::UpstreamFailed("no live upstream channel".into())))
    }

    /// Measure upstream channel connectivity latency in milliseconds.
    pub async fn probe_url(&self, base_url: &str) -> Result<u64, RelayError> {
        let start = std::time::Instant::now();
        let url = format!("{}/models", base_url.trim_end_matches('/'));
        let _ = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| RelayError::UpstreamFailed(format!("probe failed: {e}")))?;
        Ok(start.elapsed().as_millis() as u64)
    }
}
