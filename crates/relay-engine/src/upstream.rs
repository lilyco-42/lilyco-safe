use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use relay_core::{
    AudioSpeechReq, BillingMode, ChannelConfig, ChannelProbeResult, ChatReq, ImageGenReq,
    MediaProtocol, ModelConfig, ModelPricingOverride, ModelsCatalog, MusicGenReq, RelayError,
    TokenUsage, VideoGenReq,
};
use reqwest::Client;
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};

use crate::gemini_adapter;
use crate::ledger::LiveChannel;
use crate::vertex_auth::VertexAuth;

fn global_vertex_auth() -> &'static VertexAuth {
    static VERTEX: OnceLock<VertexAuth> = OnceLock::new();
    VERTEX.get_or_init(VertexAuth::load_from_env)
}

fn db_vertex_auth(pool: &[LiveChannel]) -> Option<VertexAuth> {
    pool.iter()
        .find(|c| c.provider == "vertex_ai")
        .and_then(|c| VertexAuth::from_json_str(c.api_key.expose_secret()).ok())
}

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

/// Lock-free runtime state maps (4 fields, Rule of 4).
#[derive(Default)]
struct RouterState {
    cooldowns: DashMap<String, u64>,
    dynamic_models: DashMap<String, ModelConfig>,
    pricing_overrides: DashMap<String, ModelPricingOverride>,
    daily_counts: DashMap<String, (u64, u64)>,
}

