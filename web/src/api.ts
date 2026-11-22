// Strictly typed API contract matching relay-core (zero `any`, zero-trust client)

export interface ModelItem {
  id: string;
  owned_by: string;
  input_per_m: number;
  output_per_m: number;
  allow_free: boolean;
}

export interface RiskStats {
  blocked_ips: number;
  locked_ips: number;
  frozen_keys: number;
  rate_limiter: string;
}

export interface HealthResp {
  ok: boolean;
  service: string;
  license: string;
  models_count: number;
  risk: RiskStats;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatReq {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  max_tokens?: number;
}

export interface KeyScope {
  allowed_models: string[];
  allowed_ips: string;
  expired_unix: number;
  group_name: string;
}

export interface KeyIssueReq {
  name: string;
  quota_limit: number;
  rpm_limit: number;
  scope: KeyScope;
}

export interface ChannelUpsertReq {
  id: string;
  provider: string;
  endpoint: { name: string; base_url: string; api_key: string };
  routing: { models: string[]; priority: number; weight: number; enabled: boolean };
}

export interface KeyIssueResp {
  ok: boolean;
  api_key: string;
}

export interface WalletInfo {
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

export interface MeResp {
  ok: boolean;
  wallet: WalletInfo;
  keys: ApiKeyItem[];
  usage: UsageItem[];
  referral_code: string;
}

const API_BASE = (import.meta.env.VITE_RELAY_API as string | undefined) ?? "";

async function parseJsonOrThrow<T>(r: Response): Promise<T> {
  const data = (await r.json()) as T & { message?: string; detail?: string };
  if (!r.ok) {
    throw new Error(data.message ?? data.detail ?? `HTTP ${r.status}`);
  }
  return data;
}

export async function fetchHealth(): Promise<HealthResp> {
  return parseJsonOrThrow<HealthResp>(await fetch(`${API_BASE}/api/v1/health`));
}

export async function fetchModels(): Promise<ModelItem[]> {
  const d = await parseJsonOrThrow<{ data: ModelItem[] }>(await fetch(`${API_BASE}/v1/models`));
  return d.data;
}

export async function sendChat(apiKey: string, req: ChatReq): Promise<string> {
  const r = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify(req),
  });
  const d = await parseJsonOrThrow<{ choices?: Array<{ message?: { content?: string } }> }>(r);
  return d.choices?.[0]?.message?.content ?? "";
}

export async function issueSubKey(portalToken: string, req: KeyIssueReq): Promise<KeyIssueResp> {
  const r = await fetch(`${API_BASE}/api/v1/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${portalToken.trim()}` },
    body: JSON.stringify(req),
  });
  return parseJsonOrThrow<KeyIssueResp>(r);
}

export async function fetchMe(portalToken: string): Promise<MeResp> {
  const r = await fetch(`${API_BASE}/api/v1/me`, {
    headers: { Authorization: `Bearer ${portalToken.trim()}` },
  });
  return parseJsonOrThrow<MeResp>(r);
}

export async function revokeSubKey(portalToken: string, keyId: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/v1/keys/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${portalToken.trim()}` },
    body: JSON.stringify({ key_id: keyId }),
  });
  await parseJsonOrThrow<{ ok: boolean }>(r);
}

export async function redeemCode(portalToken: string, code: string): Promise<{ credits: number; wallet_type: string }> {
  const r = await fetch(`${API_BASE}/api/v1/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${portalToken.trim()}` },
    body: JSON.stringify({ code: code.trim() }),
  });
  return parseJsonOrThrow<{ credits: number; wallet_type: string }>(r);
}

export async function upsertChannel(adminKey: string, req: ChannelUpsertReq): Promise<void> {
  const r = await fetch(`${API_BASE}/api/v1/admin/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey.trim() },
    body: JSON.stringify(req),
  });
  await parseJsonOrThrow<{ ok: boolean }>(r);
}

export interface ChannelItem {
  id: string;
  provider: string;
  base_url: string;
  meta: { name: string; models: string[]; priority: number; enabled: boolean };
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
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow<{ token: string; username: string }>(r);
}

export async function listChannels(adminKey: string): Promise<ChannelItem[]> {
  const r = await fetch(`${API_BASE}/api/v1/admin/channels`, {
    headers: { "X-Admin-Key": adminKey.trim() },
  });
  const d = await parseJsonOrThrow<{ channels: ChannelItem[] }>(r);
  return d.channels;
}

export async function deleteChannel(adminKey: string, id: string): Promise<void> {
  const r = await fetch(`${API_BASE}/api/v1/admin/channels/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Admin-Key": adminKey.trim() },
  });
  await parseJsonOrThrow<{ ok: boolean }>(r);
}

export async function transferAffiliate(portalToken: string): Promise<number> {
  const r = await fetch(`${API_BASE}/api/v1/affiliate/transfer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${portalToken.trim()}` },
  });
  const d = await parseJsonOrThrow<{ transferred: number }>(r);
  return d.transferred;
}

export async function toggleBlockIp(
  adminKey: string,
  ip: string,
  action: "block" | "unblock",
): Promise<void> {
  const path = action === "block" ? "/api/v1/admin/risk/block_ip" : "/api/v1/admin/risk/unblock_ip";
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey.trim() },
    body: JSON.stringify({ ip: ip.trim() }),
  });
  await parseJsonOrThrow<{ ok: boolean }>(r);
}
