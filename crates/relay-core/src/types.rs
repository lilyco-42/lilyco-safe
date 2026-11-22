use serde::{Deserialize, Serialize};

use crate::error::RelayError;

/// Validated client IP newtype (zero-trust boundary).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClientIp(String);

impl ClientIp {
    pub fn parse(raw: &str) -> Result<Self, RelayError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.len() > 64 {
            return Err(RelayError::InvalidInput("invalid client ip length".into()));
        }
        let ok = trimmed
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':');
        if !ok {
            return Err(RelayError::InvalidInput("invalid client ip chars".into()));
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Strictly typed chat message (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Strictly typed OpenAI `/v1/chat/completions` request (4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatReq {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

impl ChatReq {
    pub fn validate(&self) -> Result<(), RelayError> {
        if self.model.trim().is_empty() || self.model.len() > 128 {
            return Err(RelayError::InvalidInput("model id must be 1..128 chars".into()));
        }
        if self.messages.is_empty() || self.messages.len() > 256 {
            return Err(RelayError::InvalidInput("messages must be 1..256 items".into()));
        }
        for m in &self.messages {
            let valid_role = matches!(m.role.as_str(), "system" | "user" | "assistant" | "tool");
            if !valid_role {
                return Err(RelayError::InvalidInput(format!("unsupported role: {}", m.role)));
            }
        }
        Ok(())
    }

    pub fn estimate_prompt_tokens(&self) -> u64 {
        let chars: usize = self.messages.iter().map(|m| m.content.len()).sum();
        ((chars / 3).max(8)) as u64
    }
}

/// Strictly typed Anthropic `/v1/messages` request for Claude Code (4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnthropicMsgReq {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    #[serde(default)]
    pub stream: bool,
}

impl AnthropicMsgReq {
    pub fn to_chat_req(&self) -> Result<ChatReq, RelayError> {
        let req = ChatReq {
            model: self.model.clone(),
            messages: self.messages.clone(),
            stream: self.stream,
            max_tokens: Some(self.max_tokens.clamp(1, 32768)),
        };
        req.validate()?;
        Ok(req)
    }
}

/// Sub-key issuance request (<= 4 top-level fields, deny_unknown_fields).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyIssueReq {
    pub name: String,
    pub quota_limit: u64,
    pub rpm_limit: u32,
    #[serde(default)]
    pub scope: KeyScope,
}

/// Optional key restrictions (<= 4 fields, Rule of 4).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyScope {
    #[serde(default)]
    pub allowed_models: Vec<String>,
    #[serde(default)]
    pub allowed_ips: String,
    #[serde(default)]
    pub expired_unix: i64,
    #[serde(default)]
    pub group_name: String,
}

/// Strictly typed OpenAI `/v1/embeddings` request (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddingReq {
    pub model: String,
    pub input: Vec<String>,
    #[serde(default)]
    pub encoding_format: Option<String>,
}

/// Strictly typed OpenAI `/v1/images/generations` request (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageGenReq {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub n: Option<u8>,
}

/// Strictly typed `/v1/rerank` request (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RerankReq {
    pub model: String,
    pub query: String,
    pub documents: Vec<String>,
    #[serde(default)]
    pub top_n: Option<u32>,
}

/// Admin dynamic channel upsert payload (<= 4 composed fields, deny_unknown_fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelUpsertReq {
    pub id: String,
    pub provider: String,
    pub endpoint: ChannelEndpoint,
    pub routing: ChannelRouting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelEndpoint {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelRouting {
    pub models: Vec<String>,
    pub priority: i32,
    pub weight: u32,
    pub enabled: bool,
}

/// Admin batch redemption code creation (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedemptionCreateReq {
    pub count: u32,
    pub credits: u64,
    pub wallet_type: String, // "paid" | "bonus"
    pub prefix: String,
}

/// User redeem code request (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedeemCodeReq {
    pub code: String,
}

impl KeyIssueReq {
    pub fn validate(&self) -> Result<(), RelayError> {
        let n = self.name.trim();
        if n.is_empty() || n.len() > 48 {
            return Err(RelayError::InvalidInput("key name must be 1..48 chars".into()));
        }
        if self.rpm_limit == 0 || self.rpm_limit > 6000 {
            return Err(RelayError::InvalidInput("rpm_limit must be 1..6000".into()));
        }
        Ok(())
    }
}

/// Token usage for exact billing settlement (<= 4 fields).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// Model pricing rate in credits per 1M tokens (<= 4 fields).
#[derive(Debug, Clone, Copy)]
pub struct PricingRate {
    pub input_per_m: u64,
    pub output_per_m: u64,
    pub allow_free: bool,
}

impl PricingRate {
    /// Deterministic integer ceiling cost calculation (no float drift, zero-cost leak prevention).
    pub fn calculate_credits(&self, usage: TokenUsage) -> u64 {
        if self.allow_free && self.input_per_m == 0 && self.output_per_m == 0 {
            return 0;
        }
        let in_num = usage.prompt_tokens.saturating_mul(self.input_per_m);
        let out_num = usage.completion_tokens.saturating_mul(self.output_per_m);
        let total = in_num.saturating_add(out_num);
        if total == 0 {
            return 0;
        }
        total.div_ceil(1_000_000).max(1)
    }
}

