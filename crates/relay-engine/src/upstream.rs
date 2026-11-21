use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use relay_core::{ChannelConfig, ChatReq, ModelConfig, ModelsCatalog, RelayError, TokenUsage};
use reqwest::Client;
use serde::{Deserialize, Serialize};

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

/// Multi-upstream router with circuit-breaker cooldown (3 fields, <= 4).
pub struct UpstreamRouter {
    client: Client,
    catalog: ModelsCatalog,
    cooldowns: Mutex<HashMap<String, u64>>,
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
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| RelayError::Config(format!("http client init: {e}")))?;
        Ok(Self {
            client,
            catalog,
            cooldowns: Mutex::new(HashMap::new()),
        })
    }

    pub fn catalog(&self) -> &ModelsCatalog {
        &self.catalog
    }

    fn is_cooled(&self, channel_id: &str) -> bool {
        let now = now_unix();
        self.cooldowns
            .lock()
            .ok()
            .and_then(|m| m.get(channel_id).copied())
            .is_some_and(|until| until > now)
    }

    fn trip_cooldown(&self, channel_id: &str, secs: u64) {
        if let Ok(mut m) = self.cooldowns.lock() {
            m.insert(channel_id.to_string(), now_unix() + secs);
        }
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
}
