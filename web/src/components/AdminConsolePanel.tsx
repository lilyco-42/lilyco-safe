import { useEffect, useState } from "react";
import {
  Activity,
  Ban,
  Copy,
  Crown,
  Gift,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  UserCog,
} from "lucide-react";
import {
  adminCreateRedemptions,
  adminDeleteChannel,
  adminIpAction,
  adminListChannels,
  adminListUsers,
  adminMintResellKeys,
  adminProbeChannel,
  adminSyncModels,
  adminTopupUser,
  adminUpdateUserRole,
  adminUpsertChannel,
  type AdminUserSummary,
  type ChannelItem,
  type ChannelProbeResp,
  type HealthResp,
  type UserRole,
} from "../api";

interface Props {
  section: "channels" | "users" | "risk";
  jwt: string;
  isAdminRole: boolean;
  adminKey: string;
  onAdminKeyChange: (k: string) => void;
  health: HealthResp | null;
  onToast: (msg: string) => void;
}

const PROVIDER_TYPES = [
  { value: "openai_compat", label: "OpenAI 兼容 (openai_compat)" },
  { value: "gemini_openai", label: "Google AI Studio / Gemini (gemini_openai)" },
  { value: "vertex_ai", label: "Google Cloud Vertex AI OAuth2 (vertex_ai)" },
  { value: "anthropic_native", label: "Anthropic 原生 (anthropic_native)" },
  { value: "openrouter", label: "OpenRouter (openrouter)" },
  { value: "moss_gpu", label: "自建 MOSS / AnimeXL GPU (moss_gpu)" },
];

