import type { ModelItem } from "../api";

interface Props {
  models: ModelItem[];
}

export function ModelsPanel({ models }: Props) {
  return (
    <section className="grid">
      {models.map((m) => (
        <article className="card" key={m.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <strong>{m.id}</strong>
            <span className={`badge ${m.allow_free ? "badge-ok" : "badge-warn"}`}>
              {m.allow_free ? "免费限流体验" : "仅限实付余额"}
            </span>
          </div>
          <p style={{ fontSize: 13, color: "var(--sub)", margin: "8px 0 0" }}>
            上游渠道: {m.owned_by}
          </p>
          <p style={{ fontSize: 13, color: "var(--sub)", margin: "4px 0 0" }}>
            输入 {m.input_per_m} 积分/M · 输出 {m.output_per_m} 积分/M
          </p>
        </article>
      ))}
    </section>
  );
}
