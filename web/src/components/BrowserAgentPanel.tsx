import { useState } from "react";
import { Copy, Globe, Play, Sparkles, Terminal } from "lucide-react";
import { sendChat } from "../api";

interface Props {
  apiKey: string;
  onToast: (msg: string) => void;
}

const INSTALL_CMD = `curl -fsSL https://raw.githubusercontent.com/lilyco-42/ego-lite-setup/main/install.sh | bash
# 同步本机 Google Chrome 登录态并启动独立 CDP 端口 (9229)
ego-sync-login --reload
ego-browser --doctor`;

export function BrowserAgentPanel({ apiKey, onToast }: Props) {
  const [targetUrl, setTargetUrl] = useState("https://aistudio.google.com/rate-limit");
  const [goal, setGoal] = useState("打开页面，读取当前账号所有可用模型与免费配额列表，并截图保存。");
  const [aiScript, setAiScript] = useState("");
  const [busy, setBusy] = useState(false);

  const defaultScript = `ego-browser nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('user-browser-task')
await browser.openOrReuseTab(${JSON.stringify(targetUrl)}, { wait: true, timeout: 25000 })
await page.waitForTimeout(2000)

const info = await page.info()
const summary = await page.evaluate(() => document.body.innerText.slice(0, 1500))
await page.screenshot({ path: '/tmp/ego-task-result.png' })

console.log(JSON.stringify({ taskSpaceId: task.id, url: info.url, title: info.title, summary }, null, 2))
EOF`;

  const displayScript = aiScript || defaultScript;

  const handleAiGenerate = async () => {
    if (!apiKey.trim()) {
      onToast("请先签发或填入 API Key，再使用 AI 定制脚本（或直接复制下方模板脚本）");
      return;
    }
    setBusy(true);
    try {
      const res = await sendChat(
        apiKey.trim(),
        "free:gemma-4-31b",
        [
          {
            role: "system",
            content:
              "You write concise, ready-to-run `ego-browser nodejs <<'EOF' ... EOF` automation scripts using taskSpaces.useOrCreate, browser.openOrReuseTab, page.info, page.locator, and page.screenshot. Output ONLY the bash command block.",
          },
          {
            role: "user",
            content: `目标网址: ${targetUrl}\n操作目标: ${goal}\n请生成一段可直接执行的 ego-browser 自动化脚本。`,
          },
        ],
        1024,
      );
      setAiScript(res.reply.trim());
      onToast("已使用免费模型生成 ego-lite 浏览器脚本！");
    } catch (e) {
      onToast(`AI 生成失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text);
    onToast(`已复制${label}！`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">
              <Globe size={17} color="var(--primary)" /> AI 浏览器助手（ego-lite · 继承本机 Google Chrome 登录态）
            </h3>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
              让 AI Agent 在独立隔离的 Task Space 中复用你的 Chrome 登录态，安全执行网页查询、填表、截图与配额巡检
            </div>
          </div>
          <span className="pill pill-ok">Chrome CDP :9229</span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            <Terminal size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} /> 1. 一键安装 ego-lite 并继承本机 Chrome
          </span>
          <button className="btn btn-sm" onClick={() => copy(INSTALL_CMD, "安装命令")}>
            <Copy size={13} /> 复制安装命令
          </button>
        </div>
        <div className="code-box">{INSTALL_CMD}</div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Sparkles size={17} color="var(--primary)" /> 2. 可视化生成 ego-lite 浏览器操作任务
          </h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm" onClick={() => copy(displayScript, "浏览器脚本")}>
              <Copy size={13} /> 复制脚本
            </button>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleAiGenerate}>
              <Play size={13} /> {busy ? "AI 编写中..." : "AI 免费定制脚本"}
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginBottom: 12 }}>
          <input
            className="input mono"
            placeholder="目标网址，如 https://aistudio.google.com/rate-limit"
            value={targetUrl}
            onChange={(e) => {
              setTargetUrl(e.target.value);
              setAiScript("");
            }}
          />
          <textarea
            className="input"
            rows={2}
            placeholder="用自然语言描述希望 AI 在浏览器里完成的操作..."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>

        <div className="code-box">{displayScript}</div>
      </div>
    </div>
  );
}
