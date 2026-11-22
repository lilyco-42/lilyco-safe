use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use relay_core::config::{RiskSection, SecuritySection};
use relay_core::{ClientIp, RelayError};
use serde::Serialize;

/// Immutable domain risk policy (<= 4 fields; HTTP RPM rate limiting is delegated to `tower_governor`).
#[derive(Debug, Clone)]
pub struct RiskPolicy {
    pub max_auth_fail_per_ip: u32,
    pub lockout_secs: u64,
    pub max_credits_per_req: u64,
}

impl From<&RiskSection> for RiskPolicy {
    fn from(r: &RiskSection) -> Self {
        Self {
            max_auth_fail_per_ip: r.max_auth_fail_per_ip.max(1),
            lockout_secs: r.lockout_secs.max(10),
            max_credits_per_req: r.max_credits_per_req.max(1),
        }
    }
}

/// Risk engine telemetry snapshot (4 fields, Rule of 4).
#[derive(Debug, Clone, Serialize)]
pub struct RiskStats {
    pub blocked_ips: usize,
    pub locked_ips: usize,
    pub frozen_keys: usize,
    pub rate_limiter: &'static str,
}

#[derive(Default)]
struct IpTables {
    static_blocked: HashSet<String>,
    auth_fails: HashMap<String, VecDeque<u64>>,
    locked_until: HashMap<String, u64>,
}

#[derive(Default)]
struct KeyGuard {
    spend_window: HashMap<String, VecDeque<(u64, u64)>>,
    frozen_until: HashMap<String, u64>,
}

/// Domain Risk Control Engine (HTTP RPM handled by `tower_governor`; this handles anti-spoof,
/// IP blocklist, brute-force lockout, per-key IP whitelist, and rapid token-drain circuit breaker).
pub struct RiskEngine {
    policy: RiskPolicy,
    trusted_proxies: HashSet<String>,
    ip_tables: Mutex<IpTables>,
    key_guard: Mutex<KeyGuard>,
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn prune_older(q: &mut VecDeque<u64>, cutoff: u64) {
    while q.front().is_some_and(|&t| t < cutoff) {
        q.pop_front();
    }
}

impl RiskEngine {
    pub fn new(risk: &RiskSection, sec: &SecuritySection) -> Self {
        let mut tables = IpTables::default();
        for ip in &sec.blocked_ips {
            tables.static_blocked.insert(ip.trim().to_string());
        }
        let trusted_proxies = sec
            .trusted_proxies
            .iter()
            .map(|s| s.trim().to_string())
            .collect();
        Self {
            policy: RiskPolicy::from(risk),
            trusted_proxies,
            ip_tables: Mutex::new(tables),
            key_guard: Mutex::new(KeyGuard::default()),
        }
    }

    /// Zero-trust client IP extraction: ONLY trust X-Forwarded-For when peer is a configured trusted proxy.
    pub fn resolve_ip(&self, peer_ip: &str, forwarded_for: Option<&str>) -> Result<ClientIp, RelayError> {
        let peer = peer_ip.trim();
        if self.trusted_proxies.contains(peer)
            && let Some(xff) = forwarded_for
            && let Some(first) = xff.split(',').next()
            && let Ok(ip) = ClientIp::parse(first)
        {
            return Ok(ip);
        }
        ClientIp::parse(peer)
    }

    /// Check IP blocklist & brute-force lockout (RPM is enforced by `tower_governor` middleware).
    pub fn check_ip(&self, ip: &ClientIp) -> Result<(), RelayError> {
        let now = now_unix();
        let guard = self
            .ip_tables
            .lock()
            .map_err(|_| RelayError::Storage("risk ip lock poisoned".into()))?;
        let key = ip.as_str();
        if guard.static_blocked.contains(key) {
            return Err(RelayError::IpBlocked(format!("ip {key} is in blocklist")));
        }
        if guard.locked_until.get(key).is_some_and(|&until| until > now) {
            return Err(RelayError::IpBlocked(format!("ip {key} is temporarily locked")));
        }
        Ok(())
    }

    /// Enforce optional per-key IP whitelist (comma-separated IPs).
    pub fn check_key_ip_whitelist(&self, ip: &ClientIp, allowed_ips: &str) -> Result<(), RelayError> {
        let trimmed = allowed_ips.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let matched = trimmed.split(',').any(|a| a.trim() == ip.as_str());
        if !matched {
            return Err(RelayError::IpBlocked(format!("ip {} not in key whitelist", ip.as_str())));
        }
        Ok(())
    }

    /// Record failed auth/registration attempt; auto-lock IP on brute-force or mass-reg abuse.
    pub fn record_auth_failure(&self, ip: &ClientIp) -> bool {
        let now = now_unix();
        let Ok(mut guard) = self.ip_tables.lock() else {
            return false;
        };
        let key = ip.as_str().to_string();
        let fails = guard.auth_fails.entry(key.clone()).or_default();
        prune_older(fails, now.saturating_sub(300));
        fails.push_back(now);
        if fails.len() >= self.policy.max_auth_fail_per_ip as usize {
            guard.locked_until.insert(key, now + self.policy.lockout_secs);
            return true;
        }
        false
    }

