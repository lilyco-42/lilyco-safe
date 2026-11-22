import { useState } from "react";
import { Bot, Send, Trash2, User } from "lucide-react";
import { sendChat, type ChatTurn, type ModelItem } from "../api";

interface Props {
  models: ModelItem[];
  selectedModel: string;
  onSelectModel: (m: string) => void;
  apiKey: string;
  onApiKeyChange: (k: string) => void;
  onAfterChat: () => void;
  onToast: (msg: string) => void;
}

export function ChatPanel({
  models,
  selectedModel,
  onSelectModel,
  apiKey,
  onApiKeyChange,
  onAfterChat,
  onToast,
}: Props) {
  const [sysPrompt, setSysPrompt] = useState("你是一个专业、简洁的中文 AI 工程助手。");
  const [input, setInput] = useState("");
  const [maxTokens, setMaxTokens] = useState(512);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [lastUsage, setLastUsage] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!apiKey.trim()) {
      onToast("请先在「令牌管理」签发或粘贴您的 sk-l42-... API Key");
      return;
    }
    const nextTurns: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns(nextTurns);
    setInput("");
    setBusy(true);
    try {
      const payload: ChatTurn[] = sysPrompt.trim()
        ? [{ role: "system", content: sysPrompt.trim() }, ...nextTurns]
        : nextTurns;
      const res = await sendChat(apiKey.trim(), selectedModel, payload, maxTokens);
      setTurns([...nextTurns, { role: "assistant", content: res.reply }]);
      if (res.usage) {
        setLastUsage(
          `Prompt ${res.usage.prompt_tokens} + Completion ${res.usage.completion_tokens} = ${res.usage.total_tokens} tokens`,
        );
      }
      onAfterChat();
    } catch (e) {
      onToast(`调用失败：${(e as Error).message}`);
      setTurns([...nextTurns, { role: "assistant", content: `⚠️ 调用失败：${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16, alignItems: "start" }}>
      {/* Left Settings Card */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 className="card-title">演练场配置</h3>
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            选择模型
          </label>
          <select className="select" value={selectedModel} onChange={(e) => onSelectModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} {m.allow_free ? "(免费)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            API Key (sk-l42-...)
          </label>
          <input
            className="input mono"
            type="password"
            placeholder="粘贴 sk-l42-... 令牌"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Max Tokens: {maxTokens}
          </label>
          <input
            type="range"
            min={64}
            max={4096}
            step={64}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            System Prompt
          </label>
          <textarea
            className="textarea"
            rows={4}
            value={sysPrompt}
            onChange={(e) => setSysPrompt(e.target.value)}
          />
        </div>

        <button className="btn btn-sm" onClick={() => { setTurns([]); setLastUsage(""); }}>
          <Trash2 size={13} /> 清空对话
        </button>
        {lastUsage && <div className="mono" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{lastUsage}</div>}
      </div>

      {/* Right Chat Stream */}
      <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 520 }}>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
          {turns.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--text-muted)", padding: 40 }}>
              <Bot size={36} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div style={{ fontWeight: 600 }}>在线验证您的 API Key 与上游 Key 池路由</div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>
                当前模型：<span className="mono">{selectedModel}</span>
              </div>
            </div>
          )}
          {turns.map((t, idx) => (
            <div
              key={idx}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                flexDirection: t.role === "user" ? "row-reverse" : "row",
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: t.role === "user" ? "var(--primary)" : "var(--bg-subtle)",
                  color: t.role === "user" ? "#fff" : "var(--text)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  border: "1px solid var(--border)",
                }}
              >
                {t.role === "user" ? <User size={15} /> : <Bot size={15} />}
              </div>
              <div
                style={{
                  maxWidth: "80%",
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: t.role === "user" ? "var(--primary)" : "var(--bg-subtle)",
                  color: t.role === "user" ? "#fff" : "var(--text)",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.6,
                  border: t.role === "user" ? "none" : "1px solid var(--border)",
                }}
              >
                {t.content}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <input
            className="input"
            placeholder="输入问题，按 Enter 发送..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          />
          <button className="btn btn-primary" disabled={busy} onClick={handleSend}>
            <Send size={15} /> {busy ? "生成中..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
