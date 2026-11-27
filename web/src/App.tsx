import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import {
  Bot,
  Coins,
  Command as CommandIcon,
  Crown,
  Globe,
  History,
  Image as ImageIcon,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogIn,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  ShieldAlert,
  Sparkles,
  Sun,
  UserCog,
} from "lucide-react";
import { Toaster, toast as sonnerToast } from "sonner";
import {
  fetchDashboardStats,
  fetchHealth,
  fetchMe,
  fetchModels,
  portalAuth,
  type DashboardStatsResp,
  type HealthResp,
  type MeResp,
  type ModelItem,
  type UserRole,
} from "./api";
import { DashboardPanel } from "./components/DashboardPanel";
import { ModelsPanel } from "./components/ModelsPanel";
import { TokensPanel } from "./components/TokensPanel";
import { ChatPanel } from "./components/ChatPanel";
import { WalletLogsPanel } from "./components/WalletLogsPanel";
import { CommandPalette } from "./components/CommandPalette";

// Code-split heavy vertical labs & admin console so initial console load stays fast
const ImageStudioPanel = lazy(() =>
  import("./components/ImageStudioPanel").then((m) => ({ default: m.ImageStudioPanel })),
);
const MultimodalStudioPanel = lazy(() =>
  import("./components/MultimodalStudioPanel").then((m) => ({ default: m.MultimodalStudioPanel })),
);
const BrowserAgentPanel = lazy(() =>
  import("./components/BrowserAgentPanel").then((m) => ({ default: m.BrowserAgentPanel })),
);
const WorkflowHubPanel = lazy(() =>
  import("./components/WorkflowHubPanel").then((m) => ({ default: m.WorkflowHubPanel })),
);
const AdminConsolePanel = lazy(() =>
  import("./components/AdminConsolePanel").then((m) => ({ default: m.AdminConsolePanel })),
);

type NavId =
  | "dashboard"
  | "models"
  | "chat"
  | "images"
  | "moss"
  | "workflows"
  | "browser"
  | "tokens"
  | "wallet"
  | "logs"
  | "admin-channels"
  | "admin-users"
  | "admin-risk";

const PAGE_META: Record<NavId, { group: string; title: string }> = {
  dashboard: { group: "控制台", title: "数据看板与权限概览" },
  models: { group: "控制台", title: "模型广场与费率" },
  chat: { group: "创作工坊", title: "在线对话演练场" },
  images: { group: "创作工坊", title: "AI 头像 & 我的世界 YSM 创作工坊" },
  moss: { group: "创作工坊", title: "MOSS 绘梦 · 多模态创作工坊" },
  workflows: { group: "创作工坊", title: "商业化 AI 创作工作流中心" },
  browser: { group: "创作工坊", title: "AI 浏览器助手 (ego-lite)" },
  tokens: { group: "接入与计费", title: "API 令牌与客户端接入" },
  wallet: { group: "接入与计费", title: "钱包、充值与推广返佣" },
  logs: { group: "接入与计费", title: "调用与计费日志" },
  "admin-channels": { group: "系统管理", title: "渠道 Key 池 · 实时价目 · 发卡" },
  "admin-users": { group: "系统管理", title: "用户与 RBAC 权限" },
  "admin-risk": { group: "系统管理", title: "风控与兑换码" },
};

