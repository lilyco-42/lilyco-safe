import { useEffect, useState } from "react";
import { Cpu, KeyRound, MessageSquare, Shield, ShieldCheck } from "lucide-react";
import { fetchHealth, fetchMe, fetchModels, portalAuth, type HealthResp, type MeResp, type ModelItem } from "./api";
import { AdminPoolPanel } from "./components/AdminPoolPanel";
import { ChatPanel } from "./components/ChatPanel";
import { ModelsPanel } from "./components/ModelsPanel";
import { TokensPanel } from "./components/TokensPanel";

type Tab = "models" | "tokens" | "chat" | "admin";

export function App() {
  const [tab, setTab] = useState<Tab>("models");
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [token, setToken] = useState(localStorage.getItem("wb-token") || "");
  const [me, setMe] = useState<MeResp | null>(null);
  const [activeKey, setActiveKey] = useState(localStorage.getItem("relay_sk") || "");
  const [chatModel, setChatModel] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authUser, setAuthUser] = useState("");
  const [authPass, setAuthPass] = useState("");
  const [authErr, setAuthErr] = useState("");

  async function refreshBase(): Promise<void> {
    try {
      const [h, m] = await Promise.all([fetchHealth(), fetchModels()]);
      setHealth(h);
      setModels(m);
    } catch { /* ignore */ }
  }

  async function refreshMe(tok: string): Promise<void> {
    if (!tok) { setMe(null); return; }
    try { setMe(await fetchMe(tok)); } catch { setMe(null); }
  }

  useEffect(() => {
    void refreshBase();
    void refreshMe(token);
  }, [token]);

  async function onSubmitAuth(): Promise<void> {
    setAuthErr("");
    try {
      const res = await portalAuth(authMode, authUser.trim(), authPass);
      localStorage.setItem("wb-token", res.token);
      setToken(res.token);
      setShowAuth(false);
    } catch (e) {
      setAuthErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="wrap">
      <header className="nav">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <ShieldCheck size={20} color="#10b981" />
          <strong>Lilyco AI Studio</strong>
          <span className="badge badge-ok">MIT · new-api / cc-switch</span>
          {health && <span className="badge">风控: {health.risk.rate_limiter}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <a className="btn" style={{ minHeight: 34, fontSize: 13 }} href="/shop">自动充值实付积分</a>
          {me ? (
            <>
              <span className="badge badge-ok">{me.wallet.username} · 💰 实付 {me.wallet.paid_credits}</span>
              <button className="btn" style={{ minHeight: 34, fontSize: 13 }} onClick={() => { localStorage.removeItem("wb-token"); setToken(""); }}>退出</button>
            </>
          ) : (
            <button className="btn btn-primary" style={{ minHeight: 34, fontSize: 13 }} onClick={() => setShowAuth(true)}>登录 / 注册</button>
          )}
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab === "models" ? "active" : ""}`} onClick={() => setTab("models")}><Cpu size={15} /> 模型广场 ({models.length})</button>
        <button className={`tab ${tab === "tokens" ? "active" : ""}`} onClick={() => setTab("tokens")}><KeyRound size={15} /> 申请 API Key & cc-switch</button>
        <button className={`tab ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}><MessageSquare size={15} /> 在线使用模型</button>
        <button className={`tab ${tab === "admin" ? "active" : ""}`} onClick={() => setTab("admin")}><Shield size={15} /> Key 池与风控后台</button>
      </nav>

      {tab === "models" && <ModelsPanel models={models} onUseModel={(id) => { setChatModel(id); setTab("chat"); }} />}
      {tab === "tokens" && (
        <TokensPanel
          token={token}
          me={me}
          activeKey={activeKey}
          onKeyCreated={(sk) => { localStorage.setItem("relay_sk", sk); setActiveKey(sk); }}
          onRefreshMe={() => void refreshMe(token)}
          onOpenAuth={() => setShowAuth(true)}
        />
      )}
      {tab === "chat" && <ChatPanel models={models} selectedModel={chatModel} apiKey={activeKey} onApiKeyChange={(k) => { localStorage.setItem("relay_sk", k); setActiveKey(k); }} />}
      {tab === "admin" && <AdminPoolPanel onRefresh={() => void refreshBase()} />}

      {showAuth && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }} onClick={(e) => { if (e.target === e.currentTarget) setShowAuth(false); }}>
          <div className="card" style={{ width: "100%", maxWidth: 400 }}>
            <h3 style={{ margin: "0 0 12px" }}>{authMode === "login" ? "登录 dev.lain42.top" : "注册统一账户"}</h3>
            <div className="tabs" style={{ marginBottom: 12 }}>
              <button className={`tab ${authMode === "login" ? "active" : ""}`} onClick={() => setAuthMode("login")}>登录</button>
              <button className={`tab ${authMode === "register" ? "active" : ""}`} onClick={() => setAuthMode("register")}>注册</button>
            </div>
            <input value={authUser} onChange={(e) => setAuthUser(e.target.value)} placeholder="用户名 (3-24位)" />
            <input type="password" value={authPass} onChange={(e) => setAuthPass(e.target.value)} placeholder="密码 (注册至少8位)" />
            {authErr && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{authErr}</div>}
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 12 }} onClick={onSubmitAuth}>确认</button>
          </div>
        </div>
      )}
    </div>
  );
}
