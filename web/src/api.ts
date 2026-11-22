export const API_BASE =
  (import.meta.env.VITE_RELAY_API as string | undefined) ||
  (window.location.pathname.startsWith("/relay") ? "/relay" : "");

export type UserRole = "guest" | "user" | "vip" | "admin";

export interface UserRolePolicy {
  role: UserRole;
  max_keys: number;
  discount_pct: number;
  banned: boolean;
}

export interface ModelItem {
  id: string;
  object: string;
  owned_by: string;
  input_per_m: number;
  output_per_m: number;
  allow_free: boolean;
}

export interface RiskStats {
  blocked_ips: number;
  locked_ips: number;
  frozen_keys: number;
  rate_limiter?: string;
}

export interface HealthResp {
  ok: boolean;
  service: string;
  license: string;
  models_count: number;
  risk: RiskStats;
}

export interface UserWallet {
  username: string;
  paid_credits: number;
  bonus_credits: number;
  affiliate_credits: number;
}

export interface ApiKeyItem {
  id: string;
  username: string;
  quota_limit: number;
  used_credits: number;
}

export interface UsageItem {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  credits_charged: number;
}

export interface UsageLogItem {
  model: string;
  tokens: number;
  credits: number;
  created_at: number;
}

export interface MeResp {
  ok: boolean;
  authenticated: boolean;
  role: UserRole;
  policy: UserRolePolicy;
  permissions: string[];
  wallet?: UserWallet;
  keys?: ApiKeyItem[];
  usage?: UsageItem[];
  referral_code?: string;
}

export interface DashboardStatsResp {
  ok: boolean;
  stats: {
    total_requests: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_credits_charged: number;
  };
  risk: RiskStats;
}

export interface ChannelItem {
  id: string;
  provider: string;
  base_url: string;
  meta: { name: string; models: string[]; priority: number; enabled: boolean };
}

export interface AdminUserSummary {
  username: string;
  policy: UserRolePolicy;
  paid_credits: number;
  bonus_credits: number;
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

async function parseJson<T>(r: Response): Promise<T> {
  const txt = await r.text();
  let data: unknown = {};
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    if (!r.ok) throw new Error(txt || `HTTP ${r.status}`);
  }
  if (!r.ok) {
    const err = data as { message?: string; detail?: string; error?: string };
    throw new Error(err.message || err.detail || err.error || `HTTP ${r.status}`);
  }
  return data as T;
}

function adminHeaders(jwt: string, adminKey: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (adminKey.trim()) h["X-Admin-Key"] = adminKey.trim();
  if (jwt.trim()) h["Authorization"] = `Bearer ${jwt.trim()}`;
  return h;
}

export async function fetchHealth(): Promise<HealthResp> {
  return parseJson(await fetch(`${API_BASE}/api/v1/health`));
}

export async function fetchModels(): Promise<ModelItem[]> {
  const d = await parseJson<{ data: ModelItem[] }>(await fetch(`${API_BASE}/v1/models`));
  return d.data || [];
}

export async function fetchMe(jwt: string): Promise<MeResp> {
  const headers: Record<string, string> = {};
  if (jwt.trim()) headers["Authorization"] = `Bearer ${jwt.trim()}`;
  return parseJson(await fetch(`${API_BASE}/api/v1/me`, { headers }));
}

export async function fetchDashboardStats(jwt: string): Promise<DashboardStatsResp> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/dashboard/stats`, {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
  );
}

export async function fetchUsageLogs(jwt: string, adminKey = ""): Promise<{ scope: string; logs: UsageLogItem[] }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/logs`, {
      headers: adminHeaders(jwt, adminKey),
    }),
  );
}

export async function portalAuth(
  mode: "login" | "register",
  username: string,
  password: string,
): Promise<{ token: string; username: string }> {
  const path = mode === "register" ? "/studio/api/register" : "/studio/api/login";
  const body =
    mode === "register"
      ? { username, password, email: `${username}@lain42.top` }
      : { username, password };
  const d = await parseJson<{ token?: string; data?: { token?: string }; username?: string }>(
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const token = d.token || d.data?.token || "";
  if (!token) throw new Error("未返回登录令牌");
  return { token, username: d.username || username };
}

export async function issueApiKey(
  jwt: string,
  payload: { name: string; quota_limit: number; rpm_limit: number; allowed_ips: string },
): Promise<{ api_key: string; key: ApiKeyItem }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        name: payload.name,
        quota_limit: payload.quota_limit,
        rpm_limit: payload.rpm_limit,
        scope: {
          allowed_models: [],
          allowed_ips: payload.allowed_ips,
          expired_unix: 0,
          group_name: "default",
        },
      }),
    }),
  );
}

