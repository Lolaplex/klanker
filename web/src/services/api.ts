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

const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Invoke a Tauri command; throws on non-desktop. */
const invoke = <T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const core = (window as any).__TAURI__?.core;
  if (!core?.invoke) return Promise.reject(new Error("not a tauri host"));
  return core.invoke(cmd, args);
};

/** Capability flags: desktop (Tauri) gets spawn/keyring/updates; web/PWA does not. */
export const caps = {
  localFs: isTauri(),
  spawn: isTauri(),
  keyring: isTauri(),
  updates: isTauri(),
} as const;

/** OS notification — works on desktop webview and (with permission) in browsers. */
export async function notify(title: string, body = ""): Promise<void> {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      if ((await Notification.requestPermission()) === "granted") {
        new Notification(title, { body });
      }
    }
  } catch {}
}

export const api = {
  // --- settings (localStorage) -------------------------------------------

  async loadSettings(): Promise<DesktopSettings> {
    const s = load(LS_SETTINGS, { ...DEFAULT_SETTINGS });
    if (caps.keyring) {
      try {
        const key = await this.secretGet("openrouter");
        s.openrouter_api_key = key || "";
        s.openrouter_key_set = !!key;
      } catch {}
    }
    return s;
  },

  async saveSettings(settings: DesktopSettings): Promise<DesktopSettings> {
    if (caps.keyring) {
      const key = settings.openrouter_api_key.trim();
      try {
        if (key) await this.secretSet("openrouter", key);
      } catch {}
      localStorage.setItem(
        LS_SETTINGS,
        JSON.stringify({ ...settings, openrouter_api_key: "", openrouter_key_set: !!key || settings.openrouter_key_set })
      );
      return settings;
    }
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    return settings;
  },

  // --- instances (localStorage) -------------------------------------------

  async listKlankers(): Promise<KlankerInstance[]> {
    let list: KlankerInstance[] = load(LS_INSTANCES, [] as KlankerInstance[]);
    if (!Array.isArray(list)) list = [];
    if (list.length === 0) {
      // Web/PWA: the same-origin relay is the default instance.
      // Desktop: the managed local serve at 127.0.0.1:8787 (spawned by the shell).
      list = [caps.spawn ? desktopLocalInstance() : localInstance()];
      localStorage.setItem(LS_INSTANCES, JSON.stringify(list));
    }
    if (caps.keyring) {
      for (const inst of list) {
        try {
          const s = await this.secretGet(`relay.${inst.id}`);
          inst.secret = s || undefined;
          inst.has_secret = !!s;
        } catch {}
      }
    }
    return list;
  },

  async saveKlanker(inst: KlankerInstance): Promise<KlankerInstance> {
    const list = await this.listKlankers();
    const next = { ...inst, updated_at: new Date().toISOString() };
    if (caps.keyring) {
      const secret = (next.secret || "").trim();
      try {
        if (secret) await this.secretSet(`relay.${next.id}`, secret);
        next.has_secret = !!secret || !!next.has_secret;
        next.secret = undefined;
      } catch {}
    }
    const idx = list.findIndex((i) => i.id === inst.id);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    localStorage.setItem(LS_INSTANCES, JSON.stringify(caps.keyring ? list.map(stripSecrets) : list));
    return { ...next, secret: inst.secret };
  },

  async deleteKlanker(id: string): Promise<void> {
    const list = (await this.listKlankers()).filter((i) => i.id !== id);
    localStorage.setItem(LS_INSTANCES, JSON.stringify(caps.keyring ? list.map(stripSecrets) : list));
    if (localStorage.getItem(LS_ACTIVE) === id) localStorage.removeItem(LS_ACTIVE);
    if (caps.keyring) {
      try {
        await this.secretDelete(`relay.${id}`);
      } catch {}
    }
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

  async deleteWorkspace(inst: KlankerInstance, id: string, hard = false): Promise<void> {
    await req(
      inst,
      `/v1/workspaces/${encodeURIComponent(id)}${hard ? "?hard=1" : ""}`,
      { method: "DELETE", headers: headers(inst) }
    );
  },

  async createPersona(inst: KlankerInstance, workspace: string, id: string): Promise<void> {
    await jsonReq(inst, `/v1/workspaces/${encodeURIComponent(workspace)}/personas`, { id });
  },

  async deletePersona(inst: KlankerInstance, workspace: string, persona: string, hard = false): Promise<void> {
    await req(
      inst,
      `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}${hard ? "?hard=1" : ""}`,
      { method: "DELETE", headers: headers(inst) }
    );
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
  ): Promise<{ id: string; goal?: string; created_at?: string; last_active?: string }[]> {
    try {
      const r = await req<{ sessions?: any[] }>(
        inst,
        `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/sessions`,
        { headers: headers(inst) }
      );
      return (r.sessions || []).map((s) => ({
        id: s.id || s.session || "",
        goal: s.goal || undefined,
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

  /** Provider manifests known to the host loop (relay#14). */
  async listProviders(
    inst: KlankerInstance
  ): Promise<{ name: string; kind?: string; model?: string; when?: string }[]> {
    try {
      const r = await req<{ providers?: any[] }>(inst, "/v1/providers", { headers: headers(inst) });
      return (r.providers || []).map((p) => ({
        name: String(p.name || ""),
        kind: p.kind,
        model: p.model,
        when: p.when,
      })).filter((p) => p.name);
    } catch {
      return [];
    }
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
      model?: string;
      new_session?: boolean;
      attachments?: { data: string; mime?: string; name?: string }[];
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
      const wq = ws ? `&workspace=${encodeURIComponent(ws)}` : "";
      // Relay needs a session id for lines; without one it returns the list.
      const first = await req<{ lines?: string[]; sessions?: string[]; note?: string }>(
        inst,
        `/v1/traces?limit=${limit}${wq}`,
        { headers: headers(inst) }
      );
      if (first.lines?.length) return { lines: first.lines, note: first.note || "traces" };
      const last = (first.sessions || []).slice(-1)[0];
      if (!last) return { lines: [], note: first.note || "no sessions yet" };
      const r = await req<{ lines?: string[]; note?: string }>(
        inst,
        `/v1/traces?limit=${limit}&session=${encodeURIComponent(last)}${wq}`,
        { headers: headers(inst) }
      );
      return { lines: r.lines || [], note: r.note || `session ${last}` };
    } catch (e) {
      return { lines: [], note: `${RELAY_501_NOTE} (${e instanceof Error ? e.message : e})` };
    }
  },

  // --- jobs (goal-sessions) --------------------------------------------------

  async listJobs(
    inst: KlankerInstance,
    workspace: string,
    persona = ""
  ): Promise<{ id: string; goal?: string; status?: string; result?: string; created_at?: string }[]> {
    try {
      const q = `?workspace=${encodeURIComponent(workspace)}${persona ? `&persona=${encodeURIComponent(persona)}` : ""}`;
      const r = await req<{ jobs?: any[] }>(inst, `/v1/jobs${q}`, { headers: headers(inst) });
      return r.jobs || [];
    } catch {
      return [];
    }
  },

  async createJob(
    inst: KlankerInstance,
    body: {
      workspace: string;
      persona: string;
      goal: string;
      workdir?: string;
      provider?: string;
      model?: string;
    }
  ): Promise<{ id?: string; status?: string }> {
    const r = await jsonReq<{ job?: any }>(inst, "/v1/jobs", body);
    return r.job || {};
  },

  // --- not available in the browser -----------------------------------------

  async discoverPeers(): Promise<DiscoveredPeer[]> {
    return [];
  },

  // --- desktop (Tauri) only ---------------------------------------------------

  async secretGet(account: string): Promise<string | null> {
    return invoke<string | null>("secret_get", { account });
  },
  async secretSet(account: string, secret: string): Promise<void> {
    await invoke("secret_set", { account, secret });
  },
  async secretDelete(account: string): Promise<void> {
    await invoke("secret_delete", { account });
  },

  async serveStatus(): Promise<ServeStatus> {
    return invoke<ServeStatus>("serve_status");
  },
  async serveEnsureLocal(): Promise<ServeStatus> {
    return invoke<ServeStatus>("serve_ensure_local");
  },
  async serveRestart(): Promise<ServeStatus> {
    return invoke<ServeStatus>("serve_restart");
  },

  async klankerVersion(): Promise<ProvisionStatus> {
    return invoke<ProvisionStatus>("klanker_version");
  },
  async klankerInstall(): Promise<ProvisionStatus> {
    return invoke<ProvisionStatus>("klanker_install");
  },
  async klankerUpgrade(): Promise<ProvisionStatus> {
    return invoke<ProvisionStatus>("klanker_upgrade");
  },

  async checkAppUpdates(): Promise<UpdateInfo> {
    return invoke<UpdateInfo>("check_for_updates");
  },
  async installAppUpdate(): Promise<void> {
    await invoke("install_update");
  },
};

export interface ServeStatus {
  state: "running" | "starting" | "stopped" | "lost" | "not_found" | string;
  pid?: number;
  owned: boolean;
  port: number;
  klanker_version?: string | null;
  detail?: string | null;
}

export interface ProvisionStatus {
  uv_path?: string | null;
  klanker_version?: string | null;
  detail?: string | null;
}

export interface UpdateInfo {
  available: boolean;
  current_version: string;
  version?: string | null;
  date?: string | null;
  body?: string | null;
}

/** Map a desktop serve_status onto the shared ProcessStatus shape. */
export function serveToProcess(ss: ServeStatus): ProcessStatus {
  const state: ProcessStatus["state"] =
    ss.state === "running"
      ? "running"
      : ss.state === "starting"
        ? "starting"
        : ss.state === "not_found"
          ? "not_found"
          : ss.state === "lost"
            ? "lost"
            : "stopped";
  return {
    is_running: ss.state === "running",
    pid: ss.pid,
    port: ss.port,
    state,
    detail: ss.detail ?? undefined,
  };
}

/** Keyring path only: never persist plaintext secrets to localStorage. */
function stripSecrets(inst: KlankerInstance): KlankerInstance {
  const copy = { ...inst, secret: undefined };
  if (copy.endpoint) copy.endpoint = { ...copy.endpoint, secret: undefined };
  return copy;
}

/** The managed local serve entry for desktop builds. */
export function desktopLocalInstance(): KlankerInstance {
  const now = new Date().toISOString();
  return {
    id: "local",
    name: "klanker (local)",
    slug: "local",
    role: "",
    provider: "",
    model: "",
    workspace: "",
    lock_workspace: false,
    port: 8787,
    system_prompt: "",
    kind: "local",
    endpoint: { base_url: "http://127.0.0.1:8787" },
    created_at: now,
    updated_at: now,
  };
}

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
