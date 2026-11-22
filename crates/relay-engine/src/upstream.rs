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

/// Multi-upstream router with lock-free DashMap circuit-breaker cooldown (3 fields, <= 4).
pub struct UpstreamRouter {
    client: Client,
    catalog: ModelsCatalog,
    cooldowns: DashMap<String, u64>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl UpstreamRouter {
    pub fn new(catalog: ModelsCatalog) -> Result<Self, RelayError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| RelayError::Config(format!("http client init: {e}")))?;
        Ok(Self {
            client,
            catalog,
            cooldowns: DashMap::new(),
        })
    }

    pub fn catalog(&self) -> &ModelsCatalog {
        &self.catalog
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
        let mut body = serde_json::json!({
            "model": model.upstream_model,
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
            model: model.upstream_model.clone(),
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
