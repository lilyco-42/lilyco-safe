import { useState } from "react";
import { Send } from "lucide-react";
import { sendChat, type ModelItem } from "../api";

interface Props {
  models: ModelItem[];
}

export function ChatPanel({ models }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(models[0]?.id ?? "gemini-2.5-flash");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("等待调用...");
  const [busy, setBusy] = useState(false);

  async function onSubmit(): Promise<void> {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setOutput("请求中...");
    try {
      const reply = await sendChat(apiKey, {
        model: model || models[0]?.id || "gemini-2.5-flash",
        messages: [{ role: "user", content: prompt.trim() }],
        stream: false,
      });
      setOutput(reply || "(空响应)");
    } catch (err) {
      setOutput(`拦截/错误: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3 style={{ margin: "0 0 10px" }}>AI 对话测试台（OpenAI / Anthropic 兼容）</h3>
      <label>
        子密钥 API Key (`sk-l42-...`)
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-l42-..." />
      </label>
      <label style={{ display: "block", marginTop: 10 }}>
        目标模型
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.id}</option>
          ))}
        </select>
      </label>
      <label style={{ display: "block", marginTop: 10 }}>
        对话内容
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="输入提示词..." />
      </label>
      <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onSubmit} disabled={busy}>
        <Send size={15} /> {busy ? "发送中..." : "发送请求"}
      </button>
      <pre>{output}</pre>
    </section>
  );
}
