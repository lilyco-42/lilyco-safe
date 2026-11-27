use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::RelayError;

/// Top-level gateway config (4 sections, strictly <= 4 fields).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayConfig {
    pub server: ServerSection,
    pub storage: StorageSection,
    pub risk: RiskSection,
    pub security: SecuritySection,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerSection {
    pub bind: String,
    pub public_url: String,
    pub portal_verify_url: String,
    pub admin_key_env: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageSection {
    pub db_path: String,
    pub i18n_dir: String,
    pub models_file: String,
    pub default_lang: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RiskSection {
    pub max_rpm_per_ip: u32,
    pub max_auth_fail_per_ip: u32,
    pub lockout_secs: u64,
    pub max_credits_per_req: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecuritySection {
    pub trusted_proxies: Vec<String>,
    pub blocked_ips: Vec<String>,
    pub require_paid_wallet: bool,
    pub affiliate_rate_bps: u32,
}

impl GatewayConfig {
    pub fn load(path: &Path) -> Result<Self, RelayError> {
        let raw = fs::read_to_string(path)
            .map_err(|e| RelayError::Config(format!("read {}: {e}", path.display())))?;
        toml::from_str(&raw)
            .map_err(|e| RelayError::Config(format!("parse {}: {e}", path.display())))
    }
}

/// Models & channels TOML catalog (2 fields, <= 4).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelsCatalog {
    pub channels: Vec<ChannelConfig>,
    pub models: Vec<ModelConfig>,
}

/// Upstream channel split into 2 compact structs to honor Rule of 4.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelConfig {
    pub id: String,
    pub provider: String,
    pub base_url: String,
    pub api_key_env: String,
    #[serde(default = "default_weight")]
    pub weight: u32,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_weight() -> u32 {
    100
}
fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingMode {
    #[default]
    Token,
    PerCall,
    PerSecond,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelConfig {
    pub id: String,
    pub channel_id: String,
    pub upstream_model: String,
    pub input_per_m: u64,
    pub output_per_m: u64,
    #[serde(default)]
    pub allow_free: bool,
    #[serde(default)]
    pub billing_mode: BillingMode,
    #[serde(default)]
    pub unit_credits: u64,
}

impl ModelConfig {
    /// Compute fixed/unit credits for non-token endpoints (`per_call` / `per_second`).
    pub fn compute_fixed_cost(&self, units: u64) -> u64 {
        if self.allow_free {
            return 0;
        }
        match self.billing_mode {
            BillingMode::PerCall => self.unit_credits.max(1),
            BillingMode::PerSecond => self.unit_credits.saturating_mul(units.max(1)).max(1),
            BillingMode::Token => self.unit_credits.max(1),
        }
    }
}

impl ModelsCatalog {
    pub fn load(path: &Path) -> Result<Self, RelayError> {
        let raw = fs::read_to_string(path)
            .map_err(|e| RelayError::Config(format!("read {}: {e}", path.display())))?;
        toml::from_str(&raw)
            .map_err(|e| RelayError::Config(format!("parse {}: {e}", path.display())))
    }

    pub fn find_model(&self, id: &str) -> Option<&ModelConfig> {
        self.models.iter().find(|m| m.id == id)
    }

    pub fn find_channel(&self, id: &str) -> Option<&ChannelConfig> {
        self.channels.iter().find(|c| c.id == id && c.enabled)
    }
}

#[derive(Debug, Clone, Deserialize)]
struct LangToml {
    messages: HashMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct I18nBundle {
    langs: HashMap<String, HashMap<String, String>>,
    default_lang: String,
}

impl I18nBundle {
    pub fn load(dir: &Path, default_lang: &str) -> Result<Self, RelayError> {
        let mut langs = HashMap::new();
        for code in ["zh", "en"] {
            let file = dir.join(format!("{code}.toml"));
            if let Ok(raw) = fs::read_to_string(&file) {
                let parsed: LangToml = toml::from_str(&raw)
                    .map_err(|e| RelayError::Config(format!("i18n {}: {e}", file.display())))?;
                langs.insert(code.to_string(), parsed.messages);
            }
        }
        Ok(Self {
            langs,
            default_lang: default_lang.to_string(),
        })
    }

    pub fn get(&self, lang: &str, key: &str) -> String {
        if let Some(m) = self.langs.get(lang).and_then(|t| t.get(key)) {
            return m.clone();
        }
        if let Some(m) = self.langs.get(&self.default_lang).and_then(|t| t.get(key)) {
            return m.clone();
        }
        key.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_model(mode: BillingMode, unit_credits: u64, allow_free: bool) -> ModelConfig {
        ModelConfig {
            id: "test-model".into(),
            channel_id: "ch".into(),
            upstream_model: "test".into(),
            input_per_m: 10,
            output_per_m: 20,
            allow_free,
            billing_mode: mode,
            unit_credits,
        }
    }

    #[test]
    fn fixed_cost_respects_billing_modes() {
        assert_eq!(sample_model(BillingMode::PerSecond, 20, false).compute_fixed_cost(4), 80);
        assert_eq!(sample_model(BillingMode::PerSecond, 20, false).compute_fixed_cost(8), 160);
        assert_eq!(sample_model(BillingMode::PerCall, 15, false).compute_fixed_cost(1), 15);
        assert_eq!(sample_model(BillingMode::PerCall, 15, true).compute_fixed_cost(1), 0);
        assert_eq!(sample_model(BillingMode::Token, 0, false).compute_fixed_cost(1), 1);
    }

    #[test]
    fn models_toml_catalog_loads_billing_modes() {
        let catalog = ModelsCatalog::load(Path::new("../../config/models.toml"))
            .expect("models.toml should parse");
        let veo = catalog
            .find_model("veo-3.1-fast-generate-001")
            .expect("veo model exists");
        assert_eq!(veo.billing_mode, BillingMode::PerSecond);
        assert_eq!(veo.compute_fixed_cost(4), 80);
        assert_eq!(veo.compute_fixed_cost(8), 160);
        let lyria = catalog.find_model("lyria-002").expect("lyria model exists");
        assert_eq!(lyria.billing_mode, BillingMode::PerCall);
        assert_eq!(lyria.compute_fixed_cost(1), 15);
    }
}
