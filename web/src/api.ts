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
  active_ip_windows: number;
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

export interface KeyIssueReq {
  name: string;
  quota_limit: number;
  rpm_limit: number;
  allowed_models: string[];
}

export interface KeyIssueResp {
  ok: boolean;
  api_key: string;
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
