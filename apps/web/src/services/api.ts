import type {
  DesktopBootstrap,
  DesktopSettings,
  DiscoveredPeer,
  HostInfo,
  HubConnectResult,
  HubDevice,
  HubLease,
  InboxTask,
  HubLink,
  JobRow,
  KlankerInstance,
  ModelPick,
  PairCreateResult,
  PendingApproval,
  ProcessStatus,
  ProviderRow,
  RelayCapabilities,
  RelayEvent,
  RoutineActionResult,
  RoutineRow,
  SessionEvent,
  WsRepoPatch,
  SessionHostSwitch,
  StoreListResult,
  StorePaneResult,
  TracePage,
  WorkspaceHosts,
  WorkspacePolicyPatch,
  WorkspaceRow,
  WsInbox,
  WsInvite,
} from "../types/klanker";
import { parseSseChunk, parseStoreListResponse } from "../relayEvents.ts";
import { remoteMountId } from "../hostPicker.ts";

const DEFAULT_SETTINGS: DesktopSettings = { workspace: "", autostart: false, hub_mode: false };

const LS_INSTANCES = "klanker.instances";
const LS_INSTANCES_MIGRATED = "klanker.instances_migrated";
const LS_SETTINGS = "klanker.settings";
const LS_IMPORTED = "klanker.legacy_imported";
const LS_ACTIVE = "klanker.active";

/** "" means same origin — the dashboard is served by the relay itself.
 *  `via: "relay"` instances mount through the relay's authenticated proxy. */
/** Live port of the desktop-managed serve — updated from serve_status.
 *  A restart spawns on a fresh port when the default is held by a foreign
 *  process, so the hardcoded registry URL cannot be trusted. */
let localServePort = 8787;

/** Loopback base URL for the managed local relay on its live port. */
export function localRelayBaseUrl(port: number = localServePort): string {
  return `http://127.0.0.1:${port}`;
}

/** Update the managed-serve port (serve_status poll / klanker:serve-state). */
export function setLocalServePort(port: number): void {
  if (port > 0) localServePort = port;
}

const LS_HOST_ID = "klanker.host_id";
const LS_SERVE_PORTS = "klanker.serve_ports";

