export type InstanceKind = "local" | "remote";

export interface InstanceEndpoint {
  base_url: string;
  secret?: string;
}

export interface InstanceStartSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface InstanceTailscale {
  node: string;
  fqdn?: string;
}

export interface ProviderModelLists {
  openrouter: string[];
  lmstudio: string[];
}

export interface DesktopSettings {
  provider: string;
  openrouter_api_key: string;
  openrouter_key_set: boolean;
  model: string;
  workspace: string;
  lmstudio_base_url: string;
  recent_models: ProviderModelLists;
  favorites: ProviderModelLists;
}

export interface KlankerInstance {
  id: string;
  name: string;
  slug: string;
  role: string;
  provider: string;
  model: string;
  base_url?: string;
  api_key?: string;
  workspace: string;
  lock_workspace: boolean;
  port: number;
  system_prompt: string;
  sensors?: Record<string, boolean>;
  kind: InstanceKind;
  endpoint?: InstanceEndpoint;
  start_cmd?: InstanceStartSpec;
  tailscale?: InstanceTailscale;
  created_at: string;
  updated_at: string;
  session?: string;
  user_id?: string;
  persona?: string;
  secret?: string;
  has_secret?: boolean;
  pid?: number;
}

export interface ProcessStatus {
  is_running: boolean;
  pid?: number;
  port: number;
  state: "running" | "stopped" | "port_busy" | "not_owned";
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "klanker" | "system" | "tool";
  content: string;
  timestamp: string;
  elapsed_ms?: number;
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
