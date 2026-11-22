import { useMemo, useState } from "react";
import { Copy, Play, Search, Sparkles } from "lucide-react";
import type { ModelItem } from "../api";
import { ModelIcon } from "./ModelIcon";

interface Props {
  models: ModelItem[];
  discountPct: number;
  onTestModel: (modelId: string) => void;
  onToast: (msg: string) => void;
}

const PROVIDERS = [
  { id: "all", label: "全部模型" },
  { id: "deepseek-official", label: "DeepSeek / Kimi / GLM" },
  { id: "gemini-aistudio", label: "Google Gemini" },
  { id: "openrouter-main", label: "Claude / OpenRouter" },
  { id: "free", label: "免费体验" },
];

export function ModelsPanel({ models, discountPct, onTestModel, onToast }: Props) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");

  const filtered = useMemo(() => {
    return models.filter((m) => {
      if (provider === "free" && !m.allow_free) return false;
      if (provider !== "all" && provider !== "free" && m.owned_by !== provider) return false;
      if (query.trim() && !m.id.toLowerCase().includes(query.trim().toLowerCase())) return false;
      return true;
    });
  }, [models, provider, query]);

  const applyDisc = (v: number) => {
    if (v === 0 || discountPct <= 0) return v;
    return Math.max(1, Math.ceil((v * (100 - discountPct)) / 100));
  };

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">
            <Sparkles size={17} color="var(--primary)" /> 模型广场与实时费率（{filtered.length} / {models.length}）
          </h3>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
            兼容 OpenAI <span className="mono">/v1/chat/completions</span> 与 Anthropic <span className="mono">/v1/messages</span>
            {discountPct > 0 && (
              <span className="pill pill-vip" style={{ marginLeft: 8 }}>
                已享 {100 - discountPct} 折 VIP 费率
              </span>
            )}
          </div>
        </div>
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
                  ) : (
                    <span className="pill pill-user">实付按量</span>
                  )}
                </td>
                <td>
                  {m.input_per_m === 0 ? (
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
                  {m.output_per_m === 0 ? (
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
