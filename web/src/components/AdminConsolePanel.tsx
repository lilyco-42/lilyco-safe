import { useEffect, useState } from "react";
import {
  Ban,
  Crown,
  Gift,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  UserCog,
} from "lucide-react";
import {
  adminCreateRedemptions,
  adminDeleteChannel,
  adminIpAction,
  adminListChannels,
  adminListUsers,
  adminTopupUser,
  adminUpdateUserRole,
  adminUpsertChannel,
  type AdminUserSummary,
  type ChannelItem,
  type HealthResp,
  type UserRole,
} from "../api";

interface Props {
  section: "channels" | "users" | "risk";
  jwt: string;
  isAdminRole: boolean;
  adminKey: string;
  onAdminKeyChange: (k: string) => void;
  health: HealthResp | null;
  onToast: (msg: string) => void;
}

export function AdminConsolePanel({
  section,
  jwt,
  isAdminRole,
  adminKey,
  onAdminKeyChange,
  health,
  onToast,
}: Props) {
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [busy, setBusy] = useState(false);

  // Channel form
  const [chId, setChId] = useState("openrouter-pool-1");
  const [chName, setChName] = useState("OpenRouter Primary");
  const [chProvider, setChProvider] = useState("openrouter");
  const [chBaseUrl, setChBaseUrl] = useState("https://openrouter.ai/api/v1");
  const [chKey, setChKey] = useState("");
  const [chModels, setChModels] = useState("claude-sonnet-4,free:qwen3-8b");

  // Risk & Redemptions
  const [targetIp, setTargetIp] = useState("");
  const [redCount, setRedCount] = useState("3");
  const [redCredits, setRedCredits] = useState("100");
  const [redPrefix, setRedPrefix] = useState("VIP");
  const [mintedCodes, setMintedCodes] = useState<string[]>([]);

  const hasAuth = isAdminRole || adminKey.trim().length > 0;

  const loadAll = async () => {
    if (!hasAuth) return;
    setBusy(true);
    try {
      if (section === "channels") {
        setChannels(await adminListChannels(jwt, adminKey));
      } else if (section === "users") {
        setUsers(await adminListUsers(jwt, adminKey));
      }
    } catch (e) {
      onToast(`加载失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (hasAuth) loadAll();
  }, [section, isAdminRole, adminKey]);

  const handleSaveChannel = async () => {
    if (!chKey.trim()) return onToast("请填写上游 API Key");
    setBusy(true);
    try {
      await adminUpsertChannel(jwt, adminKey, {
        id: chId.trim(),
        provider: chProvider,
        endpoint: { name: chName.trim() || chId.trim(), base_url: chBaseUrl.trim(), api_key: chKey.trim() },
        routing: {
          models: chModels.split(",").map((s) => s.trim()).filter(Boolean),
          priority: 90,
          weight: 100,
          enabled: true,
        },
      });
      setChKey("");
      onToast(`渠道 ${chId} 已热接入 Key 池！`);
      loadAll();
    } catch (e) {
      onToast(`保存渠道失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRoleChange = async (u: AdminUserSummary, role: UserRole, banned?: boolean) => {
    setBusy(true);
    try {
      const discount = role === "vip" ? 15 : role === "admin" ? 50 : 0;
      await adminUpdateUserRole(jwt, adminKey, {
        username: u.username,
        role,
        discount_pct: discount,
        banned: banned ?? u.policy.banned,
      });
      onToast(`已更新 ${u.username} 权限为 ${role.toUpperCase()}${banned ? " (已封禁)" : ""}`);
      loadAll();
    } catch (e) {
      onToast(`更新权限失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleQuickTopup = async (username: string) => {
    setBusy(true);
    try {
      await adminTopupUser(jwt, adminKey, {
        order_id: `ADM-${Date.now()}`,
        username,
        credits: 500,
      });
      onToast(`已为 ${username} 充值 +500 实付积分`);
      loadAll();
    } catch (e) {
      onToast(`充值失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Admin Auth Bar */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>管理员鉴权：</span>
        {isAdminRole ? (
          <span className="pill pill-admin">已通过 Admin JWT 自动授权</span>
        ) : (
          <input
            className="input mono"
            type="password"
            style={{ maxWidth: 300 }}
            placeholder="输入 X-Admin-Key（或使用管理员账号登录）"
            value={adminKey}
            onChange={(e) => onAdminKeyChange(e.target.value)}
          />
        )}
        <button className="btn btn-sm btn-primary" disabled={!hasAuth || busy} onClick={loadAll}>
          <RefreshCw size={13} /> 刷新数据
        </button>
      </div>

      {/* Section 1: Channels Pool */}
      {section === "channels" && (
        <>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Server size={17} color="var(--primary)" /> 新增 / 热更新上游 Key 池渠道
              </h3>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              <input className="input" placeholder="渠道 ID" value={chId} onChange={(e) => setChId(e.target.value)} />
              <input className="input" placeholder="展示名称" value={chName} onChange={(e) => setChName(e.target.value)} />
              <select className="select" value={chProvider} onChange={(e) => setChProvider(e.target.value)}>
                <option value="gemini_openai">Google AI Studio (Gemini)</option>
                <option value="openrouter">OpenRouter</option>
                <option value="openai_compat">DeepSeek / OpenAI 兼容</option>
              </select>
              <input className="input" placeholder="Base URL" value={chBaseUrl} onChange={(e) => setChBaseUrl(e.target.value)} />
              <input className="input mono" type="password" placeholder="上游 API Key" value={chKey} onChange={(e) => setChKey(e.target.value)} />
              <input className="input" placeholder="支持模型 (逗号分隔)" value={chModels} onChange={(e) => setChModels(e.target.value)} />
            </div>
            <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={!hasAuth || busy} onClick={handleSaveChannel}>
              <Plus size={15} /> 热接入上游池
            </button>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">当前在线渠道池（{channels.length}）</h3>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>渠道 ID</th>
                    <th>供应商</th>
                    <th>Base URL</th>
                    <th>路由模型</th>
                    <th style={{ textAlign: "right" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.id}>
                      <td className="mono" style={{ fontWeight: 700 }}>{c.id}</td>
                      <td><span className="pill pill-user">{c.provider}</span></td>
                      <td className="mono">{c.base_url}</td>
                      <td style={{ fontSize: 12 }}>{c.meta.models.join(", ")}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={async () => {
                            await adminDeleteChannel(jwt, adminKey, c.id);
                            onToast(`已删除渠道 ${c.id}`);
                            loadAll();
                          }}
                        >
                          <Trash2 size={13} /> 删除
                        </button>
                      </td>
                    </tr>
                  ))}
                  {channels.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                        {hasAuth ? "暂无动态渠道" : "请先鉴权以查看上游渠道池"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Section 2: RBAC User Role Management */}
      {section === "users" && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <UserCog size={17} color="var(--primary)" /> 用户与 RBAC 权限管理（{users.length}）
            </h3>
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
              支持一键切换 普通用户 / VIP 会员（85折 + 20 Keys）/ 管理员 / 封禁状态
            </span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用户名</th>
                  <th>当前角色</th>
                  <th>折扣 / Key 上限</th>
                  <th>实付余额</th>
                  <th>状态</th>
                  <th style={{ textAlign: "right" }}>权限与操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username}>
                    <td style={{ fontWeight: 700 }}>{u.username}</td>
                    <td>
                      <span className={`pill pill-${u.policy.role}`}>
                        {u.policy.role === "vip" && <Crown size={12} />}
                        {u.policy.role.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      {u.policy.discount_pct > 0 ? `${100 - u.policy.discount_pct} 折` : "原价"} · 最多 {u.policy.max_keys} Keys
                    </td>
                    <td className="mono" style={{ fontWeight: 700 }}>{u.paid_credits}</td>
                    <td>
                      {u.policy.banned ? (
                        <span className="pill pill-danger">已封禁</span>
                      ) : (
                        <span className="pill pill-ok">正常</span>
                      )}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <select
                        className="select"
                        style={{ width: 112, display: "inline-block", marginRight: 6, padding: "4px 8px" }}
                        value={u.policy.role}
                        disabled={busy}
                        onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
                      >
                        <option value="user">普通用户</option>
                        <option value="vip">VIP 会员</option>
                        <option value="admin">管理员</option>
                      </select>
                      <button
                        className="btn btn-sm"
                        style={{ marginRight: 6 }}
                        disabled={busy}
                        onClick={() => handleQuickTopup(u.username)}
                      >
                        +500 积分
                      </button>
                      <button
                        className={`btn btn-sm ${u.policy.banned ? "btn-primary" : "btn-danger"}`}
                        disabled={busy}
                        onClick={() => handleRoleChange(u, u.policy.role, !u.policy.banned)}
                      >
                        <Ban size={13} /> {u.policy.banned ? "解封" : "封禁"}
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>
                      {hasAuth ? "暂无注册用户" : "请先鉴权以管理用户权限"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 3: Risk Control & Redemption Codes */}
      {section === "risk" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <ShieldAlert size={17} color="var(--danger)" /> 实时风控与 IP 封禁（tower_governor GCRA）
              </h3>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <span className="pill pill-danger">封禁 IP: {health?.risk?.blocked_ips ?? 0}</span>
              <span className="pill pill-warn">锁定 IP: {health?.risk?.locked_ips ?? 0}</span>
              <span className="pill pill-user">熔断 Key: {health?.risk?.frozen_keys ?? 0}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input mono"
                placeholder="输入 IPv4 / IPv6 地址"
                value={targetIp}
                onChange={(e) => setTargetIp(e.target.value)}
              />
              <button
                className="btn btn-danger"
                disabled={!hasAuth || busy}
                onClick={async () => {
                  try {
                    await adminIpAction(jwt, adminKey, "block_ip", targetIp.trim());
                    onToast(`已封禁 IP: ${targetIp}`);
                  } catch (e) {
                    onToast((e as Error).message);
                  }
                }}
              >
                封禁
              </button>
              <button
                className="btn"
                disabled={!hasAuth || busy}
                onClick={async () => {
                  try {
                    await adminIpAction(jwt, adminKey, "unblock_ip", targetIp.trim());
                    onToast(`已解封 IP: ${targetIp}`);
                  } catch (e) {
                    onToast((e as Error).message);
                  }
                }}
              >
                解封
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">
                <Gift size={17} color="var(--warning)" /> 批量生成实付兑换码
              </h3>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <input className="input" placeholder="数量" value={redCount} onChange={(e) => setRedCount(e.target.value)} />
              <input className="input" placeholder="面额积分" value={redCredits} onChange={(e) => setRedCredits(e.target.value)} />
              <input className="input" placeholder="前缀" value={redPrefix} onChange={(e) => setRedPrefix(e.target.value)} />
            </div>
            <button
              className="btn btn-primary"
              disabled={!hasAuth || busy}
              onClick={async () => {
                try {
                  const codes = await adminCreateRedemptions(jwt, adminKey, {
                    count: Math.max(1, Number(redCount) || 1),
                    credits: Math.max(1, Number(redCredits) || 100),
                    wallet_type: "paid",
                    prefix: redPrefix.trim() || "VIP",
                  });
                  setMintedCodes(codes);
                  onToast(`成功签发 ${codes.length} 张实付兑换码！`);
                } catch (e) {
                  onToast((e as Error).message);
                }
              }}
            >
              批量签发卡密
            </button>
            {mintedCodes.length > 0 && (
              <div className="code-box" style={{ marginTop: 12 }}>
                {mintedCodes.join("\n")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
