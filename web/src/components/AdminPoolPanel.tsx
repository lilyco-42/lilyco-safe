import { useState } from "react";
import { Plus, Server, ShieldAlert, Trash2 } from "lucide-react";
import { deleteChannel, listChannels, toggleBlockIp, upsertChannel, type ChannelItem } from "../api";

interface Props {
  onRefresh: () => void;
}

export function AdminPoolPanel({ onRefresh }: Props) {
  const [adminKey, setAdminKey] = useState(localStorage.getItem("relay_adm") || "");
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [chId, setChId] = useState("deepseek-pool-1");
  const [provider, setProvider] = useState("openai_compat");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [modelsCsv, setModelsCsv] = useState("deepseek-v3,*");
  const [targetIp, setTargetIp] = useState("");
  const [notice, setNotice] = useState("");

  async function onLoadChannels(): Promise<void> {
    localStorage.setItem("relay_adm", adminKey);
    try {
      setChannels(await listChannels(adminKey));
      setNotice("已刷新上游 API Key 池子");
    } catch (e) {
      setNotice(`读取失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onAddChannel(): Promise<void> {
    localStorage.setItem("relay_adm", adminKey);
    try {
      await upsertChannel(adminKey, {
        id: chId.trim(),
        provider,
        endpoint: { name: chId.trim(), base_url: baseUrl.trim(), api_key: apiKey.trim() },
        routing: {
          models: modelsCsv.split(",").map((s) => s.trim()).filter(Boolean),
          priority: 10,
          weight: 100,
          enabled: true,
        },
      });
      setApiKey("");
      setNotice(`上游渠道 ${chId} 已热加载生效（无需重启）！`);
      await onLoadChannels();
    } catch (e) {
      setNotice(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onIpAction(action: "block" | "unblock"): Promise<void> {
    localStorage.setItem("relay_adm", adminKey);
    try {
      await toggleBlockIp(adminKey, targetIp, action);
      setNotice(action === "block" ? `已封禁 IP: ${targetIp}` : `已解封 IP: ${targetIp}`);
      onRefresh();
    } catch (e) {
      setNotice(`风控失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <section className="grid">
      <div className="card">
        <h3 style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 6 }}>
          <Server size={17} /> 上游 API Key 池子（热加载 · 故障自动切换）
        </h3>
        <label>管理员密钥 (X-Admin-Key)<input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} /></label>
        <label style={{ display: "block", marginTop: 8 }}>渠道 ID<input value={chId} onChange={(e) => setChId(e.target.value)} /></label>
        <label style={{ display: "block", marginTop: 8 }}>
          供应商协议
          <select value={provider} onChange={(e) => {
            const v = e.target.value;
            setProvider(v);
            if (v === "gemini_openai") setBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai");
            if (v === "openrouter") setBaseUrl("https://openrouter.ai/api/v1");
            if (v === "openai_compat") setBaseUrl("https://api.deepseek.com/v1");
          }}>
            <option value="openai_compat">DeepSeek / OpenAI 兼容</option>
            <option value="gemini_openai">Google AI Studio (Gemini)</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </label>
        <label style={{ display: "block", marginTop: 8 }}>上游 Base URL<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        <label style={{ display: "block", marginTop: 8 }}>上游 API Key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-... / AIza..." /></label>
        <label style={{ display: "block", marginTop: 8 }}>覆盖模型（逗号分隔，* 为通配）<input value={modelsCsv} onChange={(e) => setModelsCsv(e.target.value)} /></label>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={onAddChannel}><Plus size={14} /> 加入 Key 池</button>
          <button className="btn" onClick={onLoadChannels}>刷新池子</button>
        </div>
        {channels.map((c) => (
          <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--border)", fontSize: 13 }}>
            <span><strong>{c.id}</strong> ({c.provider})</span>
            <button className="btn" style={{ minHeight: 28, padding: "0 8px" }} onClick={async () => { await deleteChannel(adminKey, c.id); await onLoadChannels(); }}>
              <Trash2 size={13} /> 删除
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 10px", display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldAlert size={17} /> 实时 IP 风控（tower_governor + 黑名单）
        </h3>
        <label>目标 IP 地址<input value={targetIp} onChange={(e) => setTargetIp(e.target.value)} placeholder="203.0.113.99" /></label>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => onIpAction("block")}>立即封禁 IP</button>
          <button className="btn" onClick={() => onIpAction("unblock")}>解除封禁</button>
        </div>
      </div>

      {notice && <div className="card" style={{ gridColumn: "1 / -1" }}><pre style={{ margin: 0, minHeight: 0 }}>{notice}</pre></div>}
    </section>
  );
}
