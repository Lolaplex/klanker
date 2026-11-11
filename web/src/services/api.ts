import {
  DesktopSettings,
  DiscoveredPeer,
  KlankerInstance,
  PendingApproval,
  ProcessStatus,
  TracePage,
} from "../types/klanker";
import { DEFAULT_SETTINGS } from "../openrouterModels";

const LS_INSTANCES = "klanker.instances";
const LS_SETTINGS = "klanker.settings";
const LS_ACTIVE = "klanker.active";

/** "" means same origin — the dashboard is served by the relay itself. */
const base = (inst: KlankerInstance): string =>
  (inst.endpoint?.base_url || inst.base_url || "").replace(/\/+$/, "");

function headers(inst: KlankerInstance, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const secret = (inst.secret || "").trim();
  if (secret) h["Authorization"] = `Bearer ${secret}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function req<T = any>(
  inst: KlankerInstance,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(base(inst) + path, { ...init });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = body;
    try {
      msg = JSON.parse(body).error || JSON.parse(body).detail || body;
    } catch {}
    throw new Error(`${res.status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    return body as unknown as T;
  }
}

const jsonReq = <T = any>(inst: KlankerInstance, path: string, body: object) =>
  req<T>(inst, path, { method: "POST", headers: headers(inst, true), body: JSON.stringify(body) });

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

const RELAY_501_NOTE = "Endpoint missing on this relay (requires agents-relay#12).";

