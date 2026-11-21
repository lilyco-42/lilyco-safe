import { ShieldCheck } from "lucide-react";
import type { HealthResp } from "../api";

interface Props {
  health: HealthResp | null;
  error: string | null;
}

export function HeaderBar({ health, error }: Props) {
  return (
    <header className="nav">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ShieldCheck size={20} color="#10b981" />
        <strong>Lilyco Relay</strong>
        <span className="badge badge-ok">MIT · Zero-Trust Rust</span>
      </div>
      <div>
        {error ? (
          <span className="badge badge-danger">网关离线: {error}</span>
        ) : health ? (
          <span className="badge badge-ok">
            风控在线 · 封禁IP:{health.risk.blocked_ips} · 锁定IP:{health.risk.locked_ips} · 熔断Key:{health.risk.frozen_keys}
          </span>
        ) : (
          <span className="badge">连接中...</span>
        )}
      </div>
    </header>
  );
}
