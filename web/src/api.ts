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

export type BillingMode = "token" | "per_call" | "per_second";

export interface ModelItem {
  id: string;
  object: string;
  owned_by: string;
  input_per_m: number;
  output_per_m: number;
  allow_free: boolean;
  billing_mode?: BillingMode;
  unit_credits?: number;
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

export interface TrialCardItem {
  id: string;
  title: string;
  spec: string;
  expires_unix: number;
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
  trial_cards?: TrialCardItem[];
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

export interface ChannelPolicy {
  model_mapping: Record<string, string>;
  daily_limit: number;
}

export interface ChannelItem {
  id: string;
  provider: string;
  base_url: string;
  meta: { name: string; models: string[]; priority: number; enabled: boolean };
  policy?: ChannelPolicy;
}

export interface AsyncTaskRecord {
  id: string;
  status: string;
  meta: {
    username: string;
    task_type: string;
    model: string;
    provider_op: string;
  };
  result: {
    credits_charged: number;
    result_json: string;
    created_unix: number;
    updated_unix: number;
  };
}

export interface AdminUserSummary {
  username: string;
  policy: UserRolePolicy;
  paid_credits: number;
  bonus_credits: number;
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MultimodalChatTurn {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export interface YsmPersonaInput {
  name?: string;
  personality?: string;
  outfit_notes?: string;
  proportions?: "standard" | "slim" | "chibi" | "tall" | "";
}

export interface YsmReferenceInput {
  turnaround_images?: string[];
  ref_model_name?: string;
  ref_model_summary?: string;
  pipeline?: "fast" | "head_first" | "studio_refine";
}

export interface YsmCatalogItem {
  id: string;
  source: string;
  source_label: string;
  title: string;
  description: string;
  authors: string[];
  downloads: number;
  rating: number;
  free: boolean;
  license: string;
  tags: string[];
  cover_url: string;
  download_url: string;
  homepage_url: string;
}

export interface YsmCatalogResp {
  ok: boolean;
  total: number;
  region_country?: string;
  nsfw_filtered?: boolean;
  sources_used: string[];
  items: YsmCatalogItem[];
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
  const path = `${API_BASE}/api/v1/auth/${mode}`;
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

export async function activateTrialCard(
  jwt: string,
  cardId: string,
): Promise<{ card_id: string; expires_unix: number }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/trial-cards/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ card_id: cardId }),
    }),
  );
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
  messages: MultimodalChatTurn[],
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
    endpoint: { name: string; base_url: string; api_key: string; policy?: ChannelPolicy };
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

