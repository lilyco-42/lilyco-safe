import { ModelCompanyCards } from "./ModelCompanyCards";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, KeyRound, Send, Sparkles, Square, Trash2, User } from "lucide-react";
import { issueApiKey, sendChatStream, type ChatTurn, type ModelItem } from "../api";

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
  "你好，用 3 点介绍 Lilyco AI Studio",
  "用 Rust 写一个异步 SSE 流式服务端示例",
  "用 Markdown 表格对比 OpenAI 与 Anthropic 协议",
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
  const [sysPrompt, setSysPrompt] = useState("你是一个专业、简洁的中文 AI 工程助手，善用 Markdown 排版与代码块。");
  const [input, setInput] = useState("");
  const [maxTokens, setMaxTokens] = useState(1024);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [metrics, setMetrics] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    onToast("已停止流式输出");
  };

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || busy) return;
    if (!apiKey.trim()) {
      onToast("请先点击左侧「一键生成 API Key」或粘贴您的 sk-l42-... 令牌");
      return;
    }
    const baseTurns: ChatTurn[] = [...turns, { role: "user", content: text }];
    setTurns([...baseTurns, { role: "assistant", content: "" }]);
    if (!overrideText) setInput("");
    setBusy(true);
    setMetrics("连接上游流式通道中...");

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t0 = performance.now();
    let ttftMs: number | null = null;
    let streamed = "";
    let usageText = "";

    try {
      const payload: ChatTurn[] = sysPrompt.trim()
        ? [{ role: "system", content: sysPrompt.trim() }, ...baseTurns]
        : baseTurns;
      await sendChatStream(apiKey.trim(), selectedModel, payload, maxTokens, {
        signal: ctrl.signal,
        onDelta: (chunk) => {
          if (ttftMs === null) {
            ttftMs = Math.round(performance.now() - t0);
          }
          streamed += chunk;
          setTurns([...baseTurns, { role: "assistant", content: streamed }]);
          setMetrics(`SSE 流式输出中 · 首字延迟 ${ttftMs}ms`);
        },
        onUsage: (u) => {
          usageText = ` · ${u.prompt_tokens}+${u.completion_tokens}=${u.total_tokens} tokens`;
        },
      });
      const totalSec = ((performance.now() - t0) / 1000).toFixed(2);
      setMetrics(`完成 · 首字 ${ttftMs ?? 0}ms · 总耗时 ${totalSec}s${usageText}`);
      onAfterChat();
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const msg = (e as Error).message;
        onToast(`调用失败：${msg}`);
        setTurns([
          ...baseTurns,
          {
            role: "assistant",
            content: `⚠️ **调用失败**：${msg}\n\n> 提示：当前节点位于国内华为云，推荐使用极速直连模型 \`deepseek-v4.1-flash\` / \`kimi-k3.1-pro\` / \`glm-5.3\`。`,
          },
        ]);
        setMetrics(`失败：${msg}`);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const isOverseas = selectedModel.startsWith("gemini-") || selectedModel.startsWith("claude-");

  return (
    <div className="playground-layout">
      {/* Left Settings Pane */}
      <div className="card playground-pane" style={{ gap: 12, overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 className="card-title">演练场配置</h3>
          <span className="pill pill-ok" style={{ fontSize: 11 }}>SSE 真流式</span>
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            选择模型
          </label>
          <ModelCompanyCards compact textOnly selected={selectedModel} onPick={onSelectModel} />
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", fontSize: 12 }}>全部模型</summary>
          <select aria-label="全部模型" className="select" value={selectedModel} onChange={(e) => onSelectModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.owned_by === "deepseek-official" ? " ⚡国内极速" : " 🌐海外通道"}
                {m.allow_free ? " (免费)" : ""}
              </option>
            ))}
          </select>
          </details>
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
            min={128}
            max={4096}
            step={128}
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

        <button className="btn btn-sm" onClick={() => { setTurns([]); setMetrics(""); }}>
          <Trash2 size={13} /> 清空对话
        </button>
        {metrics && <div className="mono" style={{ fontSize: 11.5, color: "var(--success)" }}>{metrics}</div>}
      </div>

      {/* Right Chat Stream */}
      <div className="card playground-pane">
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, marginBottom: 14, paddingRight: 4 }}>
          {turns.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: "var(--text-muted)", padding: 28, maxWidth: 480 }}>
              <Bot size={36} style={{ opacity: 0.45, marginBottom: 8 }} />
              <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 15 }}>
                实时 SSE 逐字流式对话 + Markdown 渲染
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
                className={t.role === "assistant" ? "md-prose" : undefined}
                style={{
                  maxWidth: "82%",
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: t.role === "user" ? "var(--primary)" : "var(--bg-subtle)",
                  color: t.role === "user" ? "#fff" : "var(--text)",
                  lineHeight: 1.65,
                  border: t.role === "user" ? "none" : "1px solid var(--border)",
                  whiteSpace: t.role === "user" ? "pre-wrap" : "normal",
                }}
              >
                {t.role === "assistant" ? (
                  t.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.content}</ReactMarkdown>
                  ) : (
                    <span style={{ color: "var(--text-muted)", fontSize: 13 }}>思考中...</span>
                  )
                ) : (
                  t.content
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="composer-box">
          <textarea
            className="composer-textarea"
            rows={2}
            placeholder="输入问题，按 Enter 实时流式发送（Shift + Enter 换行）..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <div className="composer-footer">
            <span className="mono" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
              {selectedModel} · {apiKey.trim() ? "Key 已就绪" : "请先生成或填入 Key"}
            </span>
            {busy ? (
              <button className="btn btn-sm btn-danger" onClick={handleStop}>
                <Square size={13} /> 停止生成
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => handleSend()}>
                <Send size={13} /> 发送消息
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
