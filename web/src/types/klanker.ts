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
   *  the remote secret lives server-side, never in the client. */
  via?: "relay";
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
