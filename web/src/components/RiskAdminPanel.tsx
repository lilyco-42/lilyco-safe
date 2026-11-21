import { useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { issueSubKey, toggleBlockIp } from "../api";

interface Props {
  onRefresh: () => void;
}

export function RiskAdminPanel({ onRefresh }: Props) {
  const [portalTok, setPortalTok] = useState("");
  const [keyName, setKeyName] = useState("claude-code");
  const [adminKey, setAdminKey] = useState("");
  const [targetIp, setTargetIp] = useState("");
  const [notice, setNotice] = useState("");

  async function onIssueKey(): Promise<void> {
    try {
      const res = await issueSubKey(portalTok, {
        name: keyName,
        quota_limit: 500,
        rpm_limit: 60,
        allowed_models: [],
      });
      setNotice(`已签发新子密钥（请妥善保存，后端仅存哈希）：${res.api_key}`);
    } catch (e) {
      setNotice(`签发失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onIpAction(action: "block" | "unblock"): Promise<void> {
    try {
      await toggleBlockIp(adminKey, targetIp, action);
      setNotice(action === "block" ? `已封禁 IP: ${targetIp}` : `已解封 IP: ${targetIp}`);
      onRefresh();
    } catch (e) {
      setNotice(`风控操作失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <section className="grid">
      <div className="card">
        <h3 style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 6 }}>
          <KeyRound size={17} /> 签发隔离 Sub-Key
        </h3>
        <label>
          dev.lain42.top 登录令牌
          <input type="password" value={portalTok} onChange={(e) => setPortalTok(e.target.value)} placeholder="wb-token" />
        </label>
        <label style={{ display: "block", marginTop: 8 }}>
          密钥备注名
          <input value={keyName} onChange={(e) => setKeyName(e.target.value)} />
        </label>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onIssueKey}>
          签发 sk-l42 密钥
        </button>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldAlert size={17} /> 实时 IP 风控拦截
        </h3>
        <label>
          管理员密钥 (X-Admin-Key)
          <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
        </label>
        <label style={{ display: "block", marginTop: 8 }}>
          目标 IP 地址
          <input value={targetIp} onChange={(e) => setTargetIp(e.target.value)} placeholder="203.0.113.99" />
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => onIpAction("block")}>立即封禁</button>
          <button className="btn" onClick={() => onIpAction("unblock")}>解除封禁</button>
        </div>
      </div>

      {notice && (
        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <pre style={{ margin: 0, minHeight: 0 }}>{notice}</pre>
        </div>
      )}
    </section>
  );
}
