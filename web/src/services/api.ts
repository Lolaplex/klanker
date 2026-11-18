import {
  DesktopBootstrap,
  DesktopSettings,
  DiscoveredPeer,
  KlankerInstance,
  PendingApproval,
  ProcessStatus,
  TracePage,
} from "../types/klanker";
import { DEFAULT_SETTINGS } from "../openrouterModels";

const LS_INSTANCES = "klanker.instances";
const LS_INSTANCES_MIGRATED = "klanker.instances_migrated";
const LS_SETTINGS = "klanker.settings";
const LS_IMPORTED = "klanker.legacy_imported";
const LS_ACTIVE = "klanker.active";

/** "" means same origin — the dashboard is served by the relay itself.
 *  `via: "relay"` instances mount through the relay's authenticated proxy. */
const base = (inst: KlankerInstance): string =>
  inst.via === "relay"
    ? `/v1/remote/${encodeURIComponent(inst.id)}`
    : (inst.endpoint?.base_url || inst.base_url || "").replace(/\/+$/, "");

function headers(inst: KlankerInstance, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const secret = (inst.secret || "").trim();
  // Mounted remotes: the relay injects the bearer — the client holds none.
  if (secret && inst.via !== "relay") h["Authorization"] = `Bearer ${secret}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/** In-memory secret cache: a token minted at spawn is usable before it hits
 *  the keyring read path, and survives listKlankers() rebuilds. Keyed by
 *  keyring account, not instance id. */
const secretCache = new Map<string, string>();

export function rememberSecret(account: string, secret: string): void {
  if (secret) secretCache.set(account, secret);
}

/** Keyring account for an instance's relay secret. Remote instances key off
 *  the endpoint host — renames, slug changes and re-adding the same server
 *  under a new name can never orphan the stored token. Local/managed serves
 *  key off the instance id (`relay.local`), matching serve.rs. */
export function secretAccount(inst: KlankerInstance): string {
  const base = inst.endpoint?.base_url || inst.base_url || "";
  if (inst.kind === "local" || !base) return `relay.${inst.id}`;
  try {
    return `relay.${new URL(base).host}`;
  } catch {
    return `relay.${inst.id}`;
  }
}

/** Pull a keyring secret into inst.secret. Called lazily — the local
 *  serve's token is only minted at spawn, after instances were loaded. */
async function hydrateSecret(inst: KlankerInstance, force = false): Promise<void> {
  if (!caps.keyring || inst.via === "relay") return;
  if (!force && inst.secret) return;
  const account = secretAccount(inst);
  const cached = secretCache.get(account);
  if (cached && !force) {
    inst.secret = cached;
    inst.has_secret = true;
    return;
  }
  try {
    let s = await invoke<string | null>("secret_get", { account });
    if (!s && account !== `relay.${inst.id}`) {
      // Legacy id-keyed entry — adopt it under the endpoint account so
      // pre-#56 installs keep working without re-entering the secret.
      s = await invoke<string | null>("secret_get", { account: `relay.${inst.id}` });
      if (s) {
        try {
          await invoke("secret_set", { account, secret: s });
          await invoke("secret_delete", { account: `relay.${inst.id}` });
        } catch {}
      }
    }
    inst.secret = s || undefined;
    inst.has_secret = !!s;
    if (s) secretCache.set(account, s);
  } catch {}
}

/** fetch with Bearer hydration: resolve the keyring secret when missing,
 *  and retry once after a forced refresh on 401 (spawn token rotation). */
async function authedFetch(
  inst: KlankerInstance,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  await hydrateSecret(inst);
  if (inst.secret && init.headers) (init.headers as Record<string, string>)["Authorization"] = `Bearer ${inst.secret}`;
  let res = await fetch(url, init);
  if (res.status === 401 && caps.keyring) {
    await hydrateSecret(inst, true);
    if (inst.secret) {
      const h = (init.headers as Record<string, string>) || {};
      init = { ...init, headers: { ...h, Authorization: `Bearer ${inst.secret}` } };
      res = await fetch(url, init);
    }
  }
  return res;
}

async function req<T = any>(
  inst: KlankerInstance,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await authedFetch(inst, base(inst) + path, { ...init });
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

  // --- instances ------------------------------------------------------------
  // Desktop: durable file registry via `~/.klanker/instances/<id>/instance.json`
  // (survives reloads, userdata wipes, port/origin changes). Web/PWA:
  // localStorage until the relay hosts the registry (#60 web half).

  async listKlankers(): Promise<KlankerInstance[]> {
    let list = await registryList();
    if (caps.spawn) {
      // Managed local entry is synthetic — never persisted. Legacy
      // `kind: "local"` rows were per-instance serves (monolith) — dead.
      list = [desktopLocalInstance(), ...list.filter((i) => i.id !== "local" && i.kind !== "local")];
    } else if (list.length === 0) {
      list = [localInstance()];
      await registrySave(list[0]);
    }
    if (caps.keyring) {
      for (const inst of list) await hydrateSecret(inst);
    }
    return list;
  },

  async saveKlanker(inst: KlankerInstance): Promise<KlankerInstance> {
    const list = await this.listKlankers();
    const next = { ...inst, updated_at: new Date().toISOString() };
    const idx = list.findIndex((i) => i.id === inst.id);
    if (idx < 0 && inst.kind === "remote") {
      // New remote: slug-stable id for the registry dir `instances/<id>`.
      next.id = uniqueSlug(inst.slug || inst.name, list.map((i) => i.id));
      next.slug = next.slug || next.id;
    }
    if (caps.keyring) {
      const secret = (next.secret || next.endpoint?.secret || "").trim();
      try {
        if (secret) {
          const account = secretAccount(next);
          await this.secretSet(account, secret);
          secretCache.set(account, secret);
        }
        next.has_secret = !!secret || !!next.has_secret;
      } catch {}
    }
    const stored = await registrySave(next);
    return { ...stored, secret: inst.secret || inst.endpoint?.secret };
  },

  async deleteKlanker(id: string): Promise<void> {
    let inst: KlankerInstance | undefined;
    try {
      inst = (await registryList()).find((i) => i.id === id);
    } catch {}
    if (isTauri()) {
      try {
        await invoke("instance_delete", { id });
      } catch {}
    } else {
      try {
        await fetch(`/v1/remotes/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {}
      const list = load(LS_INSTANCES, [] as KlankerInstance[]).filter((i) => i.id !== id);
      localStorage.setItem(LS_INSTANCES, JSON.stringify(list));
    }
    if (localStorage.getItem(LS_ACTIVE) === id) localStorage.removeItem(LS_ACTIVE);
    if (caps.keyring) {
      try {
        const accounts = new Set([`relay.${id}`, ...(inst ? [secretAccount(inst)] : [])]);
        for (const account of accounts) await this.secretDelete(account);
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
      // Auth probe: a stale/missing secret must surface as "unauthorized",
      // not look like an empty instance. Probe a protected route —
      // /v1/auth/status is public and answers 200 for everyone.
      try {
        const a = await authedFetch(inst, base(inst) + "/v1/workspaces", { headers: headers(inst) });
        if (a.status === 401 || a.status === 403) {
          return { is_running: true, port: 0, state: "running", detail: "unauthorized" };
        }
      } catch {}
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
    const res = await authedFetch(inst, base(inst) + "/v1/chat/stream", {
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
  // Tailnet discovery needs a local tailscale CLI + LAN probes — desktop only.

  async discoverPeers(): Promise<DiscoveredPeer[]> {
    if (!isTauri()) return [];
    try {
      return await invoke<DiscoveredPeer[]>("discover_peers");
    } catch {
      return [];
    }
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
  async serveEnsureLocal(workdir?: string): Promise<ServeStatus> {
    return invoke<ServeStatus>("serve_ensure_local", { workdir });
  },
  async serveRestart(workdir?: string): Promise<ServeStatus> {
    return invoke<ServeStatus>("serve_restart", { workdir });
  },

  /** Spawn/attach the managed local serve and return the instance plus its
   *  bearer secret in one shot (desktop only). */
  /** One-time import of legacy app settings from `~/.klanker` (pre-thin-shell
   *  builds). Instance configs need no import — the file registry reads the
   *  same `instances/<id>/instance.json` files the monolith wrote. */
  async importLegacy(): Promise<void> {
    if (!caps.keyring || localStorage.getItem(LS_IMPORTED)) return;
    try {
      const st = await invoke<{ settings?: unknown }>("legacy_state");
      if (st?.settings && !localStorage.getItem(LS_SETTINGS)) {
        localStorage.setItem(LS_SETTINGS, JSON.stringify(st.settings));
      }
    } catch {}
    localStorage.setItem(LS_IMPORTED, "1");
  },

  async desktopBootstrap(): Promise<DesktopBootstrap> {
    await this.importLegacy();
    const settings = await this.loadSettings();
    const st = await this.serveEnsureLocal(settings.workspace || undefined);
    const inst = desktopLocalInstance();
    const secret = (await this.secretGet(secretAccount(inst))) || "";
    if (secret) rememberSecret(secretAccount(inst), secret);
    const base_url = inst.endpoint?.base_url || "";
    return { instance: inst, base_url, secret, status: serveToProcess(st) };
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

/** Map a legacy `~/.klanker` instance.json onto the current shape. */
function mapLegacyInstance(raw: Record<string, unknown>): KlankerInstance {
  const now = new Date().toISOString();
  const endpoint = (raw.endpoint || {}) as { base_url?: string | null };
  const baseUrl = endpoint.base_url || (raw.base_url as string) || "";
  return {
    id: (raw.id as string) || (raw.slug as string) || crypto.randomUUID(),
    name: (raw.name as string) || (raw.slug as string) || "instance",
    slug: (raw.slug as string) || "",
    role: (raw.role as string) || "",
    provider: (raw.provider as string) || "",
    model: (raw.model as string) || "",
    workspace: (raw.workspace as string) || "",
    lock_workspace: !!raw.lock_workspace,
    port: (raw.port as number) || 0,
    system_prompt: (raw.system_prompt as string) || "",
    sensors: raw.sensors as Record<string, boolean> | undefined,
    kind: raw.kind === "local" ? "local" : "remote",
    endpoint: baseUrl ? { base_url: baseUrl } : undefined,
    tailscale: (raw.tailscale as KlankerInstance["tailscale"]) || undefined,
    created_at: (raw.created_at as string) || now,
    updated_at: (raw.updated_at as string) || now,
  };
}

/** Keyring path only: never persist plaintext secrets to localStorage. */
function stripSecrets(inst: KlankerInstance): KlankerInstance {
  const copy = { ...inst, secret: undefined };
  if (copy.endpoint) copy.endpoint = { ...copy.endpoint, secret: undefined };
  return copy;
}

// --- instance registry backend ---------------------------------------------
// Desktop: `~/.klanker/instances/<id>/instance.json` via tauri commands.
// Web/PWA: localStorage (relay-hosted registry is the web half of #60).

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function uniqueSlug(base: string, taken: string[]): string {
  const root = slugify(base) || "instance";
  let id = root;
  for (let n = 2; taken.includes(id); n++) id = `${root}-${n}`;
  return id;
}

async function registryList(): Promise<KlankerInstance[]> {
  if (isTauri()) {
    let rows: KlankerInstance[] = [];
    try {
      rows = (await invoke<Record<string, unknown>[]>("instances_list")).map(mapLegacyInstance);
    } catch {}
    // One-time move: localStorage-era bookmarks → file registry.
    if (!localStorage.getItem(LS_INSTANCES_MIGRATED)) {
      const ls = load(LS_INSTANCES, [] as KlankerInstance[]);
      for (const inst of Array.isArray(ls) ? ls : []) {
        if (inst.id === "local" || rows.some((r) => r.id === inst.id)) continue;
        const stored = stripSecrets(inst);
        try {
          await invoke("instance_save", { inst: stored });
          rows.push(stored);
        } catch {}
      }
      localStorage.setItem(LS_INSTANCES_MIGRATED, "1");
      localStorage.removeItem(LS_INSTANCES);
    }
    return rows;
  }
  // Web/PWA: the serving relay holds the registry + secrets server-side.
  const remote = await relayRemotes();
  if (remote !== null) {
    // One-time move: localStorage bookmarks (which held plaintext secrets)
    // onto the relay — then the browser drops them.
    if (!localStorage.getItem(LS_INSTANCES_MIGRATED)) {
      const ls = load(LS_INSTANCES, [] as KlankerInstance[]);
      for (const inst of Array.isArray(ls) ? ls : []) {
        if (inst.id === "local" || remote.some((r) => r.id === inst.id)) continue;
        await remoteSave(inst);
      }
      localStorage.setItem(LS_INSTANCES_MIGRATED, "1");
      localStorage.removeItem(LS_INSTANCES);
      return relayRemotes().then((r) => r ?? remote);
    }
    return remote;
  }
  const ls = load(LS_INSTANCES, [] as KlankerInstance[]);
  return Array.isArray(ls) ? ls : [];
}

/** `/v1/remotes` rows as mounted instances; null = relay predates the mount API. */
async function relayRemotes(): Promise<KlankerInstance[] | null> {
  try {
    const r = await fetch("/v1/remotes");
    if (!r.ok) return null;
    const data = await r.json();
    const now = new Date().toISOString();
    return ((data.remotes || []) as { id: string; base_url: string; label: string; has_secret: boolean }[]).map(
      (m): KlankerInstance => ({
        id: m.id,
        name: m.label || m.id,
        slug: m.id,
        role: "",
        provider: "",
        model: "",
        workspace: "",
        lock_workspace: false,
        port: 0,
        system_prompt: "",
        kind: "remote",
        via: "relay",
        has_secret: m.has_secret,
        endpoint: { base_url: m.base_url },
        created_at: now,
        updated_at: now,
      })
    );
  } catch {
    return null;
  }
}

async function remoteSave(inst: KlankerInstance): Promise<boolean> {
  try {
    const r = await fetch("/v1/remotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: inst.id,
        base_url: inst.endpoint?.base_url || inst.base_url || "",
        label: inst.name,
        secret: inst.secret || inst.endpoint?.secret || "",
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Persist an instance; returns the stored form (secrets stripped). */
async function registrySave(inst: KlankerInstance): Promise<KlankerInstance> {
  if (isTauri()) {
    const stored = stripSecrets(inst);
    await invoke("instance_save", { inst: stored });
    return stored;
  }
  // The synthetic origin entry never goes to the relay registry.
  if (inst.id === "local") {
    lsWrite(inst);
    return inst;
  }
  if (await remoteSave(inst)) {
    return { ...stripSecrets(inst), via: "relay", has_secret: inst.has_secret || !!(inst.secret || inst.endpoint?.secret) };
  }
  lsWrite(inst);
  return inst;
}

function lsWrite(inst: KlankerInstance): void {
  const ls = load(LS_INSTANCES, [] as KlankerInstance[]);
  const arr = Array.isArray(ls) ? ls : [];
  const idx = arr.findIndex((i) => i.id === inst.id);
  if (idx >= 0) arr[idx] = inst;
  else arr.push(inst);
  localStorage.setItem(LS_INSTANCES, JSON.stringify(arr));
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
