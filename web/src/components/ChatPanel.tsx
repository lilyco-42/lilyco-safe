import { useState } from "react";
import { Bot, KeyRound, Send, Sparkles, Trash2, User } from "lucide-react";
import { issueApiKey, sendChat, type ChatTurn, type ModelItem } from "../api";

interface Props {
  jwt: string;
  models: ModelItem[];
  selectedModel: string;
  onSelectModel: (m: string) => void;
  apiKey: string;
  onApiKeyChange: (k: string) => void;
  onAfterChat: () => void;
  onOpenAuth: () => void;
  onToast: (msg: string) => void;
}

const QUICK_PROMPTS = [
  "你好，介绍一下你自己",
  "用 Rust 写一个带错误处理的 Hello World",
  "1 + 1 等于几？只回答数字",
];

export function ChatPanel({
  jwt,
  models,
  selectedModel,
  onSelectModel,
  apiKey,
  onApiKeyChange,
  onAfterChat,
  onOpenAuth,
  onToast,
}: Props) {
  const [sysPrompt, setSysPrompt] = useState("你是一个专业、简洁的中文 AI 工程助手。");
  const [input, setInput] = useState("");
  const [maxTokens, setMaxTokens] = useState(512);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [lastUsage, setLastUsage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState(false);

  const handleQuickKey = async () => {
    if (!jwt) return onOpenAuth();
    setIssuing(true);
    try {
      const res = await issueApiKey(jwt, {
        name: `playground-${Date.now().toString().slice(-4)}`,
        quota_limit: 50000,
        rpm_limit: 60,
        allowed_ips: "",
      });
      onApiKeyChange(res.api_key);
      navigator.clipboard?.writeText(res.api_key);
      onToast("已一键生成专属 API Key 并自动填入！");
      onAfterChat();
    } catch (e) {
      onToast(`生成失败：${(e as Error).message}`);
    } finally {
      setIssuing(false);
    }
  };

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || busy) return;
    if (!apiKey.trim()) {
      onToast("请先点击左侧「一键生成 API Key」或粘贴您的 sk-l42-... 令牌");
      return;
    }
    const nextTurns: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns(nextTurns);
    if (!overrideText) setInput("");
    setBusy(true);
    const t0 = performance.now();
    try {
      const payload: ChatTurn[] = sysPrompt.trim()
        ? [{ role: "system", content: sysPrompt.trim() }, ...nextTurns]
        : nextTurns;
      const res = await sendChat(apiKey.trim(), selectedModel, payload, maxTokens);
      const sec = ((performance.now() - t0) / 1000).toFixed(2);
      setTurns([...nextTurns, { role: "assistant", content: res.reply }]);
      if (res.usage) {
        setLastUsage(
          `耗时 ${sec}s · Prompt ${res.usage.prompt_tokens} + Completion ${res.usage.completion_tokens} = ${res.usage.total_tokens} tokens`,
        );
      } else {
        setLastUsage(`耗时 ${sec}s`);
      }
      onAfterChat();
    } catch (e) {
      const msg = (e as Error).message;
      onToast(`调用失败：${msg}`);
      setTurns([
        ...nextTurns,
        {
          role: "assistant",
          content: `⚠️ 调用失败：${msg}\n\n提示：当前服务器位于国内华为云，推荐使用极速直连模型 deepseek-v4.1-flash / kimi-k3.1-pro / glm-5.3；Google Gemini 与 OpenRouter 需在渠道池配置国内可达反代地址。`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const isOverseas = selectedModel.startsWith("gemini-") || selectedModel.startsWith("claude-");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "290px 1fr", gap: 16, alignItems: "start" }}>
      {/* Left Settings Card */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 className="card-title">演练场配置</h3>
        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            选择模型（推荐 deepseek-v4.1-flash）
          </label>
          <select className="select" value={selectedModel} onChange={(e) => onSelectModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.owned_by === "deepseek-official" ? " ⚡国内极速" : " 🌐海外通道"}
                {m.allow_free ? " (免费)" : ""}
              </option>
            ))}
          </select>
          {isOverseas && (
            <div style={{ fontSize: 11.5, color: "var(--warning)", marginTop: 6, lineHeight: 1.5 }}>
              提示：当前华为云节点位于国内，直连 Google/OpenRouter 可能超时；建议优先选择带 ⚡ 的国内极速模型。
            </div>
          )}
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            API Key (sk-l42-...)
          </label>
          <input
            className="input mono"
            type="password"
            placeholder="粘贴或点击下方一键生成"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          {!apiKey.trim() && (
            <button
              className="btn btn-sm btn-primary"
              style={{ width: "100%", marginTop: 8 }}
              disabled={issuing}
              onClick={handleQuickKey}
            >
              <KeyRound size={13} /> {issuing ? "生成中..." : "一键生成并自动填入 API Key"}
            </button>
          )}
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
            rows={3}
            value={sysPrompt}
            onChange={(e) => setSysPrompt(e.target.value)}
          />
        </div>

        <button className="btn btn-sm" onClick={() => { setTurns([]); setLastUsage(""); }}>
          <Trash2 size={13} /> 清空对话
        </button>
        {lastUsage && <div className="mono" style={{ fontSize: 11.5, color: "var(--success)" }}>{lastUsage}</div>}
      </div>

      {/* Right Chat Stream */}
      <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: 520 }}>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
          {turns.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--text-muted)", padding: 28, maxWidth: 460 }}>
              <Bot size={36} style={{ opacity: 0.45, marginBottom: 8 }} />
              <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>
                点下方快捷示例，1 秒实测您的 API Key
              </div>
              <div style={{ fontSize: 12.5, marginTop: 4, marginBottom: 14 }}>
                当前模型：<span className="mono">{selectedModel}</span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                {QUICK_PROMPTS.map((q) => (
                  <button key={q} className="btn btn-sm" onClick={() => handleSend(q)}>
                    <Sparkles size={12} color="var(--primary)" /> {q}
                  </button>
                ))}
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
          {busy && (
            <div style={{ fontSize: 12.5, color: "var(--primary)", paddingLeft: 40 }}>
              正在调用 {selectedModel}...
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <input
            className="input"
            placeholder="输入问题，按 Enter 发送..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          />
          <button className="btn btn-primary" disabled={busy} onClick={() => handleSend()}>
            <Send size={15} /> {busy ? "生成中..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
