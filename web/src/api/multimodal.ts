import { API_BASE } from "../api";

const MOSS_API = "/api/moss";

export type ReviewStatus = "private" | "pending" | "approved" | "rejected";

export interface MossStatusResp {
  ok: boolean;
  workers_online: number;
  cloud_ready?: boolean;
  queue?: { queued: number; running: number; done: number };
}

export interface MossJob {
  id: string;
  status: "queued" | "running" | "done" | "error";
  model?: string;
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  progress: number;
  progress_text: string;
  image_url?: string;
  elapsed_s?: number;
  error?: string;
  queue_position?: number;
}

export interface GalleryItem extends MossJob {
  title: string;
  description: string;
  hidden: boolean;
  source: string;
  owner_id: string;
  owner_role: string;
  source_channel: string;
  review_status: ReviewStatus;
  review_note: string;
  thumb_url?: string;
}

export interface GalleryListResp {
  ok: boolean;
  items: GalleryItem[];
  total: number;
  page: number;
  page_size: number;
  error?: string;
}

export interface MossJobPayload {
  model: string;
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  steps: number;
  guidance_scale: number;
  seed: number;
  strength: number;
  init_image_base64?: string;
  init_image_url?: string;
}

export interface SpeechResp {
  ok: boolean;
  format: string;
  mime_type: string;
  voice: string;
  audio_base64: string;
}

export interface VideoStartResp {
  ok: boolean;
  status: string;
  operation: string;
}

function mossHeaders(jwt: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (jwt.trim()) h.Authorization = `Bearer ${jwt.trim()}`;
  return h;
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }
  return data;
}

export async function fetchMossStatus(): Promise<MossStatusResp> {
  const res = await fetch(`${MOSS_API}/status`, { credentials: "include" });
  return parseJson<MossStatusResp>(res);
}

export async function submitMossJob(jwt: string, payload: MossJobPayload): Promise<{ ok: boolean; job: MossJob }> {
  const res = await fetch(`${MOSS_API}/jobs`, {
    method: "POST",
    credentials: "include",
    headers: mossHeaders(jwt, { "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return parseJson<{ ok: boolean; job: MossJob }>(res);
}

export async function pollMossJob(jobId: string): Promise<{ ok: boolean; job: MossJob }> {
  const res = await fetch(`${MOSS_API}/jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
  return parseJson<{ ok: boolean; job: MossJob }>(res);
}

export async function expandMossPrompt(prompt: string, model: string): Promise<{ ok: boolean; prompt: string }> {
  const res = await fetch(`${MOSS_API}/expand-prompt`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });
  return parseJson<{ ok: boolean; prompt: string }>(res);
}

export async function reverseMossPrompt(input: {
  style: string;
  image_base64?: string;
  image_url?: string;
}): Promise<{ ok: boolean; prompt: string; elapsed_s?: number; model?: string }> {
  const res = await fetch(`${MOSS_API}/reverse-prompt`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseJson(res);
}

export async function fetchGallery(jwt: string, scope: "public" | "personal"): Promise<GalleryListResp> {
  const path = scope === "personal" ? "/me/gallery" : "/gallery";
  const res = await fetch(`${MOSS_API}${path}`, {
    credentials: "include",
    headers: mossHeaders(jwt),
  });
  return parseJson<GalleryListResp>(res);
}

export async function submitGalleryForReview(jwt: string, id: string, autoApprove: boolean): Promise<void> {
  const res = await fetch(`${MOSS_API}/me/gallery/${encodeURIComponent(id)}/submit`, {
    method: "POST",
    credentials: "include",
    headers: mossHeaders(jwt, { "Content-Type": "application/json" }),
    body: JSON.stringify({ auto_approve: autoApprove }),
  });
  await parseJson(res);
}

export async function deletePersonalGalleryItem(jwt: string, id: string): Promise<void> {
  const res = await fetch(`${MOSS_API}/me/gallery/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
    headers: mossHeaders(jwt),
  });
  await parseJson(res);
}

export async function fetchAdminGallery(
  jwt: string,
  params: { q: string; status: string; page: number },
): Promise<GalleryListResp> {
  const qs = new URLSearchParams({ q: params.q, status: params.status, page: String(params.page) });
  const res = await fetch(`${MOSS_API}/admin/gallery?${qs.toString()}`, {
    credentials: "include",
    headers: mossHeaders(jwt),
  });
  return parseJson<GalleryListResp>(res);
}

export async function reviewAdminGalleryItem(
  jwt: string,
  id: string,
  action: "approve" | "reject" | "unpublish",
): Promise<void> {
  const res = await fetch(`${MOSS_API}/admin/gallery/${encodeURIComponent(id)}/review`, {
    method: "POST",
    credentials: "include",
    headers: mossHeaders(jwt, { "Content-Type": "application/json" }),
    body: JSON.stringify({ action }),
  });
  await parseJson(res);
}

export async function callRelaySpeech(
  apiKey: string,
  req: { model: string; input: string; voice: string; response_format: "wav" },
): Promise<SpeechResp> {
  const res = await fetch(`${API_BASE}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify(req),
  });
  return parseJson<SpeechResp>(res);
}

export async function callRelayMusic(
  apiKey: string,
  req: { model: string; prompt: string; duration_sec: number },
): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`${API_BASE}/v1/music/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify(req),
  });
  return parseJson(res);
}

export async function startRelayVideo(
  apiKey: string,
  req: { model: string; prompt: string; aspect_ratio: string; duration_sec: number },
): Promise<VideoStartResp> {
  const res = await fetch(`${API_BASE}/v1/videos/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
    body: JSON.stringify(req),
  });
  return parseJson<VideoStartResp>(res);
}

export async function pollRelayVideo(apiKey: string, operation: string): Promise<Record<string, unknown>> {
  const clean = operation.replace(/^\/+/, "");
  const res = await fetch(`${API_BASE}/v1/videos/operations/${clean}`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });
  return parseJson<Record<string, unknown>>(res);
}