function storedPorts(): number[] {
  try {
    const raw = localStorage.getItem(LS_SERVE_PORTS);
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    return list.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function rememberServePort(port: number): void {
  if (port <= 0) return;
  const list = [port, ...storedPorts().filter((p) => p !== port)].slice(0, 5);
  try {
    localStorage.setItem(LS_SERVE_PORTS, JSON.stringify(list));
  } catch {}
}

export function pinnedHostId(): string {
  try {
    return (localStorage.getItem(LS_HOST_ID) || "").trim();
  } catch {
    return "";
  }
}

function pinHostId(hostId: string): void {
  try {
    localStorage.setItem(LS_HOST_ID, hostId.trim());
  } catch {}
}

async function fetchHealth(port: number, timeoutMs = 2500): Promise<{ host_id: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(localRelayBaseUrl(port) + "/health", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { host_id?: string };
    return { host_id: String(data.host_id || "") };
  } catch {
    return null;
  }
}

/** Ensure localServePort points at a serve of OUR host, never a foreign one.
 *
 * A stale or foreign serve on the last-known port (e.g. a leaked test serve
 * with a different host) must not be adopted — we repoint to whichever
 * candidate port answers /health with the pinned host_id. The pin is only
 * set once the loopback bearer actually authenticates, so a foreign serve
 * can never seed the pin. No UI, no user step: silent self-heal. */
export async function ensureLocalServePort(): Promise<number | null> {
  // A browser never has a managed serve to discover: the web local instance
  // is the serving relay itself (same origin). Probing loopback ports from
  // a VPS-served page is pure connection-refused spam — refuse outright.
  if (!caps.spawn) return null;
  const pinned = pinnedHostId();
  const secret = secretCache.get("relay.local") || "";

  const authOk = async (port: number): Promise<boolean> => {
    if (!secret) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${localRelayBaseUrl(port)}/v1/auth/status`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  };

  const matches = async (port: number): Promise<boolean> => {
    const h = await fetchHealth(port);
    if (!h) return false;
    if (pinned) return h.host_id === pinned;
    return authOk(port);
  };

  if (await matches(localServePort)) {
    if (!pinned) {
      const h = await fetchHealth(localServePort);
      if (h?.host_id) pinHostId(h.host_id);
    }
    rememberServePort(localServePort);
    return localServePort;
  }

  const candidates: number[] = [];
  if (caps.spawn) {
    try {
      const st = await api.serveStatus();
      if (st.port) candidates.push(st.port);
    } catch {}
  }
  candidates.push(localServePort, ...storedPorts(), 8787);

  for (const port of [...new Set(candidates)]) {
    if (port === localServePort) continue;
    if (await matches(port)) {
      localServePort = port;
      if (!pinned) {
        const h = await fetchHealth(port);
        if (h?.host_id) pinHostId(h.host_id);
      }
      rememberServePort(port);
      return port;
    }
  }
  return null;
}

/** via relay OR via hub channel — both ride the serving relay's
 *  /v1/remote/<id> mount; the remote secret lives server-side. */
const isMounted = (inst: KlankerInstance): boolean =>
  inst.via === "relay" || inst.via === "channel";

const base = (inst: KlankerInstance): string =>
  isMounted(inst)
    ? `${caps.spawn ? localRelayBaseUrl() : ""}/v1/remote/${encodeURIComponent(inst.id)}`
    : inst.kind === "local" && caps.spawn
      ? `http://127.0.0.1:${localServePort}`
      : (inst.endpoint?.base_url || inst.base_url || "").replace(/\/+$/, "");

function headers(inst: KlankerInstance, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const secret = (inst.secret || "").trim();
  // Mounted remotes: the relay injects the bearer — the client holds none.
  // Desktop still authenticates to its LOCAL relay for /v1/remote/* calls.
  if (isMounted(inst)) {
    if (caps.spawn) {
      const local = secretCache.get("relay.local");
      if (local) h["Authorization"] = `Bearer ${local}`;
    }
  } else if (secret) {
    h["Authorization"] = `Bearer ${secret}`;
  }
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
export async function hydrateSecret(inst: KlankerInstance, force = false): Promise<void> {
  if (!caps.keyring) return;
  // Relay-mounted remotes need the local relay's own token on Desktop.
  if (isMounted(inst)) {
    if (!caps.spawn) return;
    const local = secretCache.get("relay.local");
    if (local) {
      inst.secret = local;
      inst.has_secret = true;
    }
    return;
  }
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

/** Fired when a same-origin call answers 401 in a browser context: the
 *  session cookie is dead and the UI must drop back to the AuthGate.
 *  Registered by useInstances; desktop never uses it (bearer secrets, not
 *  cookies). */
let authExpiredHandler: (() => void) | null = null;
export function setAuthExpiredHandler(fn: (() => void) | null): void {
  authExpiredHandler = fn;
}

/** A 401 means the web session died only when it comes from the serving
 *  relay itself — never from a credential-minting endpoint (a wrong token
 *  is not an expired session) and never from the remote proxy (that is the
 *  remote relay's secret, not our cookie). */
function noteAuthResponse(url: string, status: number): void {
  if (status !== 401 || caps.spawn || !authExpiredHandler) return;
  if (/\/v1\/auth\/login\b/.test(url)) return;
  if (/\/v1\/pair\/redeem\b/.test(url)) return;
  if (url.includes("/v1/remote/")) return;
  authExpiredHandler();
}

/** Render an HTTP error body as a clean one-line message. stdlib send_error
 *  renders HTML — unwrap its detail, never the tags; a raw HTML 401 is the
 *  dead-session shape, so say so instead of echoing markup. */
export function httpErrorMessage(status: number, body: string): string {
  let msg = body;
  try {
    const parsed = JSON.parse(body) as { error?: string; detail?: string };
    msg = parsed.error || parsed.detail || body;
  } catch {}
  if (/^\s*</.test(msg)) {
    if (status === 401) return "401: session expired — sign in again";
    const m =
      /<p>Message:\s*([^<]+)<\/p>/i.exec(msg) ||
      /<p>([^<]+)<\/p>/i.exec(msg) ||
      /<title>([^<]+)<\/title>/i.exec(msg);
    msg = m ? m[1] : msg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return `${status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`;
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
  noteAuthResponse(url, res.status);
  return res;
}

async function req<T = unknown>(
  inst: KlankerInstance,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await authedFetch(inst, base(inst) + path, { ...init });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(httpErrorMessage(res.status, body));
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    return body as unknown as T;
  }
}

const jsonReq = <T = unknown>(inst: KlankerInstance, path: string, body: object) =>
  req<T>(inst, path, { method: "POST", headers: headers(inst, true), body: JSON.stringify(body) });

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // Plain-object fallback merges stored partial state over defaults;
    // arrays/scalars are returned verbatim — spreading an array would
    // produce an object without .filter/.map.
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      !Array.isArray(fallback)
    ) {
      return { ...(fallback as object), ...(parsed as object) } as T;
    }
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

const RELAY_501_NOTE = "Endpoint missing on this relay (requires agents-relay#12).";

const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Invoke a Tauri command; throws on non-desktop. */
const invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const core = (
    window as {
      __TAURI__?: { core?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } };
    }
  ).__TAURI__?.core;
  if (!core?.invoke) return Promise.reject(new Error("not a tauri host"));
  return core.invoke(cmd, args) as Promise<T>;
};

/** Loosely-shaped relay row — every field read is narrowed at the mapper
 *  edge instead of trusting `any`. */
type WireRow = Record<string, unknown>;

const wstr = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;
const wbool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

/** Capability flags: desktop (Tauri) gets spawn/keyring/updates; web/PWA does not. */
export const caps = {
  localFs: isTauri(),
  spawn: isTauri(),
  keyring: isTauri(),
  updates: isTauri(),
} as const;

/** OS notification — desktop uses the native Tauri notification plugin
 *  (the webview's browser Notification API is a no-op on several platforms);
 *  plain browsers fall back to the Notification API with permission ask.
 *  Never throws — notifications are best-effort by nature (klanker#59 U06). */
export async function notify(title: string, body = ""): Promise<void> {
  try {
    if (caps.spawn) {
      const tauri = (window as unknown as { __TAURI__?: { core?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__;
      if (tauri?.core?.invoke) {
        try {
          let granted = (await tauri.core.invoke("plugin:notification|is_permission_granted")) === true;
          if (!granted) {
            const perm = await tauri.core.invoke("plugin:notification|request_permission");
            granted = perm === "granted" || perm === "Granted";
          }
          if (granted) {
            await tauri.core.invoke("plugin:notification|notify", { options: { title, body } });
            return;
          }
        } catch {
          // fall through to the browser path — a plugin mismatch must
          // never eat the notification silently in a browser context.
        }
      }
    }
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

/** Focus gate for OS notifications (klanker#59 U06): only while the
 *  window is unfocused/minimized — a foreground app must never spam its
 *  own operator. No document (node test, worker) counts as focused. */
export function unfocusedNow(): boolean {
  try {
    if (typeof document === "undefined") return false;
    return document.hidden || !document.hasFocus();
  } catch {
    return false;
  }
}

/** Notify only when unfocused — the single gate every trigger goes
 *  through. `deliver` is injectable so tests can observe without an OS.
 *  Never throws, including in a bare web/node context. */
export async function notifyWhenUnfocused(
  title: string,
  body = "",
  deliver: (t: string, b: string) => Promise<void> = notify
): Promise<void> {
  try {
    if (!unfocusedNow()) return;
    await deliver(title, body);
  } catch {}
}

function filterPendingApprovals(
  rows: PendingApproval[],
  opts?: { session?: string; device?: string }
): PendingApproval[] {
  const session = (opts?.session || "").trim();
  const device = (opts?.device || "").trim();
  if (!session && !device) return rows;
  return rows.filter((a) => {
    if (a.session && session && a.session !== session) return false;
    if (a.session && !session && !(device && a.device === device)) return false;
    if (a.device && device && a.device !== device) return false;
    return true;
  });
}

export const api = {
  // --- settings (localStorage) -------------------------------------------

  async loadSettings(): Promise<DesktopSettings> {
    const s = load(LS_SETTINGS, { ...DEFAULT_SETTINGS }) as DesktopSettings & Record<string, unknown>;
    let dirty = false;
    for (const staleKey of ["openrouter_api_key", "openrouter_key_set", "lmstudio_base_url", "auto_start_local_serve"]) {
      if (staleKey in s) {
        delete s[staleKey];
        dirty = true;
      }
    }
    if (dirty) {
      try {
        localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
      } catch {}
    }
    return s;
  },

  async saveSettings(settings: DesktopSettings): Promise<DesktopSettings> {
    const clean: DesktopSettings = {
      workspace: settings.workspace,
      autostart: settings.autostart,
      hub_mode: !!settings.hub_mode,
    };
    localStorage.setItem(LS_SETTINGS, JSON.stringify(clean));
    return clean;
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
      const local = desktopLocalInstance();
      const fileRows = list.filter((i) => i.id !== "local" && i.kind !== "local");
      // The local relay /v1/remotes registry is canonical on Desktop.
      // Listing is read-only: file rows are NOT migrated onto the relay
      // here — that is the explicit one-time migrateLegacyInstances()
      // step (klanker#149). A null (unreachable) relay just means fewer
      // rendered rows plus the file fallback below.
      const relay = await localRelayRemotes();
      const fileByHost = new Map(fileRows.map((i) => [hostKey(i), i] as const));
      list = [local];
      const now = new Date().toISOString();
      const rendered = new Set<string>();
      for (const m of relay?.remotes || []) {
        const host = hostKey(m);
        if (host) rendered.add(host);
        const f = host ? fileByHost.get(host) : undefined;
        list.push({
          id: m.id,
          name: m.label || m.id,
          slug: m.id,
          role: "",
          provider: f?.provider || "",
          model: f?.model || "",
          workspace: f?.workspace || "",
          lock_workspace: f?.lock_workspace || false,
          port: 0,
          system_prompt: "",
          kind: "remote",
          via: m.via === "channel" ? "channel" : "relay",
          device_id: m.device_id || undefined,
          endpoint: { base_url: m.base_url },
          has_secret: m.has_secret,
          created_at: f?.created_at || now,
          updated_at: now,
        });
      }
      // File rows the relay never mounted stay visible as direct remote
      // entries — an unreachable relay must not hide instances that can
      // still be called directly.
      for (const i of fileRows) {
        const host = hostKey(i);
        if (host && rendered.has(host)) continue;
        list.push({ ...i, kind: "remote", updated_at: now });
      }
    } else {
      // Web/PWA: the serving relay IS the local instance — it is always in
      // the herd, no matter how many remotes are mounted on it. Without it
      // herd["local"] stays undefined, the header reads "offline" and the
      // sidebar tree never loads. The synthetic entry is never persisted
      // (registrySave refuses id "local"); a stray persisted row is dropped.
      list = [localInstance(), ...list.filter((i) => i.id !== "local" && i.kind !== "local")];
    }
    if (caps.keyring) {
      for (const inst of list) await hydrateSecret(inst);
    }
    return list;
  },

  /** One-time explicit import: push stale stores onto the local relay's
   *  /v1/remotes mount table —
   *   1. localStorage bookmarks (plaintext-secret era), which the browser
   *      then drops,
   *   2. file-registry remote rows (`~/.klanker/instances/<id>`).
   *  Runs ONLY when invoked — the old per-poll auto-migration is retired
   *  (klanker#149). Idempotent: rows whose endpoint host is already
   *  mounted are skipped, so re-running is a cheap no-op. Throws when
   *  the relay is unreachable — a half migration is worse than none
   *  (klanker#144). */
  async migrateLegacyInstances(): Promise<{ migrated: number; skipped: number }> {
    if (!caps.spawn) return { migrated: 0, skipped: 0 };
    const relay = await localRelayRemotes();
    if (relay === null) throw new Error("local relay unreachable — migration aborted");
    const relayHosts = new Set((relay.remotes || []).map((m) => hostKey(m)).filter(Boolean));

    const candidates: KlankerInstance[] = [];
    const lsPending = !localStorage.getItem(LS_INSTANCES_MIGRATED);
    if (lsPending) {
      const ls = load(LS_INSTANCES, [] as KlankerInstance[]);
      for (const inst of Array.isArray(ls) ? ls : []) {
        if (inst.id === "local" || inst.kind === "local") continue;
        candidates.push(inst);
      }
    }
    const fileRows = (await registryList()).filter((i) => i.id !== "local" && i.kind !== "local");
    candidates.push(...fileRows);

    let migrated = 0;
    let skipped = 0;
    for (const i of candidates) {
      const baseUrl = i.endpoint?.base_url || i.base_url || "";
      if (!baseUrl) {
        // Channel/device rows and synthetic locals have no mountable URL.
        skipped++;
        continue;
      }
      const host = hostKey(i);
      if (host && relayHosts.has(host)) {
        skipped++;
        continue;
      }
      await hydrateSecret(i);
      const wrote = await localRelayRemotes("POST", {
        id: i.id,
        base_url: baseUrl,
        label: i.name,
        // Keyring/LS secret travels over loopback once so the relay can
        // inject it on proxy turns — it is never written to disk here.
        secret: i.secret || i.endpoint?.secret || "",
      });
      if (wrote === null) {
        skipped++;
        continue;
      }
      if (host) relayHosts.add(host);
      migrated++;
    }
    if (lsPending) {
      localStorage.setItem(LS_INSTANCES_MIGRATED, "1");
      localStorage.removeItem(LS_INSTANCES);
    }
    return { migrated, skipped };
  },

  async saveKlanker(inst: KlankerInstance): Promise<KlankerInstance> {
    if (inst.kind === "local" || inst.id === "local") {
      // Synthetic local entry — edits route through settings/workspace
      // endpoints, never into a persisted registry.
      return { ...inst, updated_at: new Date().toISOString() };
    }
    if (caps.spawn && inst.kind === "remote") {
      if (inst.via === "channel") {
        // Channel rows are hub-paired devices owned by the relay — never
        // POST /v1/remotes for them and never write them into the file
        // registry (`instances.json`): a persisted channel row would
        // resurrect after the device is unpaired at the hub.
        return { ...inst, updated_at: new Date().toISOString() };
      }
      // Canonical remote registry is the local relay /v1/remotes — no
      // parallel file write; the secret goes over loopback once and then
      // only lives in the relay-side vault.
      const list = await this.listKlankers();
      const next = { ...inst, updated_at: new Date().toISOString() };
      if (!list.some((i) => i.id === inst.id)) {
        next.id = uniqueSlug(inst.slug || inst.name, list.map((i) => i.id));
        next.slug = next.slug || next.id;
      }
      const saved = await localRelayRemotes("POST", {
        id: next.id,
        base_url: next.endpoint?.base_url || next.base_url || "",
        label: next.name,
        secret: (next.secret || next.endpoint?.secret || "").trim(),
      });
      // Fail loud (klanker#144): an unreachable or refusing relay must not
      // leave the instance "saved" outside the canonical registry.
      if (saved === null) {
        throw new Error("local relay unreachable — remote not saved");
      }
      const merged = mergeCanonicalRemote(next, saved.remote);
      return {
        ...stripSecrets(merged),
        secret: inst.secret || inst.endpoint?.secret,
      };
    }
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
    // Channel rows (dev-<device_id>) are revoked at the hub — the relay
    // drops its dev-<id> remote row itself. Relay mounts DELETE /v1/remotes.
    const deviceId = inst?.device_id || (id.startsWith("dev-") ? id.slice(4) : "");
    if (isTauri()) {
      // Await the relay-side delete before the file delete — firing it
      // un-awaited lets `instance_delete` win the race and orphan the
      // hub device / remote mount row.
      try {
        if (deviceId) {
          await localRelayFetch(`/v1/hub/devices/${encodeURIComponent(deviceId)}`, "DELETE");
        } else {
          // Canonical store is the relay; the file delete only cleans any
          // legacy `instances/<id>/instance.json` left from pre-#120 installs.
          await localRelayRemotes("DELETE", undefined, id);
        }
      } catch {}
      try {
        await invoke("instance_delete", { id });
      } catch {}
    } else {
      try {
        if (deviceId) {
          await fetch(`/v1/hub/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
        } else {
          await fetch(`/v1/remotes/${encodeURIComponent(id)}`, { method: "DELETE" });
        }
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
      // Remove relay-side mirror rows for the same endpoint — otherwise a
      // deleted instance resurfaces as a relay-only ghost on next list.
      // Channel rows are excluded: the relay drops its dev-<id> remote row
      // itself when the hub device is revoked.
      if (inst && inst.kind !== "local" && inst.via !== "channel") {
        const host = hostKey(inst);
        if (host) {
          const relay = await localRelayRemotes().catch(() => null);
          const ids = new Set([id]);
          for (const m of relay?.remotes || []) if (hostKey(m) === host) ids.add(m.id);
          for (const rid of ids) localRelayRemotes("DELETE", undefined, rid).catch(() => undefined);
        }
      }
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

  /** Public /health probe: `{version, klanker_version?}` on relays that
   *  report it (agents-relay#27), null otherwise/unreachable. */
  async relayVersion(inst: KlankerInstance): Promise<{ version?: string; klanker_version?: string } | null> {
    try {
      const res = await fetch(base(inst) + "/health", { headers: headers(inst) });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== "object") return null;
      return {
        version: typeof body.version === "string" ? body.version : undefined,
        klanker_version: typeof body.klanker_version === "string" ? body.klanker_version : undefined,
      };
    } catch {
      return null;
    }
  },

  async authStatus(inst: KlankerInstance): Promise<{ authenticated: boolean; enabled: boolean; user: string; cookie_warning?: string }> {
    const r = await req<{ authenticated?: boolean; enabled?: boolean; user?: string; cookie_warning?: string }>(
      inst,
      "/v1/auth/status",
      { headers: headers(inst) }
    );
    return { authenticated: !!r.authenticated, enabled: !!r.enabled, user: r.user || "", cookie_warning: r.cookie_warning };
  },

  /** Exchange RELAY_WEB_TOKEN for the HttpOnly cookie (same-origin). */
  async login(inst: KlankerInstance, token: string): Promise<void> {
    await jsonReq(inst, "/v1/auth/login", { token });
  },

  async logout(inst: KlankerInstance): Promise<void> {
    await jsonReq(inst, "/v1/auth/logout", {});
  },

  // --- workspaces / personas ----------------------------------------------

  async listWorkspaces(inst: KlankerInstance): Promise<WorkspaceRow[]> {
    const r = await req<{ workspaces?: (WireRow | string)[] }>(inst, "/v1/workspaces", { headers: headers(inst) });
    return (r.workspaces || []).map((w) => mapWorkspaceRow(w));
  },

  /** PATCH /v1/workspaces/<id> — workspace config lives on the relay; no
   *  secrets may ever appear in `patch`. General keys and policy keys
   *  (WorkspacePolicyPatch) compose into one write — the server treats
   *  them as one atomic update. */
  async updateWorkspace(
    inst: KlankerInstance,
    id: string,
    patch: {
      label?: string;
      workdir?: string | null;
      workdir_lock?: boolean;
      browser_profile?: string | null;
      approval_mode?: "off" | "ask" | "strict" | null;
    } & Partial<WorkspacePolicyPatch>
  ): Promise<WorkspaceRow | null> {
    const r = await req<{ workspace?: WireRow }>(
      inst,
      `/v1/workspaces/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: headers(inst, true),
        body: JSON.stringify(patch),
      }
    );
    const w = r.workspace;
    if (!w || typeof w !== "object") return null;
    return mapWorkspaceRow(w, id);
  },

  /** Effective pick for a chat: session override when `session` is given,
   *  else the workspace last-used pick. `scope` names the source — older
   *  relays omit it and behave as "workspace". Stored on the relay. */
  async getModelPick(inst: KlankerInstance, workspace: string, session = ""): Promise<{ provider: string; model: string; scope: "session" | "workspace" }> {
    const params = new URLSearchParams();
    if (workspace) params.set("workspace", workspace);
    if (session) params.set("session", session);
    const q = params.toString() ? `?${params}` : "";
    try {
      const r = await req<{ provider?: string; model?: string; scope?: string }>(inst, `/v1/model${q}`, {
        headers: headers(inst),
      });
      return {
        provider: r.provider || "",
        model: r.model || "",
        scope: r.scope === "session" ? "session" : "workspace",
      };
    } catch {
      return { provider: "", model: "", scope: "workspace" };
    }
  },

  async setModelPick(
    inst: KlankerInstance,
    workspace: string,
    provider: string,
    model: string,
    session = ""
  ): Promise<{ provider: string; model: string }> {
    const r = await jsonReq<{ provider?: string; model?: string }>(inst, `/v1/model`, {
      workspace: workspace || undefined,
      provider: provider || undefined,
      model: model || undefined,
      session: session || undefined,
      clear: provider ? undefined : true,
    });
    return { provider: r.provider || "", model: r.model || "" };
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

  async listPersonas(
    inst: KlankerInstance,
    workspace: string
  ): Promise<{ id: string; name?: string; role?: string; system_append?: string; notes?: string; accepts_messages?: boolean; allow_peers?: boolean }[]> {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const r = await req<{ personas?: (WireRow | string)[] }>(inst, `/v1/personas${q}`, { headers: headers(inst) });
    return (r.personas || []).map((p) => {
      const o: WireRow = typeof p === "object" && p !== null ? p : {};
      const fallback = typeof p === "string" ? p : "";
      return {
        id: wstr(o.id) || fallback,
        name: wstr(o.name) || wstr(o.id) || fallback,
        role: wstr(o.role),
        system_append: wstr(o.system_append),
        notes: wstr(o.notes),
        accepts_messages: o.accepts_messages === undefined ? undefined : wbool(o.accepts_messages),
        allow_peers: o.allow_peers === undefined ? undefined : wbool(o.allow_peers),
      };
    });
  },

  /** POST /v1/workspaces/<ws>/personas — upsert the persona manifest
   *  (name/role/system_append; wire field for the system prompt fragment
   *  is `system_append`). Verify-after-write: relays that predate manifest
   *  updates silently no-op on existing personas — the re-read must show
   *  the saved fields or this throws loudly (klanker#161 U06). */
  async savePersona(
    inst: KlankerInstance,
    workspace: string,
    id: string,
    fields: {
      name?: string;
      role?: string;
      system_append?: string;
      notes?: string;
      accepts_messages?: boolean;
      allow_peers?: boolean;
    }
  ): Promise<{ id: string; name?: string; role?: string; system_append?: string }> {
    await jsonReq(inst, `/v1/workspaces/${encodeURIComponent(workspace)}/personas`, {
      id,
      name: fields.name || "",
      role: fields.role || "",
      system_append: fields.system_append || "",
      notes: fields.notes || "",
      accepts_messages: fields.accepts_messages !== false,
      allow_peers: fields.allow_peers !== false,
    });
    const rows = await this.listPersonas(inst, workspace);
    const row = rows.find((r) => r.id === id);
    // row.name falls back to the id server-side when the manifest name is
    // empty — the expected read-back mirrors that exactly.
    const expectedName = fields.name || id;
    const nameOk = !!row && (row.name || row.id) === expectedName;
    const roleOk = !!row && (row.role || "") === (fields.role || "");
    const appendOk = !!row && (row.system_append || "") === (fields.system_append || "");
    if (!row || !nameOk || !roleOk || !appendOk) {
      throw new Error("relay did not persist the persona update — it needs a newer agents-relay (update endpoint)");
    }
    return { id, ...fields };
  },

  /** GET /v1/workspaces/<ws>/inbox — per-persona handoff/unread counts +
   *  recent handoff events for the sidebar contacts badges. null when the
   *  relay predates the feed or denies it (ws_member tokens). */
  async wsInbox(inst: KlankerInstance, workspace: string): Promise<WsInbox | null> {
    try {
      const r = await req<{ personas?: WsInbox["personas"]; recent?: WsInbox["recent"] }>(
        inst,
        `/v1/workspaces/${encodeURIComponent(workspace)}/inbox`,
        { headers: headers(inst) }
      );
      return { personas: r.personas || {}, recent: r.recent || [] };
    } catch {
      return null;
    }
  },

  /** GET /v1/workspaces/<ws>/personas/<p>/inbox — full task rows incl.
   *  reply_summary (the ws-wide inbox `recent` feed flattens events and
   *  drops them; the tab enriches rows from here). */
  async personaInboxTasks(inst: KlankerInstance, workspace: string, persona: string): Promise<InboxTask[]> {
    try {
      const r = await req<{ tasks?: WireRow[]; inbox?: WireRow[] }>(
        inst,
        `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/inbox`,
        { headers: headers(inst) }
      );
      const rows = r.tasks || r.inbox || [];
      return rows.map((t) => ({
        id: wstr(t.id) || "",
        title: wstr(t.title),
        note: wstr(t.note),
        status: wstr(t.status),
        owner: wstr(t.owner),
        reply_summary: wstr(t.reply_summary),
        created_at: wstr(t.created_at),
        wake: t.wake === true,
      })).filter((t) => t.id);
    } catch {
      return [];
    }
  },

  /** POST /v1/workspaces/<ws>/personas/<p>/inbox — create a task/handoff. */
  async createInboxTask(
    inst: KlankerInstance,
    workspace: string,
    persona: string,
    fields: { title: string; note?: string }
  ): Promise<InboxTask> {
    const r = await jsonReq<{ task?: WireRow }>(
      inst,
      `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/inbox`,
      { title: fields.title, note: fields.note || "" }
    );
    const t = r.task || {};
    return { id: wstr(t.id) || "", title: fields.title, note: fields.note, status: wstr(t.status) || "open" };
  },

  /** POST /v1/workspaces/<ws>/personas/<p>/inbox/<task>/handoff — pass the
   *  task to a peer persona; wake=1 spawns its turn immediately
   *  (klanker#169 U15). */
  async handoffInboxTask(
    inst: KlankerInstance,
    workspace: string,
    persona: string,
    task: string,
    fields: { to: string; note?: string; wake?: boolean }
  ): Promise<void> {
    const wake = fields.wake ? "?wake=1" : "";
    await jsonReq(
      inst,
      `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/inbox/${encodeURIComponent(task)}/handoff${wake}`,
      { to: fields.to, note: fields.note || "" }
    );
  },

  /** Server-side sessions for (workspace, persona). */
  async listSessions(
    inst: KlankerInstance,
    workspace: string,
    persona: string
  ): Promise<{ id: string; goal?: string; title?: string; host?: string; created_at?: string; last_active?: string; branch?: string; repo?: string; wip_unpushed?: boolean }[]> {
    try {
      const r = await req<{ sessions?: WireRow[] }>(
        inst,
        `/v1/workspaces/${encodeURIComponent(workspace)}/personas/${encodeURIComponent(persona)}/sessions`,
        { headers: headers(inst) }
      );
      return (r.sessions || []).map((s) => ({
        id: wstr(s.id) || wstr(s.session) || "",
        goal: wstr(s.goal),
        title: wstr(s.title),
        host: wstr(s.host),
        branch: wstr(s.branch),
        repo: wstr(s.repo),
        wip_unpushed: s.wip_unpushed === true,
        created_at: wstr(s.created_at),
        last_active: wstr(s.last_active) || wstr(s.updated_at),
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

  /** Provider manifests known to the host loop. Successful fetches are
   *  cached per instance so an offline host still shows its last rows
   *  (marked via `stale`). */
  async listProviders(inst: KlankerInstance): Promise<{ rows: ProviderRow[]; stale: boolean }> {
    const cacheKey = `klanker.providers.${inst.id}`;
    try {
      const r = await req<{ providers?: WireRow[] }>(inst, "/v1/providers", { headers: headers(inst) });
      const rows = (r.providers || [])
        .map((p) => ({
          name: wstr(p.name) || "",
          kind: wstr(p.kind),
          model: wstr(p.model),
          when: wstr(p.when),
          models: Array.isArray(p.models)
            ? p.models.filter((m): m is string => typeof m === "string" && m !== "")
            : undefined,
          modes: Array.isArray(p.modes)
            ? p.modes.filter((m): m is string => typeof m === "string")
            : undefined,
          source: wstr(p.source),
          configurable: wbool(p.configurable),
          command: wstr(p.command),
          error: wstr(p.error),
          // Auth/endpoint metadata (klanker#169 U15): ProvidersPanel needs
          // these for key badges, ACP login hints and the Edit prefill —
          // stripping them here made every provider look keyless.
          url: wstr(p.url),
          url_env: wstr(p.url_env),
          key_env: wstr(p.key_env),
          key_configured: wbool(p.key_configured),
          auth_methods: Array.isArray(p.auth_methods)
            ? p.auth_methods.filter((m): m is string => typeof m === "string")
            : undefined,
          auth_required: wbool(p.auth_required),
        }))
        .filter((p) => p.name);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(rows));
      } catch {}
      return { rows, stale: false };
    } catch {
      const cached = this.cachedProviders(inst);
      return { rows: cached, stale: cached.length > 0 };
    }
  },

  /** Last fetched provider rows for this instance; [] when never seen. */
  cachedProviders(inst: KlankerInstance): ProviderRow[] {
    try {
      const raw = localStorage.getItem(`klanker.providers.${inst.id}`);
      const list = raw ? (JSON.parse(raw) as ProviderRow[]) : [];
      return Array.isArray(list) ? list.filter((p) => p && p.name) : [];
    } catch {
      return [];
    }
  },

  /** GET /v1/remote/dev-<id>/v1/providers through the local relay's mount
   *  (klanker#152): the provider manifest of a ws member host for the
   *  host-scoped chat picker — never proxied into a different host's chat.
   *  Successful fetches cache per mount id so an offline member still
   *  shows its last rows (marked stale); a member that never answered
   *  yields empty rows. */
  async listRemoteProviders(deviceId: string): Promise<{ rows: ProviderRow[]; stale: boolean }> {
    const mount = remoteMountId(deviceId);
    const cacheKey = `klanker.providers.${mount}`;
    try {
      const r = await localRelayJson<{ providers?: WireRow[] }>(
        `/v1/remote/${encodeURIComponent(mount)}/v1/providers`
      );
      const rows = (r.providers || [])
        .map((p) => ({
          name: wstr(p.name) || "",
          kind: wstr(p.kind),
          model: wstr(p.model),
          when: wstr(p.when),
          models: Array.isArray(p.models)
            ? p.models.filter((m): m is string => typeof m === "string" && m !== "")
            : undefined,
          modes: Array.isArray(p.modes)
            ? p.modes.filter((m): m is string => typeof m === "string")
            : undefined,
          source: wstr(p.source),
          configurable: wbool(p.configurable),
          command: wstr(p.command),
          error: wstr(p.error),
          // Auth/endpoint metadata (klanker#169 U15): ProvidersPanel needs
          // these for key badges, ACP login hints and the Edit prefill —
          // stripping them here made every provider look keyless.
          url: wstr(p.url),
          url_env: wstr(p.url_env),
          key_env: wstr(p.key_env),
          key_configured: wbool(p.key_configured),
          auth_methods: Array.isArray(p.auth_methods)
            ? p.auth_methods.filter((m): m is string => typeof m === "string")
            : undefined,
          auth_required: wbool(p.auth_required),
        }))
        .filter((p) => p.name);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(rows));
      } catch {}
      return { rows, stale: false };
    } catch {
      const cached = this.cachedHostProviders(deviceId);
      return { rows: cached, stale: cached.length > 0 };
    }
  },

  /** Last fetched provider rows for a remote member host (dev-<id> mount
   *  cache); [] when never seen. */
  cachedHostProviders(deviceId: string): ProviderRow[] {
    try {
      const raw = localStorage.getItem(`klanker.providers.${remoteMountId(deviceId)}`);
      const list = raw ? (JSON.parse(raw) as ProviderRow[]) : [];
      return Array.isArray(list) ? list.filter((p) => p && p.name) : [];
    } catch {
      return [];
    }
  },

  /** POST /v1/providers — writes a manifest under <host>/providers
   *  (agents-relay#36). Throws on env-managed name collisions. */
  async addProvider(
    inst: KlankerInstance,
    body: {
      name: string;
      kind?: string;
      url?: string;
      url_env?: string;
      key_env?: string;
      model?: string;
      models?: string[];
      command?: string;
    }
  ): Promise<ProviderRow> {
    const r = await jsonReq<{ provider?: ProviderRow }>(inst, "/v1/providers", body);
    return r.provider || ({ name: body.name } as ProviderRow);
  },

  async deleteProvider(inst: KlankerInstance, name: string): Promise<void> {
    await req(inst, `/v1/providers/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: headers(inst),
    });
  },

  /** GET /v1/providers/<name>/probe — health/auth status for the settings
   *  test button. Missing on older relays → null. */
  async probeProvider(
    inst: KlankerInstance,
    name: string
  ): Promise<{ status?: string; detail?: string; models?: string[]; modes?: string[] } | null> {
    try {
      return await req(inst, `/v1/providers/${encodeURIComponent(name)}/probe`, {
        headers: headers(inst),
      });
    } catch {
      return null;
    }
  },

  /** Host-side {provider,model} stars (agents-relay#39). Older relays 404 —
   *  localStorage keeps the stars per instance in that case. */
  async listFavorites(inst: KlankerInstance): Promise<ModelPick[]> {
    const cacheKey = `klanker.favorites.${inst.id}`;
    try {
      const r = await req<{ favorites?: ModelPick[] }>(inst, "/v1/favorites", {
        headers: headers(inst),
      });
      const rows = (r.favorites || []).filter((f) => f && f.provider);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(rows));
      } catch {}
      return rows;
    } catch {
      try {
        const raw = localStorage.getItem(cacheKey);
        const list = raw ? (JSON.parse(raw) as ModelPick[]) : [];
        return Array.isArray(list) ? list.filter((f) => f && f.provider) : [];
      } catch {
        return [];
      }
    }
  },

  async starFavorite(inst: KlankerInstance, provider: string, model: string, star: boolean): Promise<ModelPick[]> {
    const cacheKey = `klanker.favorites.${inst.id}`;
    try {
      const r = await jsonReq<{ favorites?: ModelPick[] }>(inst, "/v1/favorites", {
        provider,
        model,
        star,
      });
      const rows = (r.favorites || []).filter((f) => f && f.provider);
      try {
        localStorage.setItem(cacheKey, JSON.stringify(rows));
      } catch {}
      return rows;
    } catch {
      const rows = await this.listFavorites(inst);
      const next = star
        ? [{ provider, model }, ...rows.filter((f) => !(f.provider === provider && f.model === model))]
        : rows.filter((f) => !(f.provider === provider && f.model === model));
      try {
        localStorage.setItem(cacheKey, JSON.stringify(next));
      } catch {}
      return next;
    }
  },

  /** VAPID public key for web push; null when the relay predates push. */
  async pushVapidKey(inst: KlankerInstance): Promise<string | null> {
    try {
      const r = await req<{ key?: string; publicKey?: string }>(inst, "/v1/push/vapid-key", {
        headers: headers(inst),
      });
      return r.key || r.publicKey || null;
    } catch {
      return null;
    }
  },

  /** Register a Web Push subscription for this ws/persona (relay#push). */
  async pushSubscribe(
    inst: KlankerInstance,
    body: { workspace?: string; persona?: string; subscription: unknown }
  ): Promise<void> {
    await jsonReq(inst, "/v1/push/subscribe", body);
  },

  /** Session record + trace events; null when unknown. */
  async sessionEvents(
    inst: KlankerInstance,
    workspace: string,
    persona: string,
    session: string
  ): Promise<SessionEvent[] | null> {
    try {
      const r = await req<{ session?: SessionEvent; events?: SessionEvent[] }>(
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
      mode?: string;
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
      throw new Error(httpErrorMessage(res.status, msg));
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
          if (line.startsWith(": ping")) {
            yield { type: "ping" }; // keepalive: lets callers tell a live quiet stream from a dead one
            continue;
          }
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

  /**
   * GET /v1/runs/stream — attach to a running turn on this relay (klanker#92).
   * Yields {"attach",run,meta} then buffered+live start/status/delta/trailer.
   * 404 when no matching run is active.
   */
  async *attachRun(
    inst: KlankerInstance,
    q: { run?: string; session?: string; workspace?: string; persona?: string }
  ): AsyncGenerator<{ type: string; text?: string; run?: string; session?: string; meta?: Record<string, string> }> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) qs.set(k, v);
    const res = await authedFetch(inst, `${base(inst)}/v1/runs/stream?${qs}`, {
      headers: { ...headers(inst), Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) {
      const msg = await res.text().catch(() => "");
      throw new Error(httpErrorMessage(res.status, msg));
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
          if (line.startsWith(": ping")) {
            yield { type: "ping" }; // keepalive: lets callers tell a live quiet stream from a dead one
            continue;
          }
          if (!line.startsWith("data:")) continue;
          try {
            yield JSON.parse(line.slice(5).trim());
          } catch {}
        }
      }
    }
  },

  // --- approvals (agents-relay#12) -----------------------------------------

  /** First pending approval matching this chat. When `opts.session` or
   *  `opts.device` is given, rows claiming a DIFFERENT session/device are
   *  skipped — deciding a foreign session's ask under this banner would
   *  resume the wrong turn (klanker#152 R12). Legacy rows without
   *  session/device fields still match (old relays). */
  async pendingApproval(
    inst: KlankerInstance,
    workspaceId = "",
    opts?: { session?: string; device?: string }
  ): Promise<PendingApproval | null> {
    try {
      const ws = workspaceId.trim();
      const q = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
      const r = await req<{ approvals?: PendingApproval[] }>(inst, `/v1/approvals${q}`, {
        headers: headers(inst),
      });
      const rows = r.approvals || [];
      return filterPendingApprovals(rows, opts)[0] ?? null;
    } catch {
      return null;
    }
  },

  /** All currently matching approval rows. The UI consumes them as a strict
   *  FIFO queue — deciding row 1 re-polls and row 2 becomes visible. */
  async pendingApprovals(
    inst: KlankerInstance,
    workspaceId = "",
    opts?: { session?: string; device?: string }
  ): Promise<PendingApproval[]> {
    try {
      const ws = workspaceId.trim();
      const q = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
      const r = await req<{ approvals?: PendingApproval[] }>(inst, `/v1/approvals${q}`, {
        headers: headers(inst),
      });
      return filterPendingApprovals(r.approvals || [], opts);
    } catch {
      return [];
    }
  },

  async resolveApproval(inst: KlankerInstance, approvalId: string, allow: boolean, remember = false): Promise<void> {
    // remember=true is the "Allow always" wire flag (U02) — the relay
    // persists the rule so matching future asks skip the prompt.
    await jsonReq(inst, `/v1/approvals/${encodeURIComponent(approvalId)}`, remember ? { allow, remember: true } : { allow });
  },

  // --- auto-recall (workspace config on the serving relay) -----------------

  async getRecall(inst: KlankerInstance, workspace: string): Promise<boolean> {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const r = await req<{ recall?: { enabled?: boolean } }>(inst, `/v1/klanker/recall${q}`, {
      headers: headers(inst),
    });
    return !!r.recall?.enabled;
  },

  async setRecall(inst: KlankerInstance, workspace: string, enabled: boolean): Promise<boolean> {
    const r = await jsonReq<{ recall?: { enabled?: boolean } }>(inst, "/v1/klanker/recall", {
      workspace,
      enabled,
    });
    return !!r.recall?.enabled;
  },

  // --- OS autostart (desktop only; tauri-plugin-autostart) ------------------

  async autostartIsEnabled(): Promise<boolean> {
    if (!caps.spawn) return false;
    try {
      return !!(await invoke<boolean>("autostart_is_enabled"));
    } catch {
      return false;
    }
  },

  async autostartSet(enabled: boolean): Promise<void> {
    if (!caps.spawn) return;
    await invoke("autostart_set", { enabled });
  },

  // --- traces (agents-relay#12) ---------------------------------------------

  async readRecentTraces(inst: KlankerInstance, workspaceId = "", limit = 40): Promise<TracePage> {
    const ws = workspaceId.trim();
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

  /** `ts` of the session's newest trace event — the cheap change detector for
   *  cross-device sync (one raw JSONL line instead of the full events pull). */
  async sessionTailTs(inst: KlankerInstance, workspace: string, session: string): Promise<string> {
    try {
      const wq = workspace ? `&workspace=${encodeURIComponent(workspace)}` : "";
      const r = await req<{ lines?: string[] }>(
        inst,
        `/v1/traces?limit=1&session=${encodeURIComponent(session)}${wq}`,
        { headers: headers(inst) }
      );
      const line = r.lines?.[0];
      if (!line) return "";
      return String(JSON.parse(line).ts || "");
    } catch {
      return "";
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
      const r = await req<{ jobs?: WireRow[] }>(inst, `/v1/jobs${q}`, { headers: headers(inst) });
      return (r.jobs || []).map((j): JobRow => ({
        id: wstr(j.id) || "",
        goal: wstr(j.goal),
        status: wstr(j.status),
        result: wstr(j.result),
        created_at: wstr(j.created_at),
      }));
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
    const r = await jsonReq<{ job?: WireRow }>(inst, "/v1/jobs", body);
    return { id: wstr(r.job?.id), status: wstr(r.job?.status) };
  },

  // --- klanker management (/v1/klanker/*, klanker serve hosts only) ----------

  async listSkills(inst: KlankerInstance, workspace: string): Promise<{ name: string; files: number; bytes: number }[]> {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const r = await req<{ skills?: WireRow[] }>(inst, `/v1/klanker/skills${q}`, { headers: headers(inst) });
    return (r.skills || []).map((s) => ({
      name: wstr(s.name) || "",
      files: typeof s.files === "number" ? s.files : 0,
      bytes: typeof s.bytes === "number" ? s.bytes : 0,
    }));
  },

  async deleteSkill(inst: KlankerInstance, workspace: string, name: string): Promise<void> {
    const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    await req(inst, `/v1/klanker/skills/${encodeURIComponent(name)}${q}`, { method: "DELETE", headers: headers(inst) });
  },

  async listRoutines(inst: KlankerInstance): Promise<RoutineRow[]> {
    const r = await req<{ routines?: WireRow[] }>(inst, "/v1/klanker/routines", { headers: headers(inst) });
    return (r.routines || []).map((row) => ({
      name: wstr(row.name) || "",
      workspace: wstr(row.workspace),
      prompt: wstr(row.prompt),
      at: wstr(row.at),
      cron: wstr(row.cron),
      paused: wbool(row.paused),
    }));
  },

  async createRoutine(
    inst: KlankerInstance,
    body: { name: string; prompt: string; at?: string; cron?: string; timezone?: string; workspace?: string; user?: string }
  ): Promise<void> {
    await jsonReq(inst, "/v1/klanker/routines", body);
  },

  async routineAction(inst: KlankerInstance, name: string, action: "pause" | "resume" | "run" | "remove"): Promise<RoutineActionResult> {
    return jsonReq<RoutineActionResult>(inst, `/v1/klanker/routines/${encodeURIComponent(name)}`, { action });
  },

  async listMemory(inst: KlankerInstance, workspace: string, q = ""): Promise<{ path: string; bytes: number }[]> {
    const wq = workspace ? `workspace=${encodeURIComponent(workspace)}&` : "";
    const r = await req<{ files?: WireRow[] }>(inst, `/v1/klanker/memory?${wq}q=${encodeURIComponent(q)}`, { headers: headers(inst) });
    return (r.files || []).map((f) => ({
      path: wstr(f.path) || "",
      bytes: typeof f.bytes === "number" ? f.bytes : 0,
    }));
  },

  async readMemory(inst: KlankerInstance, workspace: string, path: string): Promise<string> {
    const wq = workspace ? `&workspace=${encodeURIComponent(workspace)}` : "";
    const r = await req<{ content?: string }>(inst, `/v1/klanker/memory/file?path=${encodeURIComponent(path)}${wq}`, { headers: headers(inst) });
    return r.content || "";
  },

  async deleteMemory(inst: KlankerInstance, workspace: string, path: string): Promise<void> {
    const wq = workspace ? `&workspace=${encodeURIComponent(workspace)}` : "";
    await req(inst, `/v1/klanker/memory/file?path=${encodeURIComponent(path)}${wq}`, { method: "DELETE", headers: headers(inst) });
  },

  // --- not available in the browser -----------------------------------------
  // Tailnet discovery: desktop uses its native CLI scan; the web surface
  // asks the serving relay to run the same probe server-side (/v1/discover).

  async discoverPeers(inst?: KlankerInstance): Promise<DiscoveredPeer[]> {
    if (isTauri()) {
      try {
        const peers = await invoke<DiscoveredPeer[]>("discover_peers");
        if (peers.length) return peers;
      } catch {}
    }
    try {
      const res = inst
        ? await req<{ peers?: DiscoveredPeer[] }>(inst, "/v1/discover", { headers: headers(inst) })
        : await fetch("/v1/discover").then((r) => (r.ok ? r.json() : { peers: [] }));
      return res.peers || [];
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
    const st = await invoke<ServeStatus>("serve_status");
    if (st.port) localServePort = st.port;
    return st;
  },
  /** hubMode binds the spawned serve on 0.0.0.0 (LAN hub) — the desktop
   *  settings toggle. Passed per call; the serve env is the only sink. */
  async serveEnsureLocal(hubMode?: boolean): Promise<ServeStatus> {
    const st = await invoke<ServeStatus>("serve_ensure_local", { hubMode });
    if (st.port) localServePort = st.port;
    return st;
  },
  async serveRestart(hubMode?: boolean): Promise<ServeStatus> {
    const st = await invoke<ServeStatus>("serve_restart", { hubMode });
    if (st.port) localServePort = st.port;
    return st;
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
    const st = await this.serveEnsureLocal(settings.hub_mode);
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

  // --- Wave 5 Phase 2: /v1/events, pairing, store, capabilities ----------

  async getCapabilities(inst: KlankerInstance): Promise<RelayCapabilities> {
    try {
      const res = await authedFetch(inst, `${base(inst)}/v1/capabilities`, {
        headers: headers(inst),
      });
      if (!res.ok) return { store: false, voice: false, caldav: false };
      const r = (await res.json()) as Partial<RelayCapabilities>;
      return {
        store: Boolean(r.store),
        voice: Boolean(r.voice),
        caldav: Boolean(r.caldav),
      };
    } catch {
      return { store: false, voice: false, caldav: false };
    }
  },

  async createPairCode(
    inst: KlankerInstance,
    mode: "web" | "remote" = "web",
    ttlSec = 60
  ): Promise<PairCreateResult> {
    return jsonReq<PairCreateResult>(inst, "/v1/pair/create", {
      mode,
      ttl_sec: ttlSec,
    });
  },

  async redeemPairToken(
    inst: KlankerInstance,
    credential: string
  ): Promise<{ ok: boolean; mode?: string; host_id?: string; token?: string; error?: string }> {
    const res = await fetch(`${base(inst)}/v1/pair/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: credential }),
    });
    const text = await res.text().catch(() => "");
    let data: { ok?: boolean; mode?: string; host_id?: string; token?: string; error?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `${res.status}`);
    }
    return {
      ok: true,
      mode: data.mode,
      host_id: data.host_id,
      token: data.token,
    };
  },

  async listStoreItems(
    inst: KlankerInstance,
    workspaceId: string,
    kind?: string,
    status?: string
  ): Promise<StoreListResult> {
    const ws = workspaceId.trim();
    if (!ws) return { supported: false, items: [] };
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (status) qs.set("status", status);
    const suffix = qs.toString() ? `?${qs}` : "";
    const res = await authedFetch(
      inst,
      `${base(inst)}/v1/workspaces/${encodeURIComponent(ws)}/store/items${suffix}`,
      { headers: headers(inst) }
    );
    const text = await res.text().catch(() => "");
    return parseStoreListResponse(res.status, text);
  },

  async renderStorePane(
    inst: KlankerInstance,
    workspaceId: string,
    entityId: string,
    target: "markdown" | "ical" | "html" = "markdown"
  ): Promise<StorePaneResult> {
    const r = await req<StorePaneResult>(
      inst,
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/store/pane/${encodeURIComponent(entityId)}?target=${encodeURIComponent(target)}`,
      { headers: headers(inst) }
    );
    return r;
  },

  async appendStoreItem(
    inst: KlankerInstance,
    workspaceId: string,
    domain: string,
    payload: Record<string, unknown>
  ): Promise<{ id: string; actor?: string }> {
    return jsonReq<{ id: string; actor?: string }>(
      inst,
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/store/append`,
      { domain, payload }
    );
  },

  async openRelayEvents(
    inst: KlankerInstance,
    signal: AbortSignal,
    onEvent: (ev: RelayEvent) => void,
    workspace = ""
  ): Promise<void> {
    const ws = workspace.trim();
    const qs = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
    const res = await authedFetch(inst, `${base(inst)}/v1/events${qs}`, {
      headers: { ...headers(inst), Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`events ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        let crlfIdx = buf.indexOf("\r\n\r\n");
        while (idx >= 0 || crlfIdx >= 0) {
          const splitAt =
            idx >= 0 && (crlfIdx < 0 || idx < crlfIdx) ? idx : crlfIdx;
          const sepLen = splitAt === idx ? 2 : 4;
          const frame = buf.slice(0, splitAt);
          buf = buf.slice(splitAt + sepLen);
          for (const ev of parseSseChunk(frame)) {
            onEvent(ev);
          }
          idx = buf.indexOf("\n\n");
          crlfIdx = buf.indexOf("\r\n\r\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  // --- hub links / paired devices / ws-share (agents-relay#43) ---------
  // Operator surfaces on the LOCAL relay: desktop goes over loopback with
  // the keyring bearer, PWA uses same-origin (cookie/bearer session).
  // All deny ws_member device tokens server-side.

  /** GET /v1/hub/links — live paired-hub links (this relay as spoke). */
  /** GET /v1/host — this relay's host identity (U01 contract). */
  async fetchHostInfo(): Promise<HostInfo> {
    return localRelayJson<HostInfo>("/v1/host");
  },

  /** PATCH /v1/host — rename this host; the friendly label is what every
   *  device row, host picker and session pill displays. */
  async setHostLabel(label: string): Promise<HostInfo> {
    return localRelayJson<HostInfo>("/v1/host", "PATCH", { label });
  },

  /** POST /v1/providers/secret — write a provider key into the host secret
   *  vault (U01 contract). One-way: the API never reads secrets back, so
   *  the UI must clear the input after save and rely on key_configured. */
  async setProviderSecret(inst: KlankerInstance, keyEnv: string, value: string): Promise<{ ok: boolean }> {
    return jsonReq<{ ok: boolean }>(inst, "/v1/providers/secret", { key_env: keyEnv, value });
  },

  /** Tauri-native folder picker — desktop only (caps.spawn). Resolves null
   *  when the user cancels or the shell is a plain browser. */
  async pickFolder(title = "Choose folder"): Promise<string | null> {
    if (!caps.spawn) return null;
    try {
      const dir = await (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<string | null> } } })
        .__TAURI__.core.invoke("plugin:dialog|open", { options: { directory: true, title } });
      return typeof dir === "string" && dir ? dir : null;
    } catch {
      return null;
    }
  },

  async fetchHubLinks(): Promise<HubLink[]> {
    const r = await localRelayJson<{ links?: HubLink[] }>("/v1/hub/links");
    return r.links || [];
  },

  /** POST /v1/hub/connect — redeem a ws/hub invite (`url` may carry a
   *  `#pair=` fragment) and attach the live channel without a restart. */
  async connectHub(params: {
    url: string;
    code?: string;
    token?: string;
    label?: string;
  }): Promise<HubConnectResult> {
    return localRelayJson<HubConnectResult>("/v1/hub/connect", "POST", {
      ...params,
    });
  },

  /** DELETE /v1/hub/links/<hub_id> — stop the channel client, drop the
   *  hubs.json row + vault token. */
  async disconnectHub(id: string): Promise<void> {
    await localRelayJson(`/v1/hub/links/${encodeURIComponent(id)}`, "DELETE");
  },

  /** GET /v1/hub/devices — devices paired with this relay (hub side). */
  async fetchHubDevices(): Promise<HubDevice[]> {
    const r = await localRelayJson<{ devices?: HubDevice[] }>("/v1/hub/devices");
    return r.devices || [];
  },

  /** DELETE /v1/hub/devices/<id> — revoke a paired device (total: live
   *  stream, leases and the dev-<id> remote row all drop). */
  async revokeHubDevice(id: string): Promise<void> {
    await localRelayJson(`/v1/hub/devices/${encodeURIComponent(id)}`, "DELETE");
  },

  /** GET /v1/hub/leases — active (ws, session) execution leases. */
  async fetchHubLeases(): Promise<HubLease[]> {
    const r = await localRelayJson<{ leases?: HubLease[] }>("/v1/hub/leases");
    return r.leases || [];
  },

  /** POST /v1/ws/invite — single-use code redeeming as device pair +
   *  workspace member grant. Owner device or admin token only. */
  async createWsInvite(ws: string, ttlSec = 60): Promise<WsInvite> {
    return localRelayJson<WsInvite>("/v1/ws/invite", "POST", {
      ws,
      ttl_sec: ttlSec,
    });
  },

  /** PATCH /v1/workspaces/<ws> — ownership/share policy keys only.
   *  ws_member tokens are denied these fields server-side. */
  async patchWorkspacePolicy(
    ws: string,
    patch: WorkspacePolicyPatch
  ): Promise<WorkspaceRow | null> {
    const r = await localRelayJson<{ workspace?: WireRow }>(
      `/v1/workspaces/${encodeURIComponent(ws)}`,
      "PATCH",
      { ...patch }
    );
    const w = r.workspace;
    if (!w || typeof w !== "object") return null;
    return mapWorkspaceRow(w, ws);
  },

  /** GET /v1/workspaces/<ws>/repo-paths — this host's checkout map
   *  (host_paths.json). Owner/admin only; older relays and denied
   *  callers read an empty map rather than throwing. */
  async fetchRepoPaths(ws: string): Promise<Record<string, string>> {
    try {
      const r = await localRelayJson<{ paths?: Record<string, unknown> }>(
        `/v1/workspaces/${encodeURIComponent(ws)}/repo-paths`
      );
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.paths || {})) {
        if (typeof v === "string" && v) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  },

  /** PUT /v1/workspaces/<ws>/repo-paths — write host-local checkout
   *  paths (server applies each slug via set_host_repo_path). */
  async putRepoPaths(ws: string, paths: Record<string, string>): Promise<void> {
    await localRelayJson(
      `/v1/workspaces/${encodeURIComponent(ws)}/repo-paths`,
      "PUT",
      { paths }
    );
  },

  /** GET /v1/workspaces/<ws>/hosts — member devices + presence + active
   *  leases for the host picker. */
  async fetchWorkspaceHosts(ws: string): Promise<WorkspaceHosts> {
    return localRelayJson<WorkspaceHosts>(
      `/v1/workspaces/${encodeURIComponent(ws)}/hosts`
    );
  },

  /** POST .../sessions/<sid>/host — checkpoint -> rebind -> cleanup.
   *  Returns the parsed payload instead of throwing so a 409
   *  `lease_held`/`wip_unpushed` conflict reaches the caller with the
   *  lease holder intact. */
  async switchSessionHost(
    ws: string,
    session: string,
    host: string,
    force = false
  ): Promise<SessionHostSwitch> {
    const path = `/v1/workspaces/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(session)}/host`;
    const body = { host, force };
    let res: Response | null;
    if (caps.keyring) {
      res = await localRelayFetch(path, "POST", body as Record<string, unknown>);
      if (res === null) throw new Error("local relay unreachable");
    } else {
      res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      noteAuthResponse(path, res.status);
    }
    const text = await res.text().catch(() => "");
    let data: SessionHostSwitch = {};
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok && !data.error) throw new Error(`session host switch: ${res.status}`);
    return data;
  },
};

/** Minimal authenticated transport primitives for feature-specific services.
 *  Domain helpers belong in those services; api.ts exposes only routing/auth. */
export async function apiRequest<T = unknown>(
  inst: KlankerInstance,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  return req<T>(inst, path, init);
}

export async function apiJson<T = unknown>(inst: KlankerInstance, path: string, body: object): Promise<T> {
  return jsonReq<T>(inst, path, body);
}

export async function apiFetch(inst: KlankerInstance, path: string, init: RequestInit = {}): Promise<Response> {
  return authedFetch(inst, base(inst) + path, init);
}

export interface ServeStatus {
  state: "running" | "starting" | "stopped" | "lost" | "not_found" | string;
  pid?: number;
  owned: boolean;
  port: number;
  /** Bind host the spawned serve uses: 127.0.0.1 or 0.0.0.0 (hub mode). */
  host?: string;
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

/** Serialize a relay workspace row (list/GET/PATCH all share the shape);
 *  policy keys ride along when the relay serves them (agents-relay#43). */
function mapWorkspaceRow(w: WireRow | string, fallbackId = ""): WorkspaceRow {
  const o: WireRow = typeof w === "object" && w !== null ? w : {};
  const fallback = typeof w === "string" ? w : "";
  const id = wstr(o.id) || fallback || fallbackId;
  const row: WorkspaceRow = {
    id,
    label: wstr(o.label) || wstr(o.name) || wstr(o.id) || id,
    workdir: wstr(o.workdir),
    workdir_lock: wbool(o.workdir_lock),
    browser_profile: wstr(o.browser_profile),
    approval_mode: wstr(o.approval_mode),
  };
  if (o.sync_policy !== undefined) row.sync_policy = wstr(o.sync_policy);
  if (Array.isArray(o.sync_hosts)) row.sync_hosts = o.sync_hosts.map(String);
  if (o.default_host !== undefined) row.default_host = wstr(o.default_host);
  if (Array.isArray(o.repos)) row.repos = o.repos as WsRepoPatch[];
  if (o.execution && typeof o.execution === "object") row.execution = o.execution as Record<string, unknown>;
  return row;
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
  // Listing is pure: no implicit import of stale localStorage bookmarks.
  // That move is the explicit one-time migrateLegacyInstances() — a poll
  // must never write (klanker#149).
  if (isTauri()) {
    try {
      return (await invoke<Record<string, unknown>[]>("instances_list")).map(mapLegacyInstance);
    } catch {
      return [];
    }
  }
  // Web/PWA: the serving relay holds the registry + secrets server-side.
  const remote = await relayRemotes();
  if (remote !== null) return remote;
  const ls = load(LS_INSTANCES, [] as KlankerInstance[]);
  return Array.isArray(ls) ? ls : [];
}

/** `/v1/remotes` rows as mounted instances; null = relay predates the mount API. */
async function relayRemotes(): Promise<KlankerInstance[] | null> {
  try {
    const r = await fetch("/v1/remotes");
    noteAuthResponse("/v1/remotes", r.status);
    if (!r.ok) return null;
    const data = await r.json();
    const now = new Date().toISOString();
    return ((data.remotes || []) as {
      id: string;
      base_url: string;
      label: string;
      via?: string;
      device_id?: string;
      has_secret: boolean;
    }[]).map(
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
        via: m.via === "channel" ? "channel" : "relay",
        device_id: m.device_id || undefined,
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

type RelayRemoteRow = {
  id: string;
  base_url: string;
  label: string;
  via?: string;
  device_id?: string;
  has_secret?: boolean;
};

function mapRelayRemoteRow(raw: unknown): RelayRemoteRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = wstr(row.id);
  if (!id) return null;
  return {
    id,
    base_url: wstr(row.base_url) || "",
    label: wstr(row.label) || "",
    via: wstr(row.via),
    device_id: wstr(row.device_id),
    has_secret: typeof row.has_secret === "boolean" ? row.has_secret : undefined,
  };
}

/** Adopt the relay's canonical upsert row after host dedupe (#144): the
 *  pre-dedupe client id must never survive when the server reused an
 *  existing mount. */
function mergeCanonicalRemote(inst: KlankerInstance, remote: RelayRemoteRow | undefined): KlankerInstance {
  if (!remote?.id) return inst;
  const baseUrl = remote.base_url || inst.endpoint?.base_url || inst.base_url || "";
  const out: KlankerInstance = {
    ...inst,
    id: remote.id,
    slug: remote.id,
    name: remote.label || inst.name || remote.id,
    via: remote.via === "channel" ? "channel" : "relay",
    device_id: remote.device_id || undefined,
    has_secret: remote.has_secret ?? (!!(inst.secret || inst.endpoint?.secret) || !!inst.has_secret),
  };
  if (baseUrl) out.endpoint = { ...(out.endpoint || {}), base_url: baseUrl };
  if (out.base_url !== undefined) out.base_url = baseUrl;
  return out;
}

/** Endpoint host — the dedupe key between the desktop file registry and
 *  the relay-side remotes.json (same key as keyring accounts). */
function hostKey(inst: { endpoint?: { base_url?: string }; base_url?: string }): string {
  try {
    return new URL(inst.endpoint?.base_url || inst.base_url || "").host;
  } catch {
    return "";
  }
}

/** Managed local relay fetch — desktop talks to the canonical host relay
 *  on loopback (remotes graph, presence registry). PWA uses same-origin
 *  paths instead. */
async function localRelayFetch(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: Record<string, unknown>
): Promise<Response | null> {
  if (!caps.keyring) return null;
  try {
    const secret =
      secretCache.get("relay.local") ||
      (await invoke<string | null>("secret_get", { account: "relay.local" }).catch(() => null)) ||
      "";
    return await fetch(`${localRelayBaseUrl()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return null;
  }
}

/** JSON call against the managed local relay (desktop loopback + keyring
 *  bearer) or, on PWA, the same-origin relay (cookie/session). Throws on
 *  HTTP errors with the relay's `error` field attached as `payload` —
 *  structured conflicts (409 holder) are readable off the Error. */
async function localRelayJson<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: Record<string, unknown>
): Promise<T> {
  let res: Response | null;
  if (caps.keyring) {
    res = await localRelayFetch(path, method, body);
    if (res === null) throw new Error("local relay unreachable");
  } else {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    noteAuthResponse(path, res.status);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = text;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
      msg = (payload as { error?: string }).error || text;
    } catch {}
    const err = new Error(
      /^\s*</.test(msg)
        ? httpErrorMessage(res.status, msg)
        : `${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ""}`
    );
    (err as Error & { status?: number; payload?: unknown }).status = res.status;
    (err as Error & { payload?: unknown }).payload = payload;
    throw err;
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Managed local relay `/v1/remotes` — the canonical remote graph shared
 *  with PWA clients of this host. The desktop file registry mirrors into
 *  it so an instance added on either surface appears on both (#60).
 *  Returns null only when the relay is unreachable (network). An HTTP
 *  error — above all a 401 credential mismatch — throws loudly: silent
 *  nulls here are how stale keyring secrets got promoted into the
 *  canonical vault (klanker#144). */
async function localRelayRemotes(
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
  id?: string
): Promise<{
  remotes?: RelayRemoteRow[];
  remote?: RelayRemoteRow;
} | null> {
  const res = await localRelayFetch(`/v1/remotes${id ? `/${encodeURIComponent(id)}` : ""}`, method, body);
  if (res === null) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`local relay /v1/remotes ${method} failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { remotes?: unknown; remote?: unknown };
  return {
    remotes: Array.isArray(data.remotes)
      ? data.remotes.map(mapRelayRemoteRow).filter((r): r is RelayRemoteRow => !!r)
      : undefined,
    remote: mapRelayRemoteRow(data.remote) || undefined,
  };
}

/** POST /v1/remotes on the same-origin relay (PWA path). false = relay
 *  unreachable (offline fallback is legitimate); an HTTP error throws —
 *  a refused write must never fall back to localStorage silently
 *  (klanker#144). */
async function remoteSave(inst: KlankerInstance): Promise<true | RelayRemoteRow | false> {
  let r: Response;
  try {
    r = await fetch("/v1/remotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: inst.id,
        base_url: inst.endpoint?.base_url || inst.base_url || "",
        label: inst.name,
        secret: inst.secret || inst.endpoint?.secret || "",
      }),
    });
  } catch {
    return false;
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`remote save refused: ${r.status} ${detail.slice(0, 200)}`);
  }
  const data = (await r.json().catch(() => ({}))) as { remote?: unknown };
  return mapRelayRemoteRow(data.remote) || true;
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
  const remote = await remoteSave(inst);
  if (remote) {
    const merged = mergeCanonicalRemote(inst, typeof remote === "object" ? remote : undefined);
    return { ...stripSecrets(merged), via: "relay", has_secret: merged.has_secret || !!(inst.secret || inst.endpoint?.secret) };
  }
  lsWrite(inst);
  return inst;
}

function lsWrite(inst: KlankerInstance): void {
  const clean = stripSecrets(inst);
  const ls = load(LS_INSTANCES, [] as KlankerInstance[]);
  const arr = Array.isArray(ls) ? ls.map(stripSecrets) : [];
  const idx = arr.findIndex((i) => i.id === clean.id);
  if (idx >= 0) arr[idx] = clean;
  else arr.push(clean);
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
    endpoint: { base_url: `http://127.0.0.1:${localServePort}` },
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
    kind: "local",
    endpoint: { base_url: "" },
    created_at: now,
    updated_at: now,
  };
}
