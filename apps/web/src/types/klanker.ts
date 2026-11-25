export type InstanceKind = "local" | "remote";

export interface InstanceEndpoint {
  base_url: string;
  secret?: string;
}

export interface InstanceTailscale {
  node: string;
  fqdn?: string;
}

/** Host provider manifest row as served by GET /v1/providers. */
export interface ProviderRow {
  name: string;
  kind?: string;
  model?: string;
  when?: string;
  models?: string[];
  modes?: string[];
  /** "file" = manifest under <host>/providers (deletable); "env" = managed by the host. */
  source?: string;
  configurable?: boolean;
  /** ACP agent command on file-managed acp-agent manifests. */
  command?: string;
  url?: string;
  url_env?: string;
  key_env?: string;
  /** Probe/config error reported by the relay (e.g. missing agent command). */
  error?: string;
}

/** Flat {provider, model} tuple — the pick unit for chat overrides and favorites. */
export interface ModelPick {
  provider: string;
  model: string;
}

export interface DesktopSettings {
  /** Fallback workdir boundary for local instances without their own. */
  workspace: string;
  /** Launch the desktop app on OS login (tauri-plugin-autostart). */
  autostart: boolean;
  /** Bind the managed serve on 0.0.0.0 (LAN hub) instead of 127.0.0.1. */
  hub_mode: boolean;
}

export interface KlankerInstance {
  id: string;
  name: string;
  slug: string;
  role: string;
  provider: string;
  model: string;
  base_url?: string;
  workspace: string;
  lock_workspace: boolean;
  port: number;
  system_prompt: string;
  sensors?: Record<string, boolean>;
  kind: InstanceKind;
  /** "relay" = mounted through the serving relay's /v1/remote/<id> proxy —
   *  the remote secret lives server-side, never in the client.
   *  "channel" = hub-paired device row (dev-<device_id>) proxied over the
   *  live hub channel — removal revokes the device, not a remotes row. */
  via?: "relay" | "channel";
  /** Paired device id on via="channel" rows (remote id is `dev-<id>`). */
  device_id?: string;
  endpoint?: InstanceEndpoint;
  tailscale?: InstanceTailscale;
  created_at: string;
  updated_at: string;
  session?: string;
  user_id?: string;
  persona?: string;
  secret?: string;
  has_secret?: boolean;
}

export interface ProcessStatus {
  is_running: boolean;
  pid?: number;
  port: number;
  state: "running" | "stopped" | "port_busy" | "not_owned" | "starting" | "lost" | "not_found";
  detail?: string;
}

/** desktop_bootstrap: managed local relay + its bearer secret (memory only). */
export interface DesktopBootstrap {
  instance: KlankerInstance;
  base_url: string;
  secret: string;
  status: ProcessStatus;
}

export interface ChatMessage {
  id: string;
  role: "user" | "klanker" | "system" | "tool";
  content: string;
  timestamp: string;
  elapsed_ms?: number;
  /** Names of files sent with this message (echo only — blobs are not kept). */
  attachments?: string[];
}

export interface TurnResponse {
  reply: string;
  session: string;
  user_id: string;
  elapsed_ms: number;
}

export interface TracePage {
  lines: string[];
  note: string;
}

export interface DiscoveredPeer {
  hostname: string;
  ip: string;
  fqdn?: string;
  endpoint: string;
  /** From GET /health — hub-connect suggestion inputs (host_id + url). */
  host_id?: string;
  version?: string;
}

export interface PendingApproval {
  id: string;
  tool: string;
  summary: string;
}

export interface WorkspaceRow {
  id: string;
  label?: string;
  workdir?: string;
  workdir_lock?: boolean;
  browser_profile?: string;
  approval_mode?: "off" | "ask" | "strict" | string;
}

/** Relay session/trace event (`GET .../sessions/<id>` → events[]).
 *  `metadata` fields vary by `type` — readers narrow what they need. */
