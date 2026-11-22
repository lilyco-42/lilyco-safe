import { useEffect, useState } from "react";
import { Coins, ExternalLink, Gift, History, RefreshCw, Sparkles, Users } from "lucide-react";
import {
  activateTrialCard,
  bindAffiliate,
  fetchUsageLogs,
  redeemCode,
  transferAffiliate,
  type MeResp,
  type UsageLogItem,
} from "../api";

interface Props {
  mode: "wallet" | "logs";
  jwt: string;
  adminKey: string;
  me: MeResp | null;
  onRefresh: () => void;
  onOpenAuth: () => void;
  onToast: (msg: string) => void;
}

export function WalletLogsPanel({ mode, jwt, adminKey, me, onRefresh, onOpenAuth, onToast }: Props) {
  const [code, setCode] = useState("");
  const [referrer, setReferrer] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<UsageLogItem[]>([]);
  const [scope, setScope] = useState("own");

  const loadLogs = async () => {
    if (!jwt && !adminKey) return;
    try {
      const res = await fetchUsageLogs(jwt, adminKey);
      setLogs(res.logs || []);
      setScope(res.scope || "own");
    } catch {
      setLogs([]);
    }
  };

  useEffect(() => {
    if (mode === "logs") loadLogs();
  }, [mode, jwt, adminKey]);

  const handleRedeem = async () => {
    if (!jwt) return onOpenAuth();
    if (!code.trim()) return;
    setBusy(true);
    try {
      const r = await redeemCode(jwt, code.trim());
      setCode("");
      onToast(`兑换成功！入账 ${r.credits} 积分（${r.wallet_type}）`);
      onRefresh();
    } catch (e) {
      onToast(`兑换失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleBindRef = async () => {
    if (!jwt) return onOpenAuth();
    if (!referrer.trim()) return;
    setBusy(true);
    try {
      await bindAffiliate(jwt, referrer.trim());
      setReferrer("");
      onToast("推荐人绑定成功！");
      onRefresh();
    } catch (e) {
      onToast(`绑定失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleTransfer = async () => {
    if (!jwt) return onOpenAuth();
    setBusy(true);
    try {
      const r = await transferAffiliate(jwt);
      onToast(`已将 ${r.transferred} 返佣积分转入实付 AI 钱包！`);
      onRefresh();
    } catch (e) {
      onToast(`划转失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "logs") {
    return (
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <History size={17} color="var(--primary)" /> 调用与计费日志（{scope === "all" ? "全站视图" : "个人视图"}）
          </h3>
          <button className="btn btn-sm" onClick={loadLogs}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>模型</th>
                <th>总 Tokens</th>
                <th>实扣积分</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i}>
                  <td className="mono">{new Date(l.created_at * 1000).toLocaleString()}</td>
                  <td className="mono" style={{ fontWeight: 600 }}>{l.model}</td>
                  <td>{l.tokens.toLocaleString()}</td>
                  <td>
                    <span className="pill pill-user">-{l.credits} 积分</span>
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", color: "var(--text-muted)", padding: 28 }}>
                    {jwt || adminKey ? "暂无调用日志" : "请先登录查看您的调用日志"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const wallet = me?.wallet;
  const trialCards = me?.trial_cards || [];
  const nowUnix = Math.floor(Date.now() / 1000);

  const handleActivateCard = async (cardId: string) => {
    if (!jwt) return onOpenAuth();
    setBusy(true);
    try {
      await activateTrialCard(jwt, cardId);
      onToast("体验卡已激活！1 小时 · 100MB 高速流量体验已开始计时");
      onRefresh();
    } catch (e) {
      onToast(`激活失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
      {/* Unified Credits Wallet */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Coins size={17} color="var(--primary)" /> 积分余额（与 lain42.top 账户实时同步）
          </h3>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div style={{ background: "var(--bg-subtle)", padding: 14, borderRadius: 9, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>可用积分</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: "var(--primary)", marginTop: 4 }}>
              {wallet?.paid_credits ?? 0}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>1 CNY = 10 积分 · 不做免费积分区分</div>
          </div>
          <div style={{ background: "var(--bg-subtle)", padding: 14, borderRadius: 9, border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>推广返佣积分</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: "var(--success)", marginTop: 4 }}>
              {wallet?.affiliate_credits ?? 0}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>好友实付充值自动返佣 15%</div>
          </div>
        </div>
        <a href="https://lain42.top/shop" target="_blank" rel="noreferrer" className="btn btn-primary" style={{ width: "100%" }}>
          前往 lain42.top/shop 在线充值（支付宝 / 爱发电 / Stripe） <ExternalLink size={14} />
        </a>
      </div>

      {/* New-User Trial Cards */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Sparkles size={17} color="var(--warning)" /> 新用户体验卡（不送积分 · 只送体验卡）
          </h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {trialCards.map((c) => {
            const active = c.expires_unix > nowUnix;
            const minsLeft = active ? Math.max(1, Math.ceil((c.expires_unix - nowUnix) / 60)) : 0;
            return (
              <div
                key={c.id}
                style={{
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{c.spec}</div>
                </div>
                {c.expires_unix === 0 ? (
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => handleActivateCard(c.id)}>
                    立即激活
                  </button>
                ) : active ? (
                  <span className="pill pill-ok">生效中 · 剩 {minsLeft} 分钟</span>
                ) : (
                  <span className="pill pill-guest">已过期</span>
                )}
              </div>
            );
          })}
          {trialCards.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              登录后自动发放：<b>代理高速体验卡（1 小时 · 100MB 高速流量体验）</b>。
            </div>
          )}
        </div>
      </div>

      {/* Redemption Code Card */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Gift size={17} color="var(--warning)" /> 兑换码充值（Redeem）
          </h3>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 0 }}>
          输入管理员签发的卡密兑换码，立即充入您的实付 AI 钱包。
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input mono"
            placeholder="例如 VIP-XXXXXXXXXXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy} onClick={handleRedeem}>
            兑换
          </button>
        </div>
      </div>

      {/* Affiliate Card */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Users size={17} color="var(--success)" /> 邀请返佣（仅实付充值触发）
          </h3>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 10 }}>
          您的专属邀请码：<b className="mono">{me?.referral_code || "登录后获取"}</b>（好友实付充值自动返佣 15%）
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            className="input"
            placeholder="输入推荐人用户名"
            value={referrer}
            onChange={(e) => setReferrer(e.target.value)}
          />
          <button className="btn" disabled={busy} onClick={handleBindRef}>
            绑定
          </button>
        </div>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleTransfer}>
          将返佣余额（{wallet?.affiliate_credits ?? 0}）划转至实付 AI 钱包
        </button>
      </div>
    </div>
  );
}
