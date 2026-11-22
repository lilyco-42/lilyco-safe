import {
  Activity,
  BarChart3,
  Crown,
  KeyRound,
  ShieldCheck,
  Sparkles,
  Wallet,
  ArrowRight,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DashboardStatsResp, HealthResp, MeResp, UserRole } from "../api";

interface Props {
  me: MeResp | null;
  health: HealthResp | null;
  stats: DashboardStatsResp | null;
  onNavigate: (tab: string) => void;
  onOpenAuth: () => void;
}

const ROLE_TIERS: {
  role: UserRole;
  title: string;
  badge: string;
  cls: string;
  perks: string[];
}[] = [
  {
    role: "guest",
    title: "访客 Guest",
    badge: "未登录",
    cls: "pill-guest",
    perks: ["浏览模型广场与实时费率", "查看 cc-switch / Claude Code 接入文档", "公开健康与风控状态"],
  },
  {
    role: "user",
    title: "普通用户 User",
    badge: "标准权限",
    cls: "pill-user",
    perks: ["签发最多 5 个 sk-l42 API Key", "在线演练场 + 兑换码 + 邀请返佣", "查看个人调用与计费日志"],
  },
  {
    role: "vip",
    title: "VIP 会员",
    badge: "默认 85 折",
    cls: "pill-vip",
    perks: ["签发最多 20 个 API Key", "全模型实付自动 VIP 折扣", "优先路由高可用上游池"],
  },
  {
    role: "admin",
    title: "管理员 Admin",
    badge: "全栈控制",
    cls: "pill-admin",
    perks: ["最多 100 个 Key + 渠道 Key 池热管理", "RBAC 用户提权/设 VIP/封禁/充值", "全站风控 IP 封禁 & 批量生成兑换码"],
  },
];

