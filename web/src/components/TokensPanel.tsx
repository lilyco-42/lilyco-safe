import { useState } from "react";
import { Copy, KeyRound, Plus, Terminal, Trash2, Lock } from "lucide-react";
import { issueApiKey, revokeApiKey, type MeResp } from "../api";

interface Props {
  jwt: string;
  me: MeResp | null;
  activeSecret: string;
  onSecretIssued: (secret: string) => void;
  onRefresh: () => void;
  onOpenAuth: () => void;
  onToast: (msg: string) => void;
}

export function TokensPanel({
  jwt,
  me,
  activeSecret,
  onSecretIssued,
  onRefresh,
  onOpenAuth,
  onToast,
}: Props) {
  const [name, setName] = useState("cc-switch-main");
  const [quota, setQuota] = useState("10000");
  const [rpm, setRpm] = useState("60");
  const [allowedIps, setAllowedIps] = useState("");
  const [busy, setBusy] = useState(false);
  const [cfgTab, setCfgTab] = useState<"ccswitch" | "claudecode" | "openai" | "curl">("ccswitch");

  const origin = typeof window !== "undefined" ? window.location.origin : "https://dev.lain42.top";
  const baseV1 = `${origin}/relay/v1`;
  const demoKey = activeSecret || "sk-l42-请先在上方签发您的专属令牌";

  const snippets: Record<typeof cfgTab, string> = {
    ccswitch: JSON.stringify(
      {
        name: "Lilyco AI Studio",
        baseUrl: baseV1,
        apiKey: demoKey,
        models: [
          "free:gemma-4-31b",
          "free:gemini-3.5-flash-lite",
          "deepseek-v4.1-flash",
          "deepseek-v4-pro",
          "gemini-2.5-flash",
          "kimi-k3.1-pro",
        ],
      },
      null,
      2,
    ),
    claudecode: `# Claude Code / Anthropic 兼容接入\nexport ANTHROPIC_BASE_URL="${origin}/relay"\nexport ANTHROPIC_AUTH_TOKEN="${demoKey}"\nexport ANTHROPIC_MODEL="deepseek-v4.1-flash"\nclaude`,
    openai: `# OpenAI SDK / Cursor / Cherry Studio / Cline\nBase URL: ${baseV1}\nAPI Key:  ${demoKey}\n推荐模型: deepseek-v4.1-flash / gemini-2.5-flash / kimi-k3.1-pro`,
    curl: `curl -X POST "${baseV1}/chat/completions" \\\n  -H "Authorization: Bearer ${demoKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Hello!"}]}'`,
  };

  const handleCreate = async () => {
    if (!jwt) {
      onOpenAuth();
      return;
    }
    setBusy(true);
    try {
      const res = await issueApiKey(jwt, {
        name: name.trim() || "default-key",
        quota_limit: Math.max(0, Number(quota) || 0),
        rpm_limit: Math.max(1, Number(rpm) || 60),
        allowed_ips: allowedIps.trim(),
      });
      onSecretIssued(res.api_key);
      navigator.clipboard?.writeText(res.api_key);
      onToast("已签发新 API Key 并复制到剪贴板！");
      onRefresh();
    } catch (e) {
      onToast(`签发失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    if (!jwt) return;
    setBusy(true);
    try {
      await revokeApiKey(jwt, keyId);
      onToast(`已吊销令牌 ${keyId}`);
      onRefresh();
    } catch (e) {
      onToast(`吊销失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const authed = Boolean(me?.authenticated);
  const keys = me?.keys || [];
  const maxKeys = me?.policy?.max_keys ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Create Token Card */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <KeyRound size={17} color="var(--primary)" /> 令牌管理（API Keys · {keys.length} / {maxKeys}）
          </h3>
          {!authed && (
            <button className="btn btn-primary btn-sm" onClick={onOpenAuth}>
              <Lock size={13} /> 登录后签发令牌
            </button>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <input className="input" placeholder="令牌名称" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder="额度上限 (0=不限)" value={quota} onChange={(e) => setQuota(e.target.value)} />
          <input className="input" placeholder="RPM 限速" value={rpm} onChange={(e) => setRpm(e.target.value)} />
          <input
            className="input"
            placeholder="IP 白名单 (逗号分隔，可选)"
            value={allowedIps}
            onChange={(e) => setAllowedIps(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy || !authed} onClick={handleCreate}>
            <Plus size={15} /> 创建新令牌
          </button>
        </div>

        {activeSecret && (
          <div
            style={{
              background: "var(--success-soft)",
              border: "1px solid var(--success)",
              borderRadius: 9,
              padding: "10px 14px",
              marginBottom: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--success)" }}>
                新令牌已签发（仅展示一次，已自动填充至演练场与下方接入配置）
              </div>
              <div className="mono" style={{ fontWeight: 700, marginTop: 2 }}>{activeSecret}</div>
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                navigator.clipboard?.writeText(activeSecret);
                onToast("已复制 API Key！");
              }}
            >
              <Copy size={13} /> 复制密钥
            </button>
          </div>
        )}

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Key ID</th>
                <th>所属账号</th>
                <th>已消耗 / 额度上限</th>
                <th>状态</th>
                <th style={{ textAlign: "right" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const pct = k.quota_limit > 0 ? Math.min(100, Math.round((k.used_credits / k.quota_limit) * 100)) : 0;
                return (
                  <tr key={k.id}>
                    <td className="mono" style={{ fontWeight: 600 }}>{k.id}</td>
                    <td>{k.username}</td>
                    <td style={{ minWidth: 180 }}>
                      <div style={{ fontSize: 12.5, marginBottom: 4 }}>
                        <b>{k.used_credits}</b> / {k.quota_limit === 0 ? "无上限" : k.quota_limit}
                      </div>
                      {k.quota_limit > 0 && (
                        <div style={{ height: 5, background: "var(--border)", borderRadius: 99, overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: "var(--primary)" }} />
                        </div>
                      )}
                    </td>
                    <td><span className="pill pill-ok">正常启用</span></td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => handleRevoke(k.id)}
                      >
                        <Trash2 size={13} /> 吊销
                      </button>
                    </td>
                  </tr>
                );
              })}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                    {authed ? "暂无 API Key，点击上方「创建新令牌」秒级签发" : "请先登录以查看或签发 API Key"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* One-Click Client Config Card */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Terminal size={17} color="var(--primary)" /> 一键客户端接入（cc-switch / Claude Code / Cursor / OpenAI SDK）
          </h3>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              navigator.clipboard?.writeText(snippets[cfgTab]);
              onToast("已复制配置代码！");
            }}
          >
            <Copy size={13} /> 复制配置
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {(
            [
              ["ccswitch", "cc-switch JSON"],
              ["claudecode", "Claude Code"],
              ["openai", "Cursor / Cherry Studio"],
              ["curl", "cURL 测试"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`btn btn-sm ${cfgTab === id ? "btn-primary" : ""}`}
              onClick={() => setCfgTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="code-box">{snippets[cfgTab]}</div>
      </div>
    </div>
  );
}