export const api = {
  // --- settings (localStorage) -------------------------------------------

  async loadSettings(): Promise<DesktopSettings> {
    return load(LS_SETTINGS, { ...DEFAULT_SETTINGS });
  },

  async saveSettings(settings: DesktopSettings): Promise<DesktopSettings> {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    return settings;
  },

  // --- instances (localStorage) -------------------------------------------

  async listKlankers(): Promise<KlankerInstance[]> {
    let list: KlankerInstance[] = load(LS_INSTANCES, [] as KlankerInstance[]);
    if (!Array.isArray(list)) list = [];
    if (list.length === 0) {
      // Same-origin relay is the default instance: empty base_url + cookie auth.
      list = [localInstance()];
      localStorage.setItem(LS_INSTANCES, JSON.stringify(list));
    }
    return list;
  },

  async saveKlanker(inst: KlankerInstance): Promise<KlankerInstance> {
    const list = await this.listKlankers();
    const next = { ...inst, updated_at: new Date().toISOString() };
    const idx = list.findIndex((i) => i.id === inst.id);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    localStorage.setItem(LS_INSTANCES, JSON.stringify(list));
    return next;
  },

  async deleteKlanker(id: string): Promise<void> {
    const list = (await this.listKlankers()).filter((i) => i.id !== id);
    localStorage.setItem(LS_INSTANCES, JSON.stringify(list));
    if (localStorage.getItem(LS_ACTIVE) === id) localStorage.removeItem(LS_ACTIVE);
  },

  loadActiveId(): string | null {
    return localStorage.getItem(LS_ACTIVE);
  },
  saveActiveId(id: string | null): void {
    if (id) localStorage.setItem(LS_ACTIVE, id);
    else localStorage.removeItem(LS_ACTIVE);
  },

  // --- health / auth ------------------------------------------------------

  async getGatewayStatus(inst: KlankerInstance): Promise<ProcessStatus> {
    try {
      const res = await fetch(base(inst) + "/health", { headers: headers(inst) });
      if (!res.ok) throw new Error(String(res.status));
      return { is_running: true, port: 0, state: "running" };
    } catch {
      return { is_running: false, port: 0, state: "stopped", detail: "unreachable" };
    }
  },

  async authStatus(inst: KlankerInstance): Promise<{ authenticated: boolean; enabled: boolean; user: string }> {
    const r = await req<{ authenticated?: boolean; enabled?: boolean; user?: string }>(
      inst,
      "/v1/auth/status",
      { headers: headers(inst) }
    );
    return { authenticated: !!r.authenticated, enabled: !!r.enabled, user: r.user || "" };
  },

  /** Exchange RELAY_WEB_TOKEN for the HttpOnly cookie (same-origin). */
  async login(inst: KlankerInstance, token: string): Promise<void> {
    await jsonReq(inst, "/v1/auth/login", { token });
  },

  async logout(inst: KlankerInstance): Promise<void> {
    await jsonReq(inst, "/v1/auth/logout", {});
  },

  // --- workspaces / personas ----------------------------------------------

  async listWorkspaces(inst: KlankerInstance): Promise<{ id: string; label?: string }[]> {
    const r = await req<{ workspaces?: any[] }>(inst, "/v1/workspaces", { headers: headers(inst) });
    return (r.workspaces || []).map((w) => ({ id: w.id || w, label: w.label || w.name || w.id || w }));
  },

  async createWorkspace(inst: KlankerInstance, id: string): Promise<string> {
    const r = await jsonReq<{ workspace?: { id?: string } }>(inst, "/v1/workspaces", { id });
    return r.workspace?.id || id;
  },

  async listPersonas(inst: KlankerInstance, workspace: string): Promise<{ id: string; name?: string }[]> {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const r = await req<{ personas?: any[] }>(inst, `/v1/personas${q}`, { headers: headers(inst) });
    return (r.personas || []).map((p) => ({ id: p.id || p, name: p.name || p.id || p }));
  },

  /** Server-side sessions for (workspace, persona). */
  async listSessions(
    inst: KlankerInstance,
    workspace: string,
    persona: string
  ): Promise<{ id: string; created_at?: string; last_active?: string }[]> {
    try {
      const r = await req<{ sessions?: any[] }>(
        inst,
        `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/sessions`,
        { headers: headers(inst) }
      );
      return (r.sessions || []).map((s) => ({
        id: s.id || s.session || "",
        created_at: s.created_at,
        last_active: s.last_active || s.updated_at,
      }));
    } catch {
      return [];
    }
  },

  async deleteSession(
    inst: KlankerInstance,
    workspace: string,
    persona: string,
    session: string
  ): Promise<void> {
    await req(
      inst,
      `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/sessions/${encodeURIComponent(session)}`,
      { method: "DELETE", headers: headers(inst) }
    );
  },

  /** Session record + trace events; null when unknown. */
  async sessionEvents(
    inst: KlankerInstance,
    workspace: string,
    persona: string,
    session: string
  ): Promise<any[] | null> {
    try {
      const r = await req<{ session?: any; events?: any[] }>(
        inst,
        `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/sessions/${encodeURIComponent(session)}`,
        { headers: headers(inst) }
      );
      return r.events || [];
    } catch {
      return null;
    }
  },

  // --- chat ---------------------------------------------------------------

  /**
   * POST /v1/chat/stream — SSE over fetch. Yields relay events:
   * {type:"start",run} {type:"status"|"delta"|"error",text} {type:"trailer",session,user_id,returncode}
   */
  async *streamChat(
    inst: KlankerInstance,
    body: {
      text: string;
      run: string;
      session?: string;
      workspace?: string;
      persona?: string;
      provider?: string;
      new_session?: boolean;
    }
  ): AsyncGenerator<{ type: string; text?: string; run?: string; session?: string; user_id?: string; returncode?: number }> {
    const res = await fetch(base(inst) + "/v1/chat/stream", {
      method: "POST",
      headers: { ...headers(inst, true), Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const msg = await res.text().catch(() => "");
      throw new Error(`${res.status}${msg ? `: ${msg.slice(0, 300)}` : ""}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            yield JSON.parse(line.slice(5).trim());
          } catch {}
        }
      }
    }
  },

  async stopRun(inst: KlankerInstance, run: string): Promise<void> {
    await jsonReq(inst, "/v1/chat/stop", { run });
  },

  // --- approvals (agents-relay#12) -----------------------------------------

  async pendingApproval(inst: KlankerInstance): Promise<PendingApproval | null> {
    try {
      const ws = inst.workspace.trim();
      const q = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
      const r = await req<{ approvals?: PendingApproval[] }>(inst, `/v1/approvals${q}`, {
        headers: headers(inst),
      });
      return r.approvals?.[0] ?? null;
    } catch {
      return null;
    }
  },

  async resolveApproval(inst: KlankerInstance, approvalId: string, allow: boolean): Promise<void> {
    await jsonReq(inst, `/v1/approvals/${encodeURIComponent(approvalId)}`, { allow });
  },

  // --- traces (agents-relay#12) ---------------------------------------------

  async readRecentTraces(inst: KlankerInstance, limit = 40): Promise<TracePage> {
    const ws = inst.workspace.trim();
    try {
      const q = `?limit=${limit}${ws ? `&workspace=${encodeURIComponent(ws)}` : ""}`;
      const r = await req<{ lines?: string[]; note?: string }>(inst, `/v1/traces${q}`, {
        headers: headers(inst),
      });
      return { lines: r.lines || [], note: r.note || "traces" };
    } catch (e) {
      return { lines: [], note: `${RELAY_501_NOTE} (${e instanceof Error ? e.message : e})` };
    }
  },

  // --- not available in the browser -----------------------------------------

  async discoverPeers(): Promise<DiscoveredPeer[]> {
    return [];
  },
};

export function localInstance(): KlankerInstance {
  const now = new Date().toISOString();
  const host = (window.location.hostname.split(".")[0] || "klanker").toLowerCase();
  return {
    id: "local",
    name: host === "localhost" || host === "127" ? "klanker" : host,
    slug: "local",
    role: "",
    provider: "",
    model: "",
    workspace: "",
    lock_workspace: false,
    port: 0,
    system_prompt: "",
    kind: "remote",
    endpoint: { base_url: "" },
    created_at: now,
    updated_at: now,
  };
}