export async function adminUpsertModelPricing(
  jwt: string,
  adminKey: string,
  payload: {
    model_id: string;
    billing_mode: BillingMode;
    rates: {
      input_per_m: number;
      output_per_m: number;
      unit_credits: number;
      allow_free: boolean;
    };
  },
): Promise<{ warnings: string[] }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/admin/models/pricing`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
      body: JSON.stringify(payload),
    }),
  );
}

export async function adminResetModelPricing(
  jwt: string,
  adminKey: string,
  modelId: string,
): Promise<void> {
  await parseJson(
    await fetch(`${API_BASE}/api/v1/admin/models/pricing/${encodeURIComponent(modelId)}`, {
      method: "DELETE",
      headers: adminHeaders(jwt, adminKey),
    }),
  );
}

export async function fetchAsyncTasks(
  jwt: string,
  adminKey = "",
): Promise<{ scope: string; tasks: AsyncTaskRecord[] }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/tasks`, {
      headers: adminHeaders(jwt, adminKey),
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

export interface ChannelProbeResp {
  ok: boolean;
  latency_ms: number;
  models_count: number;
  balance_text: string;
}

export async function adminProbeChannel(
  jwt: string,
  adminKey: string,
  id: string,
): Promise<ChannelProbeResp> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/admin/channels/${encodeURIComponent(id)}/probe`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
    }),
  );
}

export interface ImageGenResp {
  data?: { url?: string; b64_json?: string; revised_prompt?: string }[];
}

export interface YsmGenResult {
  file: File;
  blob: Blob;
  filename: string;
}

function extractFilenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const utf8Match = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      // ignore malformed URI encoding
    }
  }
  const basicMatch = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return basicMatch?.[1]?.trim() || null;
}

function formatYsmApiError(status: number, bodyText: string): string {
  let code = "";
  let message = "";
  let detail = "";

  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as {
        code?: string;
        message?: string;
        detail?: string;
        error?: string | { message?: string; code?: string };
      };
      code = parsed.code || (typeof parsed.error === "object" ? parsed.error?.code || "" : "");
      message =
        parsed.message ||
        (typeof parsed.error === "object"
          ? parsed.error?.message || ""
          : typeof parsed.error === "string"
            ? parsed.error
            : "");
      detail = parsed.detail || "";
    } catch {
      detail = bodyText
        .trim()
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 220);
    }
  }

  const combined = [message, detail && detail !== message ? detail : ""].filter(Boolean).join(" — ");

  if (status === 401 || code === "unauthorized") {
    return combined || "API Key 无效或缺失，请填写有效的 Bearer Token（sk-l42-...）";
  }
  if (status === 402 || code === "insufficient_paid") {
    return combined || "实付积分不足，请切换到免费文本模型或前往钱包充值";
  }
  if (status === 400 || code === "invalid_input") {
    return combined || "请求参数无效（提示词长度需在 1～4000 字符之间）";
  }
  if (status === 403 || code === "forbidden" || code === "ip_blocked" || code === "drain_guard") {
    return combined || "当前密钥或 IP 无权调用该模型，请检查权限设置";
  }
  if (status === 404 || code === "model_not_found") {
    return combined || "所选文本模型不存在或暂不可用，请更换其他文本模型";
  }
  if (status === 429 || code === "rate_limited") {
    return combined || "请求过于频繁，触发限流，请稍后再试";
  }
  if (status === 502 || code === "upstream_failed") {
    return combined || "上游模型未能返回可用的 YSM 设计，建议切换更强的文本模型或细化角色描述后重试";
  }
  return combined || `YSM 生成请求失败 (HTTP ${status})`;
}

export async function fetchYsmCatalog(params: {
  source?: "all" | "lain42" | "alltheysm" | "custom";
  q?: string;
  sort?: "downloads" | "featured" | "newest";
  freeOnly?: boolean;
  page?: number;
  limit?: number;
  customSource?: string;
}): Promise<YsmCatalogResp> {
  const qs = new URLSearchParams();
  if (params.source) qs.set("source", params.source);
  if (params.q?.trim()) qs.set("q", params.q.trim());
  if (params.sort) qs.set("sort", params.sort);
  if (params.freeOnly) qs.set("free_only", "true");
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.customSource?.trim()) qs.set("custom_source", params.customSource.trim());
  return parseJson(await fetch(`${API_BASE}/api/v1/ysm/catalog?${qs.toString()}`));
}

export async function generateYsmPackage(
  apiKey: string,
  payload: {
    model: string;
    prompt: string;
    persona?: YsmPersonaInput;
    reference?: YsmReferenceInput;
  },
  signal?: AbortSignal,
): Promise<YsmGenResult> {
  const body: Record<string, unknown> = {
    model: payload.model,
    prompt: payload.prompt,
  };
  if (payload.persona) body.persona = payload.persona;
  if (payload.reference) body.reference = payload.reference;

  const res = await fetch(`${API_BASE}/v1/ysm/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey.trim()}`,
      Accept: "application/zip, application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(formatYsmApiError(res.status, errText));
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const isPkZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (!isPkZip) {
    const text = new TextDecoder("utf-8").decode(bytes);
    if (contentType.includes("json") || text.trim().startsWith("{")) {
      throw new Error(formatYsmApiError(res.status, text));
    }
    throw new Error(
      `服务端未返回有效的 application/zip 模型包（Content-Type: ${contentType || "unknown"}，${bytes.length} 字节）`,
    );
  }

  const filename = extractFilenameFromDisposition(res.headers.get("content-disposition")) || "character-ysm.zip";
  const blob = new Blob([buf], { type: "application/zip" });
  const file = new File([blob], filename, { type: "application/zip" });
  return { file, blob, filename };
}

export async function generateImage(
  apiKey: string,
  payload: { model: string; prompt: string; size?: string; n?: number },
): Promise<ImageGenResp> {
  return parseJson(
    await fetch(`${API_BASE}/v1/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    }),
  );
}

export interface SyncModelsResp {
  ok: boolean;
  synced_channels: number;
  added_models: number;
  total_models: number;
}

export async function adminSyncModels(jwt: string, adminKey: string): Promise<SyncModelsResp> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/admin/models/sync`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
    }),
  );
}

export async function adminMintResellKeys(
  jwt: string,
  adminKey: string,
  payload: { count: number; quota_credits: number; batch_name: string; expires_days: number },
): Promise<{ count: number; quota_credits: number; keys: string[] }> {
  return parseJson(
    await fetch(`${API_BASE}/api/v1/admin/resell/keys`, {
      method: "POST",
      headers: adminHeaders(jwt, adminKey),
      body: JSON.stringify(payload),
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
