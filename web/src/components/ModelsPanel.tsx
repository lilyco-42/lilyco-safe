import { useMemo, useState } from "react";
import { Copy, Play, Search, Sparkles } from "lucide-react";
import type { ModelItem } from "../api";
import { ModelIcon } from "./ModelIcon";
import { ModelCompanyCards } from "./ModelCompanyCards";

interface Props {
  models: ModelItem[];
  discountPct: number;
  onTestModel: (modelId: string) => void;
  onToast: (msg: string) => void;
}

const CURATED_IDS = new Set([
  "free:gemma-4-31b",
  "free:gemma-4-26b",
  "free:gemini-3.5-flash-lite",
  "free:gemini-3.1-flash-lite",
  "free:gemini-2.5-flash",
  "free:cerebras-llama-3.3-70b",
  "free:sf-qwen2.5-7b",
  "free:flux-1-schnell",
  "free:nim-deepseek-r1",
  "free:nim-llama-3.3-70b",
  "free:moonshotai/kimi-k3.1-pro",
  "free:github-gpt-4o-mini",
  "free:nemotron-lightning",
  "free:ernie-5.5-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "kimi-k3.1-pro",
  "glm-5.3",
  "gemini-3.8-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "claude-sonnet-5.5",
  "gpt-6.2-astra",
]);

const PROVIDERS = [
  { id: "featured", label: "⭐ 精选常用" },
  { id: "free", label: "🎁 免费额度" },
  { id: "all", label: "全部模型" },
  { id: "gemini-aistudio-free", label: "AI Studio 免费池" },
  { id: "gemini-aistudio", label: "Google Gemini" },
  { id: "deepseek-official", label: "DeepSeek / 国产" },
  { id: "nvidia-nim-free", label: "NVIDIA NIM" },
  { id: "siliconflow-cn", label: "SiliconFlow" },
  { id: "cerebras-free", label: "Cerebras" },
  { id: "openrouter-main", label: "OpenRouter" },
];