export async function revokeApiKey(jwt: string, keyId: string): Promise<void> {
  await parseJson(
    await fetch(`${API_BASE}/api/v1/keys/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ key_id: keyId }),
    }),
  );
}

export async function redeemCode(jwt: string, code: string): Promise<{ credits: number; wallet_type: string }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ code }),
    }),
  );
}

export async function bindAffiliate(jwt: string, referrer: string): Promise<void> {
  await parseJson(
    await fetch(`${API_BASE}/api/v1/affiliate/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ referrer }),
    }),
  );
}

export async function transferAffiliate(jwt: string): Promise<{ transferred: number }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/affiliate/transfer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    }),
  );
}

export async function sendChat(
  apiKey: string,
  model: string,
  messages: ChatTurn[],
  maxTokens: number,
): Promise<{ reply: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }> {
  const d = await parseJson<{
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  }>(
    await fetch(`${API_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens }),
    }),
  );
  return {
    reply: d.choices?.[0]?.message?.content || "(空回复)",
    usage: d.usage,
  };
}

export async function sendChatStream(
  apiKey: string,
  model: string,
  messages: ChatTurn[],
  maxTokens: number,
  callbacks: {
    onDelta: (text: string) => void;
    onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const r = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens }),
    signal: callbacks.signal,
  });
  if (!r.ok) {
    const txt = await r.text();
    let msg = txt || `HTTP ${r.status}`;
    try {
      const j = JSON.parse(txt);
      msg = j.message || j.detail || j.error || msg;
    } catch {
      // plain text error
    }
    throw new Error(msg);
  }
  if (!r.body) throw new Error("浏览器不支持 ReadableStream");
  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          callbacks.onDelta(delta);
        }
        if (j.usage && typeof j.usage === "object" && callbacks.onUsage) {
          const p = Number(j.usage.prompt_tokens || 0);
          const c = Number(j.usage.completion_tokens || 0);
          const t = Number(j.usage.total_tokens || p + c);
          if (t > 0) callbacks.onUsage({ prompt_tokens: p, completion_tokens: c, total_tokens: t });
        }
      } catch {
        // ignore partial json
      }
    }
  }
}

// Admin APIs (supports either Admin JWT OR X-Admin-Key)
export async function adminListChannels(jwt: string, adminKey: string): Promise<ChannelItem[]> {
  const d = await parseJson<{ channels: ChannelItem[] }>(
    await fetch(`${API_BASE}/api/v1/admin/channels`, { headers: adminHeaders(jwt, adminKey) }),
  );
  return d.channels || [];
}

export async function adminUpsertChannel(
  jwt: string,
  adminKey: string,
  payload: {
    id: string;
    provider: string;
    endpoint: { name: string; base_url: string; api_key: string };
    routing: { models: string[]; priority: number; weight: number; enabled: boolean };
  },
): Promise<void> {
  await parseJson(
    await fetch(`${API_BASE}/api/v1/admin/channels`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
      body: JSON.stringify(payload),
    }),
  );
}

export async function adminDeleteChannel(jwt: string, adminKey: string, id: string): Promise<void> {
  await parseJson(
    await fetch(`${API_BASE}/api/v1/admin/channels/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: adminHeaders(jwt, adminKey),
    }),
  );
}

export async function adminListUsers(jwt: string, adminKey: string): Promise<AdminUserSummary[]> {
  const d = await parseJson<{ users: AdminUserSummary[] }>(
    await fetch(`${API_BASE}/api/v1/admin/users`, { headers: adminHeaders(jwt, adminKey) }),
  );
  return d.users || [];
}

export async function adminUpdateUserRole(
  jwt: string,
  adminKey: string,
  payload: { username: string; role: UserRole; discount_pct?: number; banned?: boolean },
): Promise<{ policy: UserRolePolicy }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/admin/users/role`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
      body: JSON.stringify(payload),
    }),
  );
}

export async function adminTopupUser(
  jwt: string,
  adminKey: string,
  payload: { order_id: string; username: string; credits: number },
): Promise<void> {
  await parseJson(
    await fetch(`${API_BASE}/api/v1/admin/topup`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
      body: JSON.stringify(payload),
    }),
  );
}

export async function adminCreateRedemptions(
  jwt: string,
  adminKey: string,
  payload: { count: number; credits: number; wallet_type: string; prefix: string },
): Promise<string[]> {
  const d = await parseJson<{ codes: string[] }>(
    await fetch(`${API_BASE}/api/v1/admin/redemptions`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
      body: JSON.stringify(payload),
    }),
  );
  return d.codes || [];
}

export async function adminIpAction(
  jwt: string,
  adminKey: string,
  action: "block_ip" | "unblock_ip",
  ip: string,
): Promise<void> {
  await parseJson(
    await fetch(`${API_BASE}/api/v1/admin/risk/${action}`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
      body: JSON.stringify({ ip }),
    }),
  );
}