const PROVIDER_PRESETS = [
  { key: "vertex_ai", label: "Google Cloud Vertex AI (Veo / Lyria / Nano Banana · OAuth2 JSON)", provider: "vertex_ai", baseUrl: "https://us-central1-aiplatform.googleapis.com/v1", models: "lyria-002,veo-3.1-fast-generate-001,veo-2.0-generate-001,gemini-nano-banana-2.1" },
  { key: "aistudio", label: "Google AI Studio (Gemini / TTS / Imagen)", provider: "gemini_openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: "gemini-3.8-flash,gemini-2.5-flash,gemini-2.5-pro,gemini-2.5-flash-preview-tts,imagen-3.0-generate-002" },
  { key: "aistudio_free", label: "Google AI Studio 免费池 (14.4K RPD)", provider: "gemini_openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: "free:gemma-4-31b,free:gemma-4-26b,free:gemini-3.5-flash-lite,free:gemini-3.1-flash-lite,free:gemini-2.5-flash-preview-tts" },
  { key: "anthropic", label: "Anthropic 官方原生 (Claude)", provider: "anthropic_native", baseUrl: "https://api.anthropic.com/v1", models: "claude-sonnet-4,claude-sonnet-5.5" },
  { key: "moss_gpu", label: "自建 MOSS / AnimeXL GPU 算力池", provider: "moss_gpu", baseUrl: "http://127.0.0.1:4720", models: "free:moss-image-sft,free:noobai-xl-1.1,free:animagine-xl-4.0" },
  { key: "cloudflare", label: "Cloudflare AI Gateway / Workers AI", provider: "openai_compat", baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai", models: "deepseek-v4.1-flash,gemini-2.5-flash" },
  { key: "aws", label: "AWS Bedrock (OpenAI 兼容)", provider: "openai_compat", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1", models: "claude-sonnet-4,deepseek-v4-pro" },
  { key: "openrouter", label: "OpenRouter (支持查余额 + 免费池)", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", models: "claude-sonnet-5.5,gpt-6.2-astra,free:qwen3-8b" },
  { key: "groq", label: "Groq 免费高速推理", provider: "openai_compat", baseUrl: "https://api.groq.com/openai/v1", models: "free:groq-llama-3.3-70b" },
  { key: "cerebras", label: "Cerebras 免费极速推理", provider: "openai_compat", baseUrl: "https://api.cerebras.ai/v1", models: "free:cerebras-llama-3.3-70b" },
  { key: "nvidia_nim", label: "NVIDIA NIM 免费推理", provider: "openai_compat", baseUrl: "https://integrate.api.nvidia.com/v1", models: "free:nim-llama-3.3-70b,free:nim-deepseek-r1" },
  { key: "siliconflow", label: "SiliconFlow 硅基流动 (免费生图 FLUX + 查余额)", provider: "openai_compat", baseUrl: "https://api.siliconflow.cn/v1", models: "free:sf-qwen2.5-7b,free:flux-1-schnell" },
  { key: "github_models", label: "GitHub Models 免费推理", provider: "openai_compat", baseUrl: "https://models.inference.ai.azure.com", models: "free:github-gpt-4o-mini,free:github-deepseek-r1" },
  { key: "openai", label: "OpenAI 官方 (Chat + Responses)", provider: "openai_compat", baseUrl: "https://api.openai.com/v1", models: "gpt-4o,gpt-4.1-mini" },
  { key: "deepseek", label: "DeepSeek 官方 (支持查余额)", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", models: "deepseek-v3,deepseek-v4.1-flash" },
  { key: "xai", label: "xAI (Grok)", provider: "openai_compat", baseUrl: "https://api.x.ai/v1", models: "grok-3" },
  { key: "custom", label: "自定义 OpenAI 兼容中转站", provider: "openai_compat", baseUrl: "https://your-upstream.example.com/v1", models: "*" },
];

export function AdminConsolePanel({
  section,
  jwt,
  isAdminRole,
  adminKey,
  onAdminKeyChange,
  health,
  onToast,
}: Props) {
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [probeMap, setProbeMap] = useState<Record<string, ChannelProbeResp>>({});
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [busy, setBusy] = useState(false);

  // Channel form with unified provider protocol selector (OpenAI / Gemini / Vertex / Anthropic / MOSS)
  const [presetKey, setPresetKey] = useState("vertex_ai");
  const [chId, setChId] = useState("vertex-ai-pool-1");
  const [chName, setChName] = useState(PROVIDER_PRESETS[0].label);
  const [chProvider, setChProvider] = useState(PROVIDER_PRESETS[0].provider);
  const [chBaseUrl, setChBaseUrl] = useState(PROVIDER_PRESETS[0].baseUrl);
  const [chKey, setChKey] = useState("");
  const [chModels, setChModels] = useState(PROVIDER_PRESETS[0].models);
  const [chPriority, setChPriority] = useState("90");
  const [chEnabled, setChEnabled] = useState(true);

  // Resell API Key Batch Minting
  const [resellCount, setResellCount] = useState("5");
  const [resellQuota, setResellQuota] = useState("1000");
  const [resellBatch, setResellBatch] = useState("RESELL-100CNY");
  const [resellDays, setResellDays] = useState("30");
  const [resellKeys, setResellKeys] = useState<string[]>([]);

  // Risk & Redemptions
  const [targetIp, setTargetIp] = useState("");
  const [redCount, setRedCount] = useState("3");
  const [redCredits, setRedCredits] = useState("100");
  const [redPrefix, setRedPrefix] = useState("VIP");
  const [mintedCodes, setMintedCodes] = useState<string[]>([]);

  const hasAuth = isAdminRole || adminKey.trim().length > 0;
  const origin = typeof window !== "undefined" ? window.location.origin : "https://dev.lain42.top";

  const applyPreset = (key: string) => {
    setPresetKey(key);
    const p = PROVIDER_PRESETS.find((x) => x.key === key);
    if (!p) return;
    setChId(`${p.key}-pool-1`);
    setChName(p.label);
    setChProvider(p.provider);
    setChBaseUrl(p.baseUrl);
    setChModels(p.models);
  };

  const loadAll = async () => {
    if (!hasAuth) return;
    setBusy(true);
    try {
      if (section === "channels") {
        setChannels(await adminListChannels(jwt, adminKey));
      } else if (section === "users") {
        setUsers(await adminListUsers(jwt, adminKey));
      }
    } catch (e) {
      onToast(`加载失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (hasAuth) loadAll();
  }, [section, isAdminRole, adminKey]);

  const handleSaveChannel = async () => {
    if (!chKey.trim() && chProvider !== "moss_gpu") {
      return onToast(chProvider === "vertex_ai" ? "请粘贴 Vertex AI OAuth2 / Service Account JSON" : "请填写上游 API Key");
    }
    setBusy(true);
    try {
      await adminUpsertChannel(jwt, adminKey, {
        id: chId.trim(),
        provider: chProvider,
        endpoint: {
          name: chName.trim() || chId.trim(),
          base_url: chBaseUrl.trim(),
          api_key: chKey.trim() || "moss-internal",
        },
        routing: {
          models: chModels.split(",").map((s) => s.trim()).filter(Boolean),
          priority: Math.max(1, Math.min(1000, Number(chPriority) || 90)),
          weight: 100,
          enabled: chEnabled,
        },
      });
      setChKey("");
      onToast(`渠道 ${chId} (${chProvider}) 已热更新至统一 Key 池！`);
      loadAll();
    } catch (e) {
      onToast(`保存渠道失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleEditChannel = (c: ChannelItem) => {
    setChId(c.id);
    setChName(c.meta.name || c.id);
    setChProvider(c.provider);
    setChBaseUrl(c.base_url);
    setChModels(c.meta.models.join(","));
    setChPriority(String(c.meta.priority ?? 90));
    setChEnabled(c.meta.enabled);
    setChKey("");
    onToast(`已载入渠道 ${c.id} 到上方表单，填入新凭证后点击保存即可更新`);
  };

  const handleProbe = async (id: string) => {
    setBusy(true);
    try {
      const res = await adminProbeChannel(jwt, adminKey, id);
      setProbeMap((prev) => ({ ...prev, [id]: res }));
      onToast(res.ok ? `渠道 ${id} 在线 (${res.latency_ms}ms) · ${res.balance_text}` : `渠道 ${id} 测活失败 (${res.latency_ms}ms)`);
    } catch (e) {
      onToast(`测活失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleMintResell = async () => {
    setBusy(true);
    try {
      const res = await adminMintResellKeys(jwt, adminKey, {
        count: Math.max(1, Number(resellCount) || 1),
        quota_credits: Math.max(1, Number(resellQuota) || 100),
        batch_name: resellBatch.trim() || "RESELL",
        expires_days: Math.max(0, Number(resellDays) || 0),
      });
      setResellKeys(res.keys);
      onToast(`已批量生成 ${res.count} 张预充值转售 API Key（每张 ${res.quota_credits} 积分）！`);
    } catch (e) {
      onToast(`生成失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRoleChange = async (u: AdminUserSummary, role: UserRole, banned?: boolean) => {
    setBusy(true);
    try {
      const discount = role === "vip" ? 15 : role === "admin" ? 50 : 0;
      await adminUpdateUserRole(jwt, adminKey, {
        username: u.username,
        role,
        discount_pct: discount,
        banned: banned ?? u.policy.banned,
      });
      onToast(`已更新 ${u.username} 权限为 ${role.toUpperCase()}${banned ? " (已封禁)" : ""}`);
      loadAll();
    } catch (e) {
      onToast(`更新权限失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleQuickTopup = async (username: string) => {
    setBusy(true);
    try {
      await adminTopupUser(jwt, adminKey, {
        order_id: `ADM-${Date.now()}`,
        username,
        credits: 500,
      });
      onToast(`已为 ${username} 充值 +500 积分`);
      loadAll();
    } catch (e) {
      onToast(`充值失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Admin Auth Bar */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>管理员鉴权：</span>
        {isAdminRole ? (
          <span className="pill pill-admin">已通过 Admin JWT 自动授权</span>
        ) : (
          <input
            className="input mono"
            type="password"
            style={{ maxWidth: 300 }}
            placeholder="输入 X-Admin-Key（或使用管理员账号登录）"
            value={adminKey}
            onChange={(e) => onAdminKeyChange(e.target.value)}
          />
        )}
        <button className="btn btn-sm btn-primary" disabled={!hasAuth || busy} onClick={loadAll}>
          <RefreshCw size={13} /> 刷新数据
        </button>
      </div>

      {/* Section 1: Channels Pool + Resell API Key Batch Minting */}
      {section === "channels" && (
        <>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Server size={17} color="var(--primary)" /> 统一多协议上游接入（OpenAI / Gemini / Vertex AI / Anthropic / MOSS GPU）
              </h3>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
              <select className="select" value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <select className="select" value={chProvider} onChange={(e) => setChProvider(e.target.value)}>
                {PROVIDER_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input className="input" placeholder="渠道 ID" value={chId} onChange={(e) => setChId(e.target.value)} />
              <input className="input" placeholder="展示名称" value={chName} onChange={(e) => setChName(e.target.value)} />
              <input className="input mono" placeholder="Base URL (自动填充，可自定义)" value={chBaseUrl} onChange={(e) => setChBaseUrl(e.target.value)} />
              <input className="input" placeholder="路由模型 (逗号分隔或 *)" value={chModels} onChange={(e) => setChModels(e.target.value)} />
              <input className="input" placeholder="优先级 (默认 90)" value={chPriority} onChange={(e) => setChPriority(e.target.value)} />
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, padding: "0 6px" }}>
                <input type="checkbox" checked={chEnabled} onChange={(e) => setChEnabled(e.target.checked)} />
                启用该渠道
              </label>
            </div>
            <div style={{ marginTop: 10 }}>
              {chProvider === "vertex_ai" ? (
                <textarea
                  className="input mono"
                  rows={4}
                  placeholder='粘贴 Vertex AI Service Account 或 Authorized User OAuth2 JSON（含 "type": "service_account" 或 "authorized_user"）'
                  value={chKey}
                  onChange={(e) => setChKey(e.target.value)}
                />
              ) : (
                <input
                  className="input mono"
                  type="password"
                  placeholder={chProvider === "moss_gpu" ? "MOSS Broker 可留空（内网直连）" : "上游 API Key"}
                  value={chKey}
                  onChange={(e) => setChKey(e.target.value)}
                />
              )}
            </div>
            <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!hasAuth || busy} onClick={handleSaveChannel}>
              <Plus size={15} /> 保存 / 热接入统一渠道池
            </button>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">当前在线渠道池（{channels.length}）· 一键测活与动态拉取模型</h3>
              <button
                className="btn btn-sm btn-primary"
                disabled={!hasAuth || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await adminSyncModels(jwt, adminKey);
                    onToast(`动态同步完成：${r.synced_channels} 个渠道，新增 ${r.added_models} 个模型（总计 ${r.total_models}）`);
                  } catch (e) {
                    onToast(`同步失败：${(e as Error).message}`);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <RefreshCw size={13} /> 动态同步上游模型
              </button>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>渠道 ID</th>
                    <th>Base URL</th>
                    <th>测活状态 / 上游余额</th>
                    <th style={{ textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => {
                    const pr = probeMap[c.id];
                    return (
                      <tr key={c.id}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span className="mono" style={{ fontWeight: 700 }}>{c.id}</span>
                            <span className="pill pill-guest" style={{ fontSize: 11 }}>{c.provider}</span>
                            {!c.meta.enabled && <span className="pill pill-danger" style={{ fontSize: 11 }}>已停用</span>}
                          </div>
                          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{c.meta.models.join(", ")}</div>
                        </td>
                        <td className="mono" style={{ fontSize: 12 }}>{c.base_url}</td>
                        <td>
                          {pr ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              <span className={`pill ${pr.ok ? "pill-ok" : "pill-danger"}`} style={{ width: "fit-content" }}>
                                {pr.ok ? `在线 · ${pr.latency_ms}ms · ${pr.models_count} 模型` : `不可达 · ${pr.latency_ms}ms`}
                              </span>
                              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>余额：{pr.balance_text}</span>
                            </div>
                          ) : (
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>点击右侧按钮测活 / 查余额</span>
                          )}
                        </td>
                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                          <button
                            className="btn btn-sm"
                            style={{ marginRight: 6 }}
                            disabled={busy}
                            onClick={() => handleEditChannel(c)}
                          >
                            编辑
                          </button>
                          <button
                            className="btn btn-sm"
                            style={{ marginRight: 6 }}
                            disabled={busy}
                            onClick={() => handleProbe(c.id)}
                          >
                            <Activity size={13} /> 测活 & 查余额
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            disabled={busy}
                            onClick={async () => {
                              await adminDeleteChannel(jwt, adminKey, c.id);
                              onToast(`已删除渠道 ${c.id}`);
                              loadAll();
                            }}
                          >
                            <Trash2 size={13} /> 删除
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {channels.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                        {hasAuth ? "暂无动态渠道" : "请先鉴权以查看上游渠道池"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Batch Resell API Key Minting Card */}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <KeyRound size={17} color="var(--warning)" /> 转售 API Key 批发发卡（买家免注册，即插即用）
              </h3>
            </div>
            <p style={{ marginTop: 0, fontSize: 12.5, color: "var(--text-secondary)" }}>
              批量签发带独立预充值额度的 <span className="mono">sk-l42-...</span> 转售密钥，可直接上架发卡网 / 闲鱼 / 爱发电；买家拿到即可填入 Cursor / Claude Code / cc-switch 直接调用。
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
              <input className="input" placeholder="生成数量 (1~100)" value={resellCount} onChange={(e) => setResellCount(e.target.value)} />
              <input className="input" placeholder="单 Key 额度 (积分)" value={resellQuota} onChange={(e) => setResellQuota(e.target.value)} />
              <input className="input" placeholder="批次名称" value={resellBatch} onChange={(e) => setResellBatch(e.target.value)} />
              <input className="input" placeholder="有效天数 (0=永久)" value={resellDays} onChange={(e) => setResellDays(e.target.value)} />
              <button className="btn btn-primary" disabled={!hasAuth || busy} onClick={handleMintResell}>
                批量签发转售 Key
              </button>
            </div>
            {resellKeys.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--success)" }}>
                    已生成 {resellKeys.length} 张可转售密钥（Base URL: {origin}/relay/v1）
                  </span>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      const csv = resellKeys.map((k) => `${k} | BaseURL: ${origin}/relay/v1 | 额度: ${resellQuota}积分`).join("\n");
                      navigator.clipboard?.writeText(csv);
                      onToast("已复制发卡网格式密钥清单！");
                    }}
                  >
                    <Copy size={13} /> 一键复制发卡格式
                  </button>
                </div>
                <div className="code-box">{resellKeys.join("\n")}</div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Section 2: RBAC User Role Management */}
      {section === "users" && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <UserCog size={17} color="var(--primary)" /> 用户与 RBAC 权限管理（{users.length}）
            </h3>
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
              支持一键切换 普通用户 / VIP 会员（85折 + 20 Keys）/ 管理员 / 封禁状态
            </span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>当前角色</th>
                  <th>折扣 / Key 上限</th>
                  <th>可用积分</th>
                  <th>状态</th>
                  <th style={{ textAlign: "right" }}>权限与操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username}>
                    <td style={{ fontWeight: 700 }}>{u.username}</td>
                    <td>
                      <span className={`pill pill-${u.policy.role}`}>
                        {u.policy.role === "vip" && <Crown size={12} />}
                        {u.policy.role.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      {u.policy.discount_pct > 0 ? `${100 - u.policy.discount_pct} 折` : "原价"} · 最多 {u.policy.max_keys} Keys
                    </td>
                    <td className="mono" style={{ fontWeight: 700 }}>{u.paid_credits}</td>
                    <td>
                      {u.policy.banned ? (
                        <span className="pill pill-danger">已封禁</span>
                      ) : (
                        <span className="pill pill-ok">正常</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <select
                        className="select"
                        style={{ width: 112, display: "inline-block", marginRight: 6, padding: "4px 8px" }}
                        value={u.policy.role}
                        disabled={busy}
                        onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
                      >
                        <option value="user">普通用户</option>
                        <option value="vip">VIP 会员</option>
                        <option value="admin">管理员</option>
                      </select>
                      <button
                        className="btn btn-sm"
                        style={{ marginRight: 6 }}
                        disabled={busy}
                        onClick={() => handleQuickTopup(u.username)}
                      >
                        +500 积分
                      </button>
                      <button
                        className={`btn btn-sm ${u.policy.banned ? "btn-primary" : "btn-danger"}`}
                        disabled={busy}
                        onClick={() => handleRoleChange(u, u.policy.role, !u.policy.banned)}
                      >
                        <Ban size={13} /> {u.policy.banned ? "解封" : "封禁"}
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                      {hasAuth ? "暂无注册用户" : "请先鉴权以管理用户权限"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 3: Risk Control & Redemption Codes */}
      {section === "risk" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <ShieldAlert size={17} color="var(--danger)" /> 实时风控与 IP 封禁（tower_governor GCRA）
              </h3>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <span className="pill pill-danger">封禁 IP: {health?.risk?.blocked_ips ?? 0}</span>
              <span className="pill pill-warn">锁定 IP: {health?.risk?.locked_ips ?? 0}</span>
              <span className="pill pill-user">熔断 Key: {health?.risk?.frozen_keys ?? 0}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input mono"
                placeholder="输入 IPv4 / IPv6 地址"
                value={targetIp}
                onChange={(e) => setTargetIp(e.target.value)}
              />
              <button
                className="btn btn-danger"
                disabled={!hasAuth || busy}
                onClick={async () => {
                  try {
                    await adminIpAction(jwt, adminKey, "block_ip", targetIp.trim());
                    onToast(`已封禁 IP: ${targetIp}`);
                  } catch (e) {
                    onToast((e as Error).message);
                  }
                }}
              >
                封禁
              </button>
              <button
                className="btn"
                disabled={!hasAuth || busy}
                onClick={async () => {
                  try {
                    await adminIpAction(jwt, adminKey, "unblock_ip", targetIp.trim());
                    onToast(`已解封 IP: ${targetIp}`);
                  } catch (e) {
                    onToast((e as Error).message);
                  }
                }}
              >
                解封
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Gift size={17} color="var(--warning)" /> 批量生成积分兑换码
              </h3>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <input className="input" placeholder="数量" value={redCount} onChange={(e) => setRedCount(e.target.value)} />
              <input className="input" placeholder="面额积分" value={redCredits} onChange={(e) => setRedCredits(e.target.value)} />
              <input className="input" placeholder="前缀" value={redPrefix} onChange={(e) => setRedPrefix(e.target.value)} />
            </div>
            <button
              className="btn btn-primary"
              disabled={!hasAuth || busy}
              onClick={async () => {
                try {
                  const codes = await adminCreateRedemptions(jwt, adminKey, {
                    count: Math.max(1, Number(redCount) || 1),
                    credits: Math.max(1, Number(redCredits) || 100),
                    wallet_type: "paid",
                    prefix: redPrefix.trim() || "VIP",
                  });
                  setMintedCodes(codes);
                  onToast(`成功签发 ${codes.length} 张积分兑换码！`);
                } catch (e) {
                  onToast((e as Error).message);
                }
              }}
            >
              批量签发卡密
            </button>
            {mintedCodes.length > 0 && (
              <div className="code-box" style={{ marginTop: 12 }}>
                {mintedCodes.join("\n")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