export function ModelsPanel({ models, discountPct, onTestModel, onToast }: Props) {
  const [view, setView] = useState<"companies" | "table">("companies");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("featured");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (q) return m.id.toLowerCase().includes(q) || m.owned_by.toLowerCase().includes(q);
      if (provider === "featured") return CURATED_IDS.has(m.id);
      if (provider === "free" && !m.allow_free) return false;
      if (provider !== "all" && provider !== "free" && !m.owned_by.includes(provider.replace("-main", "").replace("-free", ""))) return false;
      return true;
    });
  }, [models, provider, query]);

  const applyDisc = (v: number) => {
    if (v === 0 || discountPct <= 0) return v;
    return Math.max(1, Math.ceil((v * (100 - discountPct)) / 100));
  };

  if (view === "companies") {
    return (
      <section className="card">
        <div className="card-header">
          <div className="seg-tabs">
            <button type="button" className="seg-tab active" onClick={() => setView("companies")}>
              <Sparkles size={14} /> 厂商名片墙
            </button>
            <button type="button" className="seg-tab" onClick={() => setView("table")}>
              全部模型与费率 ({models.length})
            </button>
          </div>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            兼容 OpenAI / Responses / Anthropic / Gemini 原生协议
          </span>
        </div>
        <ModelCompanyCards onPick={onTestModel} textOnly={false} />
      </section>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="seg-tabs" style={{ marginBottom: 8 }}>
            <button type="button" className="seg-tab" onClick={() => setView("companies")}>
              <Sparkles size={14} /> 厂商名片墙
            </button>
            <button type="button" className="seg-tab active" onClick={() => setView("table")}>
              全部模型与费率 ({filtered.length} / {models.length})
            </button>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            兼容 OpenAI <span className="mono">/v1/chat/completions</span> · <span className="mono">/v1/responses</span> · Anthropic <span className="mono">/v1/messages</span> · Gemini <span className="mono">/v1beta/models/*</span>
            {discountPct > 0 && (
              <span className="pill pill-vip" style={{ marginLeft: 8 }}>
                已享 {100 - discountPct} 折 VIP 费率
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ position: "relative", width: 260 }}>
          <Search size={15} style={{ position: "absolute", left: 10, top: 10, color: "var(--text-muted)" }} />
          <input
            className="input"
            style={{ paddingLeft: 32 }}
            placeholder="搜索模型 ID，如 deepseek / gemini..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          </div>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          padding: "10px 14px",
          marginBottom: 14,
          borderRadius: 10,
          background: "var(--success-soft)",
          border: "1px solid var(--success)",
          fontSize: 12.5,
        }}
      >
        <div>
          <b style={{ color: "var(--success)" }}>Google AI Studio 免费额度已接入</b>：
          <span className="mono">free:gemma-4-31b / free:gemma-4-26b</span>（30 RPM · 14.4K 次/天），
          <span className="mono">free:gemini-3.5-flash-lite / free:gemini-3.1-flash-lite</span>（15 RPM · 250K TPM · 500 次/天），0 积分即可开聊。
        </div>
        <button className="btn btn-sm btn-primary" onClick={() => setProvider("free")}>
          只看免费模型 ({models.filter((m) => m.allow_free).length})
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={`btn btn-sm ${provider === p.id ? "btn-primary" : ""}`}
            onClick={() => setProvider(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>模型 ID</th>
              <th>路由池 / 供应商</th>
              <th>计费类型</th>
              <th>输入费率 (积分 / 1M)</th>
              <th>输出费率 (积分 / 1M)</th>
              <th style={{ textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <ModelIcon modelId={m.id} size={20} />
                    <span className="mono" style={{ fontWeight: 700 }}>{m.id}</span>
                  </div>
                </td>
                <td>
                  <span className="pill pill-guest">{m.owned_by}</span>
                </td>
                <td>
                  {m.allow_free ? (
                    <span className="pill pill-ok">免费体验</span>
                  ) : m.billing_mode === "per_second" ? (
                    <span className="pill pill-vip">按秒计费</span>
                  ) : m.billing_mode === "per_call" ? (
                    <span className="pill pill-user">按次计费</span>
                  ) : (
                    <span className="pill pill-user">实付按量</span>
                  )}
                </td>
                <td>
                  {m.allow_free ? (
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>免费</span>
                  ) : m.billing_mode === "per_second" ? (
                    <b>{applyDisc(m.unit_credits || 20)} 积分 / 秒</b>
                  ) : m.billing_mode === "per_call" ? (
                    <b>{applyDisc(m.unit_credits || 1)} 积分 / 次</b>
                  ) : m.input_per_m === 0 ? (
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>免费</span>
                  ) : discountPct > 0 ? (
                    <span>
                      <b style={{ color: "var(--warning)" }}>{applyDisc(m.input_per_m)}</b>{" "}
                      <span style={{ textDecoration: "line-through", color: "var(--text-muted)", fontSize: 12 }}>
                        {m.input_per_m}
                      </span>
                    </span>
                  ) : (
                    <b>{m.input_per_m}</b>
                  )}
                </td>
                <td>
                  {m.allow_free ? (
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>免费</span>
                  ) : m.billing_mode === "per_second" || m.billing_mode === "per_call" ? (
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>
                  ) : m.output_per_m === 0 ? (
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>免费</span>
                  ) : discountPct > 0 ? (
                    <span>
                      <b style={{ color: "var(--warning)" }}>{applyDisc(m.output_per_m)}</b>{" "}
                      <span style={{ textDecoration: "line-through", color: "var(--text-muted)", fontSize: 12 }}>
                        {m.output_per_m}
                      </span>
                    </span>
                  ) : (
                    <b>{m.output_per_m}</b>
                  )}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    className="btn btn-sm"
                    style={{ marginRight: 6 }}
                    onClick={() => {
                      navigator.clipboard?.writeText(m.id);
                      onToast(`已复制模型 ID：${m.id}`);
                    }}
                  >
                    <Copy size={13} /> 复制
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => onTestModel(m.id)}>
                    <Play size={13} /> 对话测试
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                  没有匹配的模型
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
