import type { KlankerInstance } from "../types/klanker";
import { apiFetch, apiJson, apiRequest } from "./api";

export type VoiceTranscribeResult =
  | { ok: true; text: string }
  | { ok: false; unavailable: boolean; error: string };

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body) as { error?: string; detail?: string };
    return j.error || j.detail || body || `${res.status}`;
  } catch {
    return body || `${res.status}`;
  }
}

/** POST /v1/voice/transcribe. 503 is a feature-state, not an exception. */
export async function transcribeVoice(inst: KlankerInstance, audio: Blob): Promise<VoiceTranscribeResult> {
  const res = await apiFetch(inst, "/v1/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": audio.type || "application/octet-stream" },
    body: audio,
  });
  if (res.status === 503) return { ok: false, unavailable: true, error: await errorText(res) };
  if (!res.ok) return { ok: false, unavailable: false, error: await errorText(res) };
  const j = (await res.json().catch(() => ({}))) as { text?: string };
  return { ok: true, text: j.text || "" };
}

/** POST /v1/voice/speak. Null means unavailable/unconfigured (503). */
export async function speakVoice(inst: KlankerInstance, text: string): Promise<Blob | null> {
  const res = await apiFetch(inst, "/v1/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (res.status === 503) return null;
  if (!res.ok) throw new Error(await errorText(res));
  return res.blob();
}

/** POST /v1/inject's measured relay contract: numeric ``chat_id`` plus
 * ``text``. Session/workspace keys are not sent — current relays ignore them
 * for routing and concatenate unknown keys into the injected prompt. */
export async function injectSteer(
  inst: KlankerInstance,
  body: { session: string; text: string; workspace?: string; persona?: string; user?: string }
): Promise<unknown> {
  const chatId = String(body.user || "").trim();
  if (!/^\d+$/.test(chatId)) {
    throw new Error("steer unavailable: /v1/inject requires a numeric chat_id");
  }
  return apiJson(inst, "/v1/inject", {
    chat_id: Number(chatId),
    text: body.text,
  });
}

export async function forkSession(
  inst: KlankerInstance,
  body: { workspace: string; source_session: string; new_session?: string }
): Promise<{ ok?: boolean; session?: string; source_session?: string; workspace?: string }> {
  return apiJson(inst, "/v1/klanker/sessions/fork", {
    workspace: body.workspace,
    source_session: body.source_session,
    source: body.source_session,
    new_session: body.new_session,
  });
}

export type WorkspaceFileEntry = { name: string; path: string; kind?: string; bytes?: number };

export async function listWorkspaceFiles(
  inst: KlankerInstance,
  workspace: string,
  path = "."
): Promise<WorkspaceFileEntry[]> {
  const q = `workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`;
  const r = await apiRequest<{ entries?: Record<string, unknown>[] }>(inst, `/v1/klanker/files?${q}`);
  return (r.entries || []).map((e) => ({
    name: String(e.name || ""),
    path: String(e.path || e.name || ""),
    kind: String(e.kind || e.type || ""),
    bytes: typeof e.bytes === "number" ? e.bytes : typeof e.size === "number" ? (e.size as number) : undefined,
  })).filter((e) => e.path);
}

/** Force host provider re-probe. Listeners may consume the broadcast rows;
 * the next regular provider poll also sees the refreshed host state. */
export async function refreshProviders(inst: KlankerInstance): Promise<unknown> {
  const rows = await apiRequest(inst, "/v1/providers?refresh=1");
  window.dispatchEvent(new CustomEvent("klanker:providers-refreshed", { detail: rows }));
  return rows;
}