/// Multi-upstream router with lock-free circuit-breaker, dynamic pricing & channel quotas (3 fields, Rule of 4).
pub struct UpstreamRouter {
    client: Client,
    catalog: ModelsCatalog,
    state: RouterState,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn utc_day() -> u64 {
    now_unix() / 86_400
}

fn apply_channel_mapping(lc: &LiveChannel, model: &ModelConfig) -> ModelConfig {
    if let Some(mapped) = lc.policy.model_mapping.get(&model.id)
        && !mapped.trim().is_empty()
    {
        let mut cloned = model.clone();
        cloned.upstream_model = mapped.trim().to_string();
        return cloned;
    }
    model.clone()
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
            state: RouterState::default(),
        })
    }

    /// Hot-apply a model pricing override in memory (zero restart).
    pub fn set_pricing_override(&self, ov: ModelPricingOverride) {
        self.state.pricing_overrides.insert(ov.model_id.clone(), ov);
    }

    pub fn clear_pricing_override(&self, model_id: &str) {
        self.state.pricing_overrides.remove(model_id);
    }

    pub fn load_pricing_overrides(&self, list: Vec<ModelPricingOverride>) {
        for ov in list {
            self.set_pricing_override(ov);
        }
    }

    fn apply_pricing(&self, mut m: ModelConfig) -> ModelConfig {
        if let Some(ov) = self.state.pricing_overrides.get(&m.id) {
            m.billing_mode = ov.billing_mode;
            m.input_per_m = ov.rates.input_per_m;
            m.output_per_m = ov.rates.output_per_m;
            m.unit_credits = ov.rates.unit_credits;
            m.allow_free = ov.rates.allow_free;
        }
        m
    }

    fn try_consume_channel_quota(&self, lc: &LiveChannel) -> bool {
        if lc.policy.daily_limit == 0 {
            return true;
        }
        let today = utc_day();
        let mut entry = self.state.daily_counts.entry(lc.id.clone()).or_insert((today, 0));
        if entry.0 != today {
            entry.0 = today;
            entry.1 = 0;
        }
        if entry.1 >= lc.policy.daily_limit {
            return false;
        }
        entry.1 += 1;
        true
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

    /// Merged view of static `models.toml` + dynamically synced upstream models + live pricing overrides.
    pub fn all_models(&self) -> Vec<ModelConfig> {
        let mut out: Vec<ModelConfig> = self
            .catalog
            .models
            .iter()
            .cloned()
            .map(|m| self.apply_pricing(m))
            .collect();
        for entry in self.state.dynamic_models.iter() {
            let m = entry.value();
            if !out.iter().any(|existing| existing.id == m.id) {
                out.push(self.apply_pricing(m.clone()));
            }
        }
        out
    }

    /// Look up a model across both static catalog and dynamically synced models with live pricing overrides.
    pub fn find_model(&self, id: &str) -> Option<ModelConfig> {
        if let Some(m) = self.catalog.find_model(id) {
            return Some(self.apply_pricing(m.clone()));
        }
        self.state
            .dynamic_models
            .get(id)
            .map(|v| self.apply_pricing(v.value().clone()))
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
            self.state.dynamic_models.insert(
                model_id.clone(),
                ModelConfig {
                    id: model_id,
                    channel_id: ch.id.clone(),
                    upstream_model: clean.to_string(),
                    input_per_m: if free_flag { 0 } else { 20 },
                    output_per_m: if free_flag { 0 } else { 80 },
                    allow_free: free_flag,
                    billing_mode: BillingMode::Token,
                    unit_credits: 0,
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
        if ch.provider == "vertex_ai" {
            let auth = VertexAuth::from_json_str(key).ok();
            let (ok, detail) = match auth.as_ref() {
                Some(va) => match va.access_token(&self.client).await {
                    Ok(_) => (
                        true,
                        format!("Vertex OAuth2 正常 (project: {})", va.project_id().unwrap_or("default")),
                    ),
                    Err(e) => (false, format!("OAuth2 换取失败: {e}")),
                },
                None => (false, "无效的 Vertex JSON 凭证".to_string()),
            };
            return ChannelProbeResult {
                ok,
                latency_ms: t0.elapsed().as_millis() as u64,
                models_count: if ok { 4 } else { 0 },
                balance_text: detail,
            };
        }
        if ch.provider == "moss_gpu" {
            let health_url = format!("{base}/health");
            let (ok, detail) = match self.client.get(&health_url).send().await {
                Ok(r) if r.status().is_success() => {
                    let v = r.json::<serde_json::Value>().await.unwrap_or_default();
                    let w = v.get("workers_online").and_then(|x| x.as_u64()).unwrap_or(0);
                    (true, format!("MOSS GPU 算力池在线 (workers: {w})"))
                }
                _ => (false, "MOSS Broker 不可达".to_string()),
            };
            return ChannelProbeResult {
                ok,
                latency_ms: t0.elapsed().as_millis() as u64,
                models_count: if ok { 3 } else { 0 },
                balance_text: detail,
            };
        }
        let models_url = format!("{base}/models");
        let req = if ch.provider == "anthropic_native" {
            self.client
                .get(&models_url)
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
        } else {
            self.client.get(&models_url).bearer_auth(key)
        };
        let (ok, models_count) = match req.send().await {
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
        self.state
            .cooldowns
            .get(channel_id)
            .is_some_and(|until| *until > now)
    }

    fn trip_cooldown(&self, channel_id: &str, secs: u64) {
        self.state.cooldowns.insert(channel_id.to_string(), now_unix() + secs);
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
            if self.is_cooled(&lc.id) || !self.try_consume_channel_quota(lc) {
                continue;
            }
            let effective = apply_channel_mapping(lc, model);
            let ch = ChannelConfig {
                id: lc.id.clone(),
                provider: lc.provider.clone(),
                base_url: lc.base_url.clone(),
                api_key_env: String::new(),
                weight: 100,
                enabled: true,
            };
            match self.send_openai_compat(&ch, &effective, req, lc.api_key.expose_secret()).await {
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
            if self.is_cooled(&lc.id) || !self.try_consume_channel_quota(lc) {
                continue;
            }
            let effective = apply_channel_mapping(lc, model);
            let ch = ChannelConfig {
                id: lc.id.clone(),
                provider: lc.provider.clone(),
                base_url: lc.base_url.clone(),
                api_key_env: String::new(),
                weight: 100,
                enabled: true,
            };
            match self.open_openai_stream(&ch, &effective, req, lc.api_key.expose_secret()).await {
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
        let is_gemini_img = path_suffix.trim_start_matches('/') == "images/generations"
            && MediaProtocol::detect(&model.upstream_model).is_gemini_native();
        if is_gemini_img
            && let Ok(img_req) = serde_json::from_value::<ImageGenReq>(payload.clone())
        {
            if model.upstream_model.contains("nano-banana") {
                if let Some(db_va) = db_vertex_auth(pool) {
                    return gemini_adapter::vertex_generate_image(&self.client, &db_va, &model.upstream_model, &img_req).await;
                }
                let vauth = global_vertex_auth();
                if vauth.is_configured() {
                    return gemini_adapter::vertex_generate_image(&self.client, vauth, &model.upstream_model, &img_req).await;
                }
            }
            for ch in pool.iter().filter(|c| gemini_adapter::is_gemini_channel(c)) {
                if self.is_cooled(&ch.id) {
                    continue;
                }
                match gemini_adapter::generate_image(&self.client, ch, &model.upstream_model, &img_req).await {
                    Ok(v) => return Ok(v),
                    Err(e) => {
                        if e.to_string().contains("429") || e.to_string().contains("50") {
                            self.trip_cooldown(&ch.id, 60);
                        }
                        last_err = Some(e);
                    }
                }
            }
            return Err(last_err.unwrap_or_else(|| {
                RelayError::UpstreamFailed("no live gemini channel available for native image".into())
            }));
        }
        for ch in pool {
            if self.is_cooled(&ch.id) || !self.try_consume_channel_quota(ch) {
                continue;
            }
            let effective = apply_channel_mapping(ch, model);
            let mut ch_payload = payload.clone();
            if let Some(obj) = ch_payload.as_object_mut() {
                obj.insert("model".into(), serde_json::Value::String(effective.upstream_model));
            }
            let url = format!("{}/{}", ch.base_url.trim_end_matches('/'), path_suffix.trim_start_matches('/'));
            match self
                .client
                .post(&url)
                .bearer_auth(ch.api_key.expose_secret())
                .json(&ch_payload)
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

    /// Dispatch native Gemini TTS (`/v1/audio/speech`) across live Gemini channel pool.
    pub async fn call_speech_with_pool(
        &self,
        model: &ModelConfig,
        req: &AudioSpeechReq,
        pool: &[LiveChannel],
    ) -> Result<serde_json::Value, RelayError> {
        let mut last_err = None;
        for ch in pool.iter().filter(|c| gemini_adapter::is_gemini_channel(c)) {
            if self.is_cooled(&ch.id) {
                continue;
            }
            match gemini_adapter::generate_speech(&self.client, ch, &model.upstream_model, req).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    self.trip_cooldown(&ch.id, 45);
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| RelayError::UpstreamFailed("no live gemini tts channel".into())))
    }

    /// Dispatch native Lyria music generation (`/v1/music/generations`), preferring Vertex AI when configured.
    pub async fn call_music_with_pool(
        &self,
        model: &ModelConfig,
        req: &MusicGenReq,
        pool: &[LiveChannel],
    ) -> Result<serde_json::Value, RelayError> {
        if let Some(db_va) = db_vertex_auth(pool) {
            return gemini_adapter::vertex_generate_music(&self.client, &db_va, &model.upstream_model, req).await;
        }
        let vauth = global_vertex_auth();
        if vauth.is_configured() {
            return gemini_adapter::vertex_generate_music(&self.client, vauth, &model.upstream_model, req).await;
        }
        let mut last_err = None;
        for ch in pool.iter().filter(|c| gemini_adapter::is_gemini_channel(c)) {
            if self.is_cooled(&ch.id) {
                continue;
            }
            match gemini_adapter::generate_music(&self.client, ch, &model.upstream_model, req).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    self.trip_cooldown(&ch.id, 45);
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| RelayError::UpstreamFailed("no live gemini music channel".into())))
    }

    /// Start async Veo video generation (`/v1/videos/generations`), preferring Vertex AI when configured.
    pub async fn call_video_with_pool(
        &self,
        model: &ModelConfig,
        req: &VideoGenReq,
        pool: &[LiveChannel],
    ) -> Result<serde_json::Value, RelayError> {
        if let Some(db_va) = db_vertex_auth(pool) {
            return gemini_adapter::vertex_start_video(&self.client, &db_va, &model.upstream_model, req).await;
        }
        let vauth = global_vertex_auth();
        if vauth.is_configured() {
            return gemini_adapter::vertex_start_video(&self.client, vauth, &model.upstream_model, req).await;
        }
        let mut last_err = None;
        for ch in pool.iter().filter(|c| gemini_adapter::is_gemini_channel(c)) {
            if self.is_cooled(&ch.id) {
                continue;
            }
            match gemini_adapter::start_video_job(&self.client, ch, &model.upstream_model, req).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    self.trip_cooldown(&ch.id, 45);
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| RelayError::UpstreamFailed("no live gemini video channel".into())))
    }

    /// Poll async Veo operation status (supports both Vertex AI operations and AI Studio operations).
    pub async fn poll_video_with_pool(
        &self,
        operation: &str,
        pool: &[LiveChannel],
    ) -> Result<serde_json::Value, RelayError> {
        if operation.contains("/locations/") {
            if let Some(db_va) = db_vertex_auth(pool) {
                return gemini_adapter::vertex_poll_video(&self.client, &db_va, operation).await;
            }
            let vauth = global_vertex_auth();
            if vauth.is_configured() {
                return gemini_adapter::vertex_poll_video(&self.client, vauth, operation).await;
            }
        }
        let mut last_err = None;
        for ch in pool.iter().filter(|c| gemini_adapter::is_gemini_channel(c)) {
            if self.is_cooled(&ch.id) {
                continue;
            }
            match gemini_adapter::poll_video_job(&self.client, ch, operation).await {
                Ok(v) => return Ok(v),
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| RelayError::UpstreamFailed("no live gemini channel for poll".into())))
    }

    /// Passthrough native Google Gemini REST calls (`/v1beta/models/{model}:{action}`) with pool rotation.
    pub async fn call_gemini_v1beta_with_pool(
        &self,
        model: &ModelConfig,
        action: &str,
        payload: &serde_json::Value,
        pool: &[LiveChannel],
    ) -> Result<serde_json::Value, RelayError> {
        let mut last_err = None;
        for ch in pool.iter().filter(|c| gemini_adapter::is_gemini_channel(c)) {
            if self.is_cooled(&ch.id) || !self.try_consume_channel_quota(ch) {
                continue;
            }
            let effective = apply_channel_mapping(ch, model);
            match gemini_adapter::passthrough_v1beta(&self.client, ch, &effective.upstream_model, action, payload).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    if e.to_string().contains("429") || e.to_string().contains("50") {
                        self.trip_cooldown(&ch.id, 45);
                    }
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| RelayError::UpstreamFailed("no live gemini channel available".into())))
    }

    /// Passthrough raw binary/multipart payload (e.g. Whisper audio/transcriptions, images/edits) across live pool.
    pub async fn forward_raw_bytes_with_pool(
        &self,
        path_suffix: &str,
        content_type: &str,
        raw_body: bytes::Bytes,
        pool: &[LiveChannel],
    ) -> Result<(u16, String, bytes::Bytes), RelayError> {
        let mut last_err = None;
        for ch in pool {
            if self.is_cooled(&ch.id) || !self.try_consume_channel_quota(ch) {
                continue;
            }
            let url = format!("{}/{}", ch.base_url.trim_end_matches('/'), path_suffix.trim_start_matches('/'));
            match self
                .client
                .post(&url)
                .header("content-type", content_type)
                .bearer_auth(ch.api_key.expose_secret())
                .body(raw_body.clone())
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    let code = resp.status().as_u16();
                    let resp_ct = resp
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("application/json")
                        .to_string();
                    let out = resp
                        .bytes()
                        .await
                        .map_err(|_| RelayError::UpstreamFailed("failed reading upstream bytes".into()))?;
                    return Ok((code, resp_ct, out));
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
