import { Play } from "lucide-react";
import type { ModelItem } from "../api";

interface Props {
  models: ModelItem[];
  onUseModel: (modelId: string) => void;
}

export function ModelsPanel({ models, onUseModel }: Props) {
  return (
    <section className="grid">
      {models.map((m) => (
        <article className="card" key={m.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <strong>{m.id}</strong>
            <span className={`badge ${m.allow_free ? "badge-ok" : "badge-warn"}`}>
              {m.allow_free ? "免费体验" : "仅限实付"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="badge">OpenAI</span>
            <span className="badge">Anthropic / Claude Code</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--sub)" }}>
            默认路由: {m.owned_by} · 输入 {m.input_per_m} 积分/M · 输出 {m.output_per_m} 积分/M
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: "auto" }}
            onClick={() => onUseModel(m.id)}
          >
            <Play size={14} /> 立即在线使用
          </button>
        </article>
      ))}
    </section>
  );
}