export function DashboardPanel({ me, health, stats, onNavigate, onOpenAuth }: Props) {
  const authed = Boolean(me?.authenticated);
  const role: UserRole = me?.role || "guest";
  const wallet = me?.wallet;
  const keysCount = me?.keys?.length || 0;
  const maxKeys = me?.policy?.max_keys ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {!authed && (
        <div
          className="card"
          style={{
            background: "linear-gradient(135deg, rgba(79,70,229,0.08), rgba(6,182,212,0.08))",
            borderColor: "rgba(79,70,229,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
              欢迎访问 Lilyco AI Studio（MIT 安全增强版 new-api）
            </div>
            <div style={{ color: "var(--text-secondary)", fontSize: 13.5 }}>
              当前为 <b>访客模式</b>，可自由浏览 10+ 线上模型与费率。登录或注册后即可申请专属 <span className="mono">sk-l42-...</span> API Key，支持 OpenAI / Anthropic / cc-switch / Claude Code。
            </div>
          </div>
          <button className="btn btn-primary" onClick={onOpenAuth}>
            立即登录 / 注册 <ArrowRight size={15} />
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">
            <span>实付可用余额（AI 专用）</span>
            <Wallet size={16} color="var(--primary)" />
          </div>
          <div className="kpi-value">
            {authed ? (wallet?.paid_credits ?? 0).toLocaleString() : "—"}
          </div>
          <div className="kpi-sub">
            {authed
              ? `≈ ¥${(((wallet?.paid_credits ?? 0) / 10)).toFixed(2)} · 赠送 ${wallet?.bonus_credits ?? 0}（严格隔离）`
              : "1 CNY = 10 实付积分 · 双钱包隔离"}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">
            <span>API 令牌配额</span>
            <KeyRound size={16} color="var(--success)" />
          </div>
          <div className="kpi-value">
            {authed ? `${keysCount} / ${maxKeys}` : `0 / 0`}
          </div>
          <div className="kpi-sub">
            {authed ? "支持 IP 白名单、单 Key 限额与即时吊销" : "登录后解锁 5~20 个 API Key 配额"}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">
            <span>累计请求与 Token 消耗</span>
            <Activity size={16} color="var(--warning)" />
          </div>
          <div className="kpi-value">
            {stats ? stats.stats.total_requests.toLocaleString() : "0"}
          </div>
          <div className="kpi-sub">
            {stats
              ? `总 Tokens: ${(stats.stats.total_prompt_tokens + stats.stats.total_completion_tokens).toLocaleString()} · 扣费 ${stats.stats.total_credits_charged}`
              : "支持 OpenAI & Claude Code 双协议"}
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">
            <span>权限等级与安全风控</span>
            <ShieldCheck size={16} color="var(--primary)" />
          </div>
          <div className="kpi-value" style={{ fontSize: 20, marginTop: 4 }}>
            <span className={`pill pill-${role}`}>
              {role === "vip" && <Crown size={13} />}
              {role === "admin"
                ? "超级管理员"
                : role === "vip"
                  ? `VIP · ${100 - (me?.policy?.discount_pct || 15)}折`
                  : role === "user"
                    ? "普通用户"
                    : "访客 Guest"}
            </span>
          </div>
          <div className="kpi-sub">
            限流引擎: <span className="mono">{health?.risk?.rate_limiter || "tower_governor(gcra)"}</span>
          </div>
        </div>
      </div>

      {/* Live Model Usage Chart (Recharts) */}
      {authed && me?.usage && me.usage.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <BarChart3 size={17} color="var(--primary)" /> 最近调用 Token 分布（Recharts 实时统计）
            </h3>
            <button className="btn btn-sm" onClick={() => onNavigate("logs")}>
              查看完整调用日志
            </button>
          </div>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={me.usage.slice(0, 10).map((u, i) => ({
                  name: `${u.model.slice(0, 14)} #${i + 1}`,
                  Prompt: u.prompt_tokens,
                  Completion: u.completion_tokens,
                }))}
                margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
                <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
                <Tooltip />
                <Bar dataKey="Prompt" fill="#6366f1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Completion" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* 3-Step Quickstart Onboarding Guide */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Sparkles size={17} color="var(--primary)" /> 30 秒新手上手引导（3 步开箱即用）
          </h3>
          <button className="btn btn-sm btn-primary" onClick={() => onNavigate("chat")}>
            立即体验对话演练场 <ArrowRight size={13} />
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <div style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>第 1 步 · 签发 API 令牌</div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 10 }}>
              点击左侧「令牌管理」创建专属 <span className="mono">sk-l42-...</span> 密钥，系统会自动复制到剪贴板并同步填充至演练场。
            </div>
            <button className="btn btn-sm" onClick={() => (authed ? onNavigate("tokens") : onOpenAuth())}>
              {authed ? "去签发 / 管理 Key" : "先登录账号"}
            </button>
          </div>
          <div style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>第 2 步 · 选择高速模型开聊</div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 10 }}>
              推荐使用国内服务器极速直连模型 <b>deepseek-v4.1-flash</b> / <b>kimi-k3.1-pro</b> / <b>glm-5.3</b>（50ms 级上游响应）。
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => onNavigate("chat")}>
              打开演练场测试
            </button>
          </div>
          <div style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>第 3 步 · 接入 cc-switch / Claude Code</div>
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 10 }}>
              在「令牌管理」页面底部一键复制 <span className="mono">cc-switch JSON</span>、Claude Code 环境变量或 Cursor Base URL。
            </div>
            <button className="btn btn-sm" onClick={() => onNavigate("tokens")}>
              查看接入配置
            </button>
          </div>
        </div>
      </div>

      {/* 4-Tier RBAC Matrix */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Crown size={17} color="var(--warning)" /> 四级权限体系（RBAC）
          </h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm" onClick={() => onNavigate("models")}>
              浏览模型广场
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => onNavigate("tokens")}>
              <Sparkles size={13} /> 管理 API Key
            </button>
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 12,
          }}
        >
          {ROLE_TIERS.map((t) => {
            const isCurrent = t.role === role;
            return (
              <div
                key={t.role}
                style={{
                  border: isCurrent ? "1.5px solid var(--primary)" : "1px solid var(--border)",
                  background: isCurrent ? "var(--primary-soft)" : "var(--bg-subtle)",
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{t.title}</span>
                  <span className={`pill ${t.cls}`}>{isCurrent ? "当前等级" : t.badge}</span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
                  {t.perks.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