/// RBAC role tier: Guest (unauthenticated), User (standard), Vip (discounted/priority), Admin (full control).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Guest,
    User,
    Vip,
    Admin,
}

impl UserRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Guest => "guest",
            Self::User => "user",
            Self::Vip => "vip",
            Self::Admin => "admin",
        }
    }

    pub fn parse_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "admin" => Self::Admin,
            "vip" => Self::Vip,
            "guest" => Self::Guest,
            _ => Self::User,
        }
    }

    pub fn default_max_keys(self) -> u32 {
        match self {
            Self::Guest => 0,
            Self::User => 5,
            Self::Vip => 20,
            Self::Admin => 100,
        }
    }

    pub fn default_discount_pct(self) -> u32 {
        match self {
            Self::Vip => 15,
            Self::Admin => 50,
            _ => 0,
        }
    }

    pub fn permissions(self) -> &'static [&'static str] {
        match self {
            Self::Guest => &["models:read", "docs:read"],
            Self::User => &["models:read", "keys:own", "chat:standard", "wallet:own", "logs:own"],
            Self::Vip => &[
                "models:read",
                "keys:vip",
                "chat:priority",
                "billing:vip_discount",
                "wallet:own",
                "logs:own",
            ],
            Self::Admin => &[
                "models:read",
                "keys:all",
                "chat:priority",
                "billing:admin",
                "channels:manage",
                "users:rbac",
                "risk:manage",
                "logs:all",
            ],
        }
    }
}

/// Resolved RBAC policy for a user (<= 4 fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRolePolicy {
    pub role: UserRole,
    pub max_keys: u32,
    pub discount_pct: u32,
    pub banned: bool,
}

impl UserRolePolicy {
    /// Apply integer VIP discount (0..=80%), preserving minimum 1 credit on paid models.
    pub fn apply_discount(&self, raw_credits: u64) -> u64 {
        if raw_credits == 0 || self.discount_pct == 0 {
            return raw_credits;
        }
        let pct = u64::from(self.discount_pct.min(80));
        let discounted = raw_credits.saturating_mul(100 - pct).div_ceil(100);
        discounted.max(1)
    }
}

/// Admin RBAC role update request (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdminRoleUpdateReq {
    pub username: String,
    pub role: UserRole,
    #[serde(default)]
    pub discount_pct: Option<u32>,
    #[serde(default)]
    pub banned: Option<bool>,
}

/// Admin user summary row (<= 4 fields).
#[derive(Debug, Clone, Serialize)]
pub struct AdminUserSummary {
    pub username: String,
    pub policy: UserRolePolicy,
    pub paid_credits: i64,
    pub bonus_credits: i64,
}

/// Usage log row for dashboard & audit (<= 4 fields).
#[derive(Debug, Clone, Serialize)]
pub struct UsageLogItem {
    pub model: String,
    pub tokens: u64,
    pub credits: u64,
    pub created_at: i64,
}

/// New-user trial pass card (<= 4 fields; replaces free bonus points).
#[derive(Debug, Clone, Serialize)]
pub struct TrialCardItem {
    pub id: String,
    pub title: String,
    pub spec: String,
    pub expires_unix: i64, // 0 = not activated yet
}

/// Portal login/register proxy payload (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortalAuthReq {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub email: Option<String>,
}

/// Trial card activation payload (<= 4 fields, deny_unknown_fields).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivateTrialReq {
    pub card_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_trust_rejects_unknown_fields_and_bad_roles() {
        let bad_json = r#"{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}],"evil_inject":1}"#;
        assert!(serde_json::from_str::<ChatReq>(bad_json).is_err());

        let bad_role = ChatReq {
            model: "gemini-2.5-flash".into(),
            messages: vec![ChatMessage { role: "admin".into(), content: "hi".into() }],
            stream: false,
            max_tokens: None,
        };
        assert!(bad_role.validate().is_err());
    }

    #[test]
    fn pricing_rounds_up_to_prevent_zero_credit_leak() {
        let rate = PricingRate { input_per_m: 10, output_per_m: 40, allow_free: false };
        let cost = rate.calculate_credits(TokenUsage { prompt_tokens: 100, completion_tokens: 50 });
        assert_eq!(cost, 1);

        let free = PricingRate { input_per_m: 0, output_per_m: 0, allow_free: true };
        assert_eq!(free.calculate_credits(TokenUsage { prompt_tokens: 5000, completion_tokens: 2000 }), 0);
    }

    #[test]
    fn rbac_vip_discount_and_deny_unknown_fields() {
        let vip = UserRolePolicy { role: UserRole::Vip, max_keys: 20, discount_pct: 15, banned: false };
        assert_eq!(vip.apply_discount(100), 85);
        assert_eq!(vip.apply_discount(1), 1);
        assert_eq!(vip.apply_discount(0), 0);

        let bad_rbac = r#"{"username":"alice","role":"vip","hack":true}"#;
        assert!(serde_json::from_str::<AdminRoleUpdateReq>(bad_rbac).is_err());
    }
}
