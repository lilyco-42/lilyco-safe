use serde::Serialize;
use thiserror::Error;

/// Structured API error body (<= 4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub ok: bool,
    pub code: &'static str,
    pub message: String,
    pub detail: String,
}

#[derive(Debug, Error)]
pub enum RelayError {
    #[error("invalid_input: {0}")]
    InvalidInput(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("ip_blocked: {0}")]
    IpBlocked(String),
    #[error("rate_limited: {0}")]
    RateLimited(String),
    #[error("insufficient_paid: {0}")]
    InsufficientPaid(String),
    #[error("drain_guard: {0}")]
    DrainGuard(String),
    #[error("model_not_found: {0}")]
    ModelNotFound(String),
    #[error("upstream_failed: {0}")]
    UpstreamFailed(String),
    #[error("config_error: {0}")]
    Config(String),
    #[error("storage_error: {0}")]
    Storage(String),
}

impl RelayError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "invalid_input",
            Self::Unauthorized(_) => "unauthorized",
            Self::IpBlocked(_) => "ip_blocked",
            Self::RateLimited(_) => "rate_limited",
            Self::InsufficientPaid(_) => "insufficient_paid",
            Self::DrainGuard(_) => "drain_guard",
            Self::ModelNotFound(_) => "model_not_found",
            Self::UpstreamFailed(_) => "upstream_failed",
            Self::Config(_) => "config_error",
            Self::Storage(_) => "storage_error",
        }
    }

    pub fn http_status(&self) -> u16 {
        match self {
            Self::InvalidInput(_) => 400,
            Self::Unauthorized(_) => 401,
            Self::InsufficientPaid(_) => 402,
            Self::IpBlocked(_) | Self::DrainGuard(_) => 403,
            Self::ModelNotFound(_) => 404,
            Self::RateLimited(_) => 429,
            Self::UpstreamFailed(_) => 502,
            Self::Config(_) | Self::Storage(_) => 500,
        }
    }

    pub fn to_body(&self, localized_msg: &str) -> ErrorBody {
        ErrorBody {
            ok: false,
            code: self.code(),
            message: localized_msg.to_string(),
            detail: self.to_string(),
        }
    }
}