    /// Rapid token-drain circuit breaker per API key.
    pub fn check_key_spend(&self, key_id: &str, est_credits: u64) -> Result<(), RelayError> {
        if est_credits > self.policy.max_credits_per_req {
            return Err(RelayError::DrainGuard(format!(
                "single request {est_credits} exceeds max {}",
                self.policy.max_credits_per_req
            )));
        }
        let now = now_unix();
        let mut guard = self
            .key_guard
            .lock()
            .map_err(|_| RelayError::Storage("risk key lock poisoned".into()))?;
        if guard.frozen_until.get(key_id).is_some_and(|&u| u > now) {
            return Err(RelayError::DrainGuard(format!("key {key_id} frozen by anomaly guard")));
        }
        let win = guard.spend_window.entry(key_id.to_string()).or_default();
        let cutoff = now.saturating_sub(60);
        while win.front().is_some_and(|&(t, _)| t < cutoff) {
            win.pop_front();
        }
        let sum: u64 = win.iter().map(|&(_, c)| c).sum();
        let minute_cap = self.policy.max_credits_per_req.saturating_mul(5);
        if sum.saturating_add(est_credits) > minute_cap {
            guard
                .frozen_until
                .insert(key_id.to_string(), now + self.policy.lockout_secs);
            return Err(RelayError::DrainGuard(format!(
                "key {key_id} exceeded 1-min drain cap {minute_cap}"
            )));
        }
        win.push_back((now, est_credits));
        Ok(())
    }

    pub fn block_ip(&self, ip: &ClientIp) {
        if let Ok(mut guard) = self.ip_tables.lock() {
            guard.static_blocked.insert(ip.as_str().to_string());
        }
    }

    pub fn unblock_ip(&self, ip: &ClientIp) {
        if let Ok(mut guard) = self.ip_tables.lock() {
            guard.static_blocked.remove(ip.as_str());
            guard.locked_until.remove(ip.as_str());
        }
    }

    pub fn stats(&self) -> RiskStats {
        let now = now_unix();
        let (blocked_ips, locked_ips) = self
            .ip_tables
            .lock()
            .map(|g| {
                let locked = g.locked_until.values().filter(|&&u| u > now).count();
                (g.static_blocked.len(), locked)
            })
            .unwrap_or((0, 0));
        let frozen_keys = self
            .key_guard
            .lock()
            .map(|g| g.frozen_until.values().filter(|&&u| u > now).count())
            .unwrap_or(0);
        RiskStats {
            blocked_ips,
            locked_ips,
            frozen_keys,
            rate_limiter: "tower_governor(gcra)",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_engine() -> RiskEngine {
        let risk = RiskSection {
            max_rpm_per_ip: 60,
            max_auth_fail_per_ip: 2,
            lockout_secs: 600,
            max_credits_per_req: 100,
        };
        let sec = SecuritySection {
            trusted_proxies: vec!["127.0.0.1".into()],
            blocked_ips: vec!["198.51.100.9".into()],
            require_paid_wallet: true,
            affiliate_rate_bps: 1500,
        };
        RiskEngine::new(&risk, &sec)
    }

    #[test]
    fn untrusted_proxy_cannot_spoof_xff() {
        let eng = test_engine();
        let ip = eng.resolve_ip("203.0.113.5", Some("1.2.3.4")).unwrap();
        assert_eq!(ip.as_str(), "203.0.113.5");
        let trusted = eng.resolve_ip("127.0.0.1", Some("198.51.100.7, 10.0.0.1")).unwrap();
        assert_eq!(trusted.as_str(), "198.51.100.7");
    }

    #[test]
    fn ip_blocklist_whitelist_and_auth_lockout_enforce_security() {
        let eng = test_engine();
        let bad = ClientIp::parse("198.51.100.9").unwrap();
        assert!(matches!(eng.check_ip(&bad), Err(RelayError::IpBlocked(_))));

        let ok_ip = ClientIp::parse("203.0.113.10").unwrap();
        assert!(eng.check_key_ip_whitelist(&ok_ip, "203.0.113.10,10.0.0.1").is_ok());
        assert!(eng.check_key_ip_whitelist(&ok_ip, "10.0.0.1").is_err());

        let brute = ClientIp::parse("203.0.113.77").unwrap();
        assert!(!eng.record_auth_failure(&brute));
        assert!(eng.record_auth_failure(&brute));
        assert!(matches!(eng.check_ip(&brute), Err(RelayError::IpBlocked(_))));
    }

    #[test]
    fn rapid_token_drain_triggers_circuit_breaker() {
        let eng = test_engine();
        assert!(matches!(eng.check_key_spend("k1", 101), Err(RelayError::DrainGuard(_))));
        for _ in 0..5 {
            assert!(eng.check_key_spend("k2", 100).is_ok());
        }
        assert!(matches!(eng.check_key_spend("k2", 1), Err(RelayError::DrainGuard(_))));
    }
}