export interface SessionEvent {
  type?: string;
  ts?: string;
  metadata?: { role?: string; content?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface JobRow {
  id: string;
  goal?: string;
  status?: string;
  result?: string;
  created_at?: string;
}

export interface RoutineRow {
  name: string;
  workspace?: string;
  prompt?: string;
  at?: string;
  cron?: string;
  paused?: boolean;
}

export interface RoutineActionResult {
  result?: { status?: string; reply?: string };
  [key: string]: unknown;
}

export interface RelayEvent {
  id: number;
  kind: string;
  workspace: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface PairCreateResult {
  mode: "web" | "remote";
  code: string;
  token: string;
  pair_url: string;
  expires_in: number;
  expires_at: number;
  host_id: string;
}

export interface StoreItem {
  id: string;
  kinds: string[];
  attrs: Record<string, unknown>;
  actor?: string | null;
  ts?: string | null;
}

export interface StoreListResult {
  supported: boolean;
  items: StoreItem[];
}

export interface StorePaneResult {
  entity: string;
  target: string;
  content: string;
  mime: string;
}

export interface RelayCapabilities {
  store: boolean;
  voice: boolean;
  caldav: boolean;
}

// --- hub links / paired devices / ws-share (agents-relay#43) -------------

/** GET /v1/hub/links row: a live paired-hub link on THIS relay (spoke side). */
export interface HubLink {
  hub_id: string;
  hub_url: string;
  device_id: string;
  label: string;
  connected_at: number;
  connected: boolean;
}

/** POST /v1/hub/connect result (200); failures throw with the relay error. */
export interface HubConnectResult {
  ok: boolean;
  hub_id?: string;
  device_id?: string;
  connected?: boolean;
  error?: string;
}

/** GET /v1/hub/devices row: a device paired with THIS relay (hub side). */
export interface HubDevice {
  id: string;
  label: string;
  host_id: string;
  role: string;
  created_at: number;
  last_seen: number;
  has_token: boolean;
  connected: boolean;
}

/** GET /v1/hub/leases row: active (ws, session) execution lease. */
export interface HubLease {
  ws: string;
  session: string;
  holder: string;
  run_id: string;
  fence: number;
  expires_in: number;
}

/** POST /v1/ws/invite result — single-use pair+grant code. */
export interface WsInvite {
  ok?: boolean;
  mode?: string;
  code: string;
  token: string;
  pair_url: string;
  expires_in: number;
  expires_at: number;
  host_id: string;
  ws?: string;
  granted_by?: string;
}

/** Ownership/share keys of PATCH /v1/workspaces/<id> (admin-only). */
export interface WorkspacePolicyPatch {
  sync_policy?: "local" | "synced" | "shared" | string;
  sync_hosts?: string[];
  default_host?: string | null;
  repos?: Record<string, unknown>;
  execution?: Record<string, unknown>;
}

/** GET /v1/workspaces/<ws>/hosts payload. */
export interface WorkspaceHosts {
  workspace: string;
  sync_policy: string;
  owner: string;
  default_host: string;
  hub_offline: boolean;
  hosts: WorkspaceHost[];
}

export interface WorkspaceHost {
  device_id: string;
  label: string;
  role: string;
  self: boolean;
  online: boolean;
  via: string;
  last_seen: number;
  status: string;
  leases: WorkspaceHostLease[];
}

export interface WorkspaceHostLease {
  session: string;
  run_id: string;
  fence: number;
  expires_in: number;
}

/** POST /v1/workspaces/<ws>/sessions/<sid>/host payload — returned parsed
 *  (never thrown) so 409 lease conflicts surface `holder` to the caller. */
export interface SessionHostSwitch {
  ok?: boolean;
  session?: string;
  host?: string;
  unchanged?: boolean;
  checkpoint?: Record<string, unknown>;
  holder?: string;
  error?: string;
  status?: number;
}