export function App() {
  const [nav, setNav] = useState<NavId>(() => (window.location.hash === "#moss" ? "moss" : "dashboard"));

  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === "#moss") setNav("moss");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("lilyco-theme") as "light" | "dark") || "light",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem("lilyco-sidebar-collapsed") === "1",
  );
  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("lilyco-sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  };
  const [jwt, setJwt] = useState<string>(
    () => localStorage.getItem("lain42_studio_token") || localStorage.getItem("wb-token") || "",
  );
  const [adminKey, setAdminKey] = useState<string>(() => localStorage.getItem("lilyco-admin-key") || "");
  const [activeSecret, setActiveSecretState] = useState<string>(
    () => localStorage.getItem("lilyco-active-api-key") || "",
  );
  const setActiveSecret = useCallback((k: string) => {
    setActiveSecretState(k);
    if (k.trim()) localStorage.setItem("lilyco-active-api-key", k.trim());
    else localStorage.removeItem("lilyco-active-api-key");
  }, []);

  const [health, setHealth] = useState<HealthResp | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("deepseek-v4.1-flash");
  const [me, setMe] = useState<MeResp | null>(null);
  const [stats, setStats] = useState<DashboardStatsResp | null>(null);

  const [authModal, setAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);

  const showToast = useCallback((msg: string) => {
    if (msg.includes("失败")) sonnerToast.error(msg);
    else sonnerToast.success(msg);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("lilyco-theme", theme);
  }, [theme]);

  const refreshAll = useCallback(async () => {
    try {
      const [h, m, meRes] = await Promise.all([fetchHealth(), fetchModels(), fetchMe(jwt)]);
      setHealth(h);
      setModels(m);
      setMe(meRes);
      if (jwt && meRes.authenticated) {
        try {
          setStats(await fetchDashboardStats(jwt));
        } catch {
          setStats(null);
        }
      } else {
        setStats(null);
      }
    } catch {
      // ignore transient errors
    }
  }, [jwt]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handleAuthSubmit = async () => {
    if (!username.trim() || !password.trim()) return showToast("请输入用户名和密码");
    setAuthBusy(true);
    try {
      const res = await portalAuth(authMode, username.trim(), password);
      localStorage.setItem("lain42_studio_token", res.token);
      localStorage.setItem("wb-token", res.token);
      setJwt(res.token);
      setAuthModal(false);
      setPassword("");
      showToast(authMode === "login" ? `欢迎回来，${res.username}！` : `注册并登录成功：${res.username}`);
    } catch (e) {
      showToast(`${authMode === "login" ? "登录" : "注册"}失败：${(e as Error).message}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("lain42_studio_token");
    localStorage.removeItem("wb-token");
    setJwt("");
    setMe(null);
    setStats(null);
    showToast("已退出登录，当前切换为访客模式");
  };

  const role: UserRole = me?.role || "guest";
  const isAdmin = role === "admin";
  const authed = Boolean(me?.authenticated);

  return (
    <div className="app-shell">
      {/* Left Enterprise Sidebar (new-api style, collapsible) */}
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-icon">L</div>
          <div className="brand-text">
            <span className="brand-title">Lilyco AI Studio</span>
            <span className="brand-sub">MIT Zero-Trust Relay</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group">
            <div className="nav-group-label">控制台</div>
            <button title="数据看板" className={`nav-item ${nav === "dashboard" ? "active" : ""}`} onClick={() => setNav("dashboard")}>
              <LayoutDashboard size={16} /> <span className="nav-label">数据看板</span>
            </button>
            <button title="模型广场" className={`nav-item ${nav === "models" ? "active" : ""}`} onClick={() => setNav("models")}>
              <Sparkles size={16} /> <span className="nav-label">模型广场</span>
              <span className="nav-badge">{models.length}</span>
            </button>
          </div>

          <div className="nav-group">
            <div className="nav-group-label">创作工坊</div>
            <button title="对话演练场" className={`nav-item ${nav === "chat" ? "active" : ""}`} onClick={() => setNav("chat")}>
              <Bot size={16} /> <span className="nav-label">对话演练场</span>
            </button>
            <button
              title="MOSS 绘梦"
              className={`nav-item ${nav === "moss" ? "active" : ""}`}
              onClick={() => {
                setNav("moss");
                window.history.replaceState(null, "", "#moss");
              }}
            >
              <Sparkles size={16} /> <span className="nav-label">MOSS 绘梦</span>
              <span className="nav-badge" style={{ background: "#dcfce7", color: "#15803d" }}>免费</span>
            </button>
            <button title="头像 & YSM" className={`nav-item ${nav === "images" ? "active" : ""}`} onClick={() => setNav("images")}>
              <ImageIcon size={16} /> <span className="nav-label">头像 & YSM</span>
              <span className="nav-badge">热门</span>
            </button>
            <button title="创作工作流" className={`nav-item ${nav === "workflows" ? "active" : ""}`} onClick={() => setNav("workflows")}>
              <Layers size={16} /> <span className="nav-label">创作工作流</span>
              <span className="nav-badge">PRO</span>
            </button>
            <button title="浏览器助手" className={`nav-item ${nav === "browser" ? "active" : ""}`} onClick={() => setNav("browser")}>
              <Globe size={16} /> <span className="nav-label">浏览器助手</span>
              <span className="nav-badge">ego</span>
            </button>
          </div>

          <div className="nav-group">
            <div className="nav-group-label">接入与计费</div>
            <button title="令牌管理" className={`nav-item ${nav === "tokens" ? "active" : ""}`} onClick={() => setNav("tokens")}>
              <KeyRound size={16} /> <span className="nav-label">令牌管理</span>
              {authed && <span className="nav-badge">{me?.keys?.length ?? 0}</span>}
            </button>
            <button title="钱包与充值" className={`nav-item ${nav === "wallet" ? "active" : ""}`} onClick={() => setNav("wallet")}>
              <Coins size={16} /> <span className="nav-label">钱包与充值</span>
            </button>
            <button title="调用日志" className={`nav-item ${nav === "logs" ? "active" : ""}`} onClick={() => setNav("logs")}>
              <History size={16} /> <span className="nav-label">调用日志</span>
            </button>
          </div>

          <div className="nav-group">
            <div className="nav-group-label">系统管理</div>
            <button
              title="渠道与价目表"
              className={`nav-item ${nav === "admin-channels" ? "active" : ""}`}
              onClick={() => setNav("admin-channels")}
            >
              <Server size={16} /> <span className="nav-label">渠道与价目</span>
            </button>
            <button
              title="用户与权限"
              className={`nav-item ${nav === "admin-users" ? "active" : ""}`}
              onClick={() => setNav("admin-users")}
            >
              <UserCog size={16} /> <span className="nav-label">用户与权限</span>
              <span className="nav-badge">RBAC</span>
            </button>
            <button
              title="风控与兑换码"
              className={`nav-item ${nav === "admin-risk" ? "active" : ""}`}
              onClick={() => setNav("admin-risk")}
            >
              <ShieldAlert size={16} /> <span className="nav-label">风控与兑换码</span>
            </button>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: "flex", alignItems: "center", justifyContent: sidebarCollapsed ? "center" : "space-between", marginBottom: sidebarCollapsed ? 0 : 4 }}>
            <span className="sidebar-footer-detail">网关状态</span>
            <span className="pill pill-ok" style={{ padding: "1px 7px", fontSize: 11 }}>
              {health?.ok ? "在线" : "..."}
            </span>
          </div>
          <div className="mono sidebar-footer-detail" style={{ fontSize: 11 }}>
            lilyco-safe · {health?.license || "MIT"}
          </div>
        </div>
      </aside>

      {/* Right Main Area */}
      <div className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: "5px 7px" }}
              title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
              onClick={toggleSidebar}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
            <div className="breadcrumb">
              <span>{PAGE_META[nav].group}</span>
              <span className="breadcrumb-sep">/</span>
              <h1 className="page-title">{PAGE_META[nav].title}</h1>
            </div>
          </div>

          <div className="topbar-right">
            <button className="btn btn-sm" onClick={() => setCmdOpen(true)} title="快捷命令面板">
              <CommandIcon size={13} /> 快捷搜索 <kbd style={{ fontSize: 10.5, opacity: 0.7 }}>⌘K</kbd>
            </button>
            <span className={`pill pill-${role}`}>
              {role === "vip" && <Crown size={12} />}
              {role === "admin"
                ? `管理员 · ${me?.wallet?.username || "admin"}`
                : role === "vip"
                  ? `VIP (${100 - (me?.policy?.discount_pct || 15)}折) · ${me?.wallet?.username}`
                  : role === "user"
                    ? `用户 · ${me?.wallet?.username}`
                    : "访客 Guest"}
            </span>

            {authed && (
              <button className="btn btn-sm" onClick={() => setNav("wallet")}>
                <Coins size={13} color="var(--primary)" /> 实付 {me?.wallet?.paid_credits ?? 0} 积分
              </button>
            )}

            <button
              className="btn btn-sm"
              title="切换明暗主题"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
            </button>

            {authed ? (
              <button className="btn btn-sm" onClick={handleLogout}>
                <LogOut size={14} /> 退出
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => setAuthModal(true)}>
                <LogIn size={14} /> 登录 / 注册
              </button>
            )}
          </div>
        </header>

        <main className="content-wrap">
          <Suspense
            fallback={
              <div className="card" style={{ textAlign: "center", padding: 48, color: "var(--text-muted)" }}>
                正在按需加载模块...
              </div>
            }
          >
          {nav === "dashboard" && (
            <DashboardPanel
              me={me}
              health={health}
              stats={stats}
              onNavigate={(t) => setNav(t as NavId)}
              onOpenAuth={() => setAuthModal(true)}
            />
          )}
          {nav === "models" && (
            <ModelsPanel
              models={models}
              discountPct={me?.policy?.discount_pct ?? 0}
              onTestModel={(id) => {
                setSelectedModel(id);
                setNav("chat");
              }}
              onToast={showToast}
            />
          )}
          {nav === "tokens" && (
            <TokensPanel
              jwt={jwt}
              me={me}
              activeSecret={activeSecret}
              onSecretIssued={setActiveSecret}
              onRefresh={refreshAll}
              onOpenAuth={() => setAuthModal(true)}
              onToast={showToast}
            />
          )}
          {nav === "chat" && (
            <ChatPanel
              jwt={jwt}
              models={models}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              apiKey={activeSecret}
              onApiKeyChange={setActiveSecret}
              onAfterChat={refreshAll}
              onOpenAuth={() => setAuthModal(true)}
              onToast={showToast}
            />
          )}
          {nav === "images" && (
            <ImageStudioPanel
              models={models}
              apiKey={activeSecret}
              onApiKeyChange={setActiveSecret}
              onAfterGenerate={refreshAll}
              onToast={showToast}
            />
          )}
          {nav === "moss" && (
            <MultimodalStudioPanel
              jwt={jwt}
              isAdmin={isAdmin}
              authed={authed}
              apiKey={activeSecret}
              onGoTokens={() => setNav("tokens")}
              onToast={showToast}
            />
          )}
          {nav === "workflows" && (
            <WorkflowHubPanel
              apiKey={activeSecret}
              onApiKeyChange={setActiveSecret}
              onAfterRun={refreshAll}
              onToast={showToast}
            />
          )}
          {nav === "browser" && (
            <BrowserAgentPanel apiKey={activeSecret} onToast={showToast} />
          )}
          {(nav === "wallet" || nav === "logs") && (
            <WalletLogsPanel
              mode={nav}
              jwt={jwt}
              adminKey={adminKey}
              me={me}
              onRefresh={refreshAll}
              onOpenAuth={() => setAuthModal(true)}
              onToast={showToast}
            />
          )}
          {(nav === "admin-channels" || nav === "admin-users" || nav === "admin-risk") && (
            <AdminConsolePanel
              section={nav === "admin-channels" ? "channels" : nav === "admin-users" ? "users" : "risk"}
              jwt={jwt}
              isAdminRole={isAdmin}
              adminKey={adminKey}
              onAdminKeyChange={(k) => {
                setAdminKey(k);
                localStorage.setItem("lilyco-admin-key", k);
              }}
              health={health}
              onToast={showToast}
            />
          )}
          </Suspense>
          <footer className="site-beian-footer" aria-label="网站备案信息">
            <span>© 2026 宿松县云枢智创数码信息科技服务工作室</span>
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
              皖ICP备2025106854号-1
            </a>
          </footer>
        </main>
      </div>

      {/* Login / Register Modal */}
      {authModal && (
        <div className="modal-backdrop" onClick={() => setAuthModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 6px", fontSize: 17 }}>
              {authMode === "login" ? "登录 Lilyco AI Studio" : "注册新账号（自动同步 dev.lain42.top）"}
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--text-muted)" }}>
              登录后解锁 API Key 申请、在线演练场、兑换码与调用日志。
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                className="input"
                placeholder="用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                className="input"
                type="password"
                placeholder="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAuthSubmit()}
              />
              <button className="btn btn-primary" disabled={authBusy} onClick={handleAuthSubmit}>
                {authBusy ? "提交中..." : authMode === "login" ? "立即登录" : "注册并登录"}
              </button>
              <button
                className="btn"
                onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}
              >
                {authMode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
              </button>
            </div>
          </div>
        </div>
      )}

      <Toaster richColors position="bottom-right" theme={theme} />
      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        models={models}
        onNavigate={(id) => setNav(id as NavId)}
        onTestModel={(id) => {
          setSelectedModel(id);
          setNav("chat");
        }}
        onToggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
        theme={theme}
      />
    </div>
  );
}
export default App;
