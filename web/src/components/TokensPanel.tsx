import { useState } from "react";
import { Copy, Gift, KeyRound, Plus, Trash2 } from "lucide-react";
import { issueSubKey, redeemCode, revokeSubKey, transferAffiliate, type MeResp } from "../api";

interface Props {
  token: string;
  me: MeResp | null;
  activeKey: string;
  onKeyCreated: (secret: string) => void;
  onRefreshMe: () => void;
  onOpenAuth: () => void;
}

export function TokensPanel({ token, me, activeKey, onKeyCreated, onRefreshMe, onOpenAuth }: Props) {
  const [name, setName] = useState("claude-code");
  const [quota, setQuota] = useState(500);
  const [allowedIps, setAllowedIps] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");

  if (!token || !me) {
    return (
      <section className="card" style={{ textAlign: "center", padding: 32 }}>
        <h3 style={{ margin: "0 0 8px" }}>登录后即可申请 API Key（与 dev.lain42.top 实付余额互通）</h3>
        <p style={{ color: "var(--sub)", fontSize: 14, margin: "0 0 16px" }}>
          支持 OpenAI、Anthropic (Claude Code)、Cursor、Cherry Studio 与 cc-switch 一键导入。
        </p>
        <button className="btn btn-primary" onClick={onOpenAuth}>登录 / 注册统一账户</button>
      </section>
    );
  }

  const baseUrl = `${window.location.origin}/relay`;
  const sampleKey = activeKey || "sk-l42-请先点击上方申请密钥";
  const ccSwitchJson = JSON.stringify(
    { name: "Lilyco Relay", baseUrl: `${baseUrl}/v1`, anthropicBaseUrl: baseUrl, apiKey: sampleKey },
    null,
    2,
  );

  async function onCreate(): Promise<void> {
    try {
      const res = await issueSubKey(token, {
        name: name.trim() || "default",
        quota_limit: Number(quota) || 500,
        rpm_limit: 60,
        scope: { allowed_models: [], allowed_ips: allowedIps.trim(), expired_unix: 0, group_name: "default" },
      });
      onKeyCreated(res.api_key);
      setMsg(`申请成功！已自动填入对话测试台：${res.api_key}`);
      onRefreshMe();
    } catch (e) {
      setMsg(`申请失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onRedeem(): Promise<void> {
    if (!code.trim()) return;
    try {
      const r = await redeemCode(token, code);
      setMsg(`兑换成功！+${r.credits} 积分 (${r.wallet_type})`);
      setCode("");
      onRefreshMe();
    } catch (e) {
      setMsg(`兑换失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onTransfer(): Promise<void> {
    try {
      const amt = await transferAffiliate(token);
      setMsg(`已将 ${amt} 返佣转入实付余额！`);
      onRefreshMe();
    } catch (e) {
      setMsg(`转入失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <section className="grid">
      <div className="card">
        <h3 style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 6 }}>
          <KeyRound size={17} /> 申请 API Key（`sk-l42-...`）
        </h3>
        <label>密钥名称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label style={{ display: "block", marginTop: 8 }}>单 Key 额度上限（积分）<input type="number" value={quota} onChange={(e) => setQuota(Number(e.target.value))} /></label>
        <label style={{ display: "block", marginTop: 8 }}>IP 白名单（可选，逗号分隔）<input value={allowedIps} onChange={(e) => setAllowedIps(e.target.value)} placeholder="留空表示不限制 IP" /></label>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onCreate}><Plus size={15} /> 申请新 API Key</button>
        <div style={{ marginTop: 14, fontSize: 13 }}>
          <div style={{ color: "var(--sub)", marginBottom: 6 }}>已生效子密钥 ({me.keys.length})：</div>
          {me.keys.map((k) => (
            <div key={k.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)" }}>
              <span><code>{k.id}</code> · 已用 {k.used_credits}/{k.quota_limit}</span>
              <button className="btn" style={{ minHeight: 28, padding: "0 8px" }} onClick={async () => { await revokeSubKey(token, k.id); onRefreshMe(); }}>
                <Trash2 size={13} /> 吊销
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 10px" }}>cc-switch / Claude Code / Cursor 一键接入</h3>
        <div style={{ fontSize: 12.5, color: "var(--sub)" }}>OpenAI Base URL: <code>{baseUrl}/v1</code></div>
        <div style={{ fontSize: 12.5, color: "var(--sub)", marginTop: 4 }}>Anthropic (Claude Code) Base URL: <code>{baseUrl}</code></div>
        <pre>{ccSwitchJson}</pre>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => { void navigator.clipboard?.writeText(ccSwitchJson); setMsg("已复制 cc-switch 配置 JSON"); }}>
          <Copy size={14} /> 复制 cc-switch 配置
        </button>

        <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            <Gift size={15} /> 卡密兑换 & 邀请返佣（专属码：<code>{me.referral_code}</code>）
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入兑换码 VIP-..." style={{ marginTop: 0 }} />
            <button className="btn btn-primary" onClick={onRedeem}>兑换</button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: 13 }}>
            <span>可转实付返佣: <strong>{me.wallet.affiliate_credits}</strong> 积分</span>
            <button className="btn" style={{ minHeight: 32 }} onClick={onTransfer}>转入实付余额</button>
          </div>
        </div>
      </div>

      {msg && <div className="card" style={{ gridColumn: "1 / -1" }}><pre style={{ margin: 0, minHeight: 0 }}>{msg}</pre></div>}
    </section>
  );
}
