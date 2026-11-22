import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { sendChat, type ChatMessage, type ModelItem } from "../api";

interface Props {
  models: ModelItem[];
  selectedModel: string;
  apiKey: string;
  onApiKeyChange: (k: string) => void;
}

export function ChatPanel({ models, selectedModel, apiKey, onApiKeyChange }: Props) {
  const [model, setModel] = useState(selectedModel || models[0]?.id || "gemini-2.5-flash");
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selectedModel) setModel(selectedModel);
  }, [selectedModel]);

  async function onSubmit(): Promise<void> {
    if (!prompt.trim() || busy) return;
    if (!apiKey.trim()) {
      setStatus("请先在「令牌与 cc-switch」页签一键申请 API Key，或在此填入 sk-l42-... 密钥");
      return;
    }
    const nextHistory: ChatMessage[] = [...history, { role: "user", content: prompt.trim() }];
    setHistory(nextHistory);
    setPrompt("");
    setBusy(true);
    setStatus("正在调用上游模型...");
    try {
      const reply = await sendChat(apiKey, { model, messages: nextHistory, stream: false });
      setHistory([...nextHistory, { role: "assistant", content: reply }]);
      setStatus("调用成功");
    } catch (err) {
      setStatus(`拦截/错误: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <label>
          当前使用 API Key (`sk-l42-...`)
          <input type="password" value={apiKey} onChange={(e) => onApiKeyChange(e.target.value)} placeholder="在令牌页申请后自动填入" />
        </label>
        <label>
          目标模型
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </label>
      </div>
      <div style={{ minHeight: 160, maxHeight: 360, overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
        {history.length === 0 ? (
          <div style={{ color: "var(--sub)", fontSize: 13 }}>选择模型并输入消息，直接在线体验 OpenAI / Anthropic / Gemini / DeepSeek 统一接口。</div>
        ) : (
          history.map((m, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <span className={`badge ${m.role === "user" ? "badge-warn" : "badge-ok"}`}>{m.role}</span>
              <div style={{ marginTop: 4, whiteSpace: "pre-wrap", fontSize: 14 }}>{m.content}</div>
            </div>
          ))
        )}
      </div>
      <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="输入提示词..." />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
        <button className="btn btn-primary" onClick={onSubmit} disabled={busy}>
          <Send size={14} /> {busy ? "请求中..." : "发送对话"}
        </button>
        <button className="btn" onClick={() => setHistory([])}>清空上下文</button>
        {status && <span style={{ fontSize: 13, color: "var(--sub)" }}>{status}</span>}
      </div>
    </section>
  );
}
