import type { ProviderRow } from "../types/klanker";

export type ProviderPreset = {
  id: string;
  label: string;
  url: string;
  keyEnv?: string;
  local?: boolean;
  hint: string;
};

export type AcpAgentPreset = {
  id: string;
  label: string;
  command: string;
  hint: string;
};

export type AcpAgentInfo = AcpAgentPreset & {
  installed: boolean;
  path?: string;
  error?: string;
  detectionUnavailable?: boolean;
};

export const CURATED_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    hint: "one key, many hosted models",
  },
  {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    hint: "GPT and OpenAI-compatible responses",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    hint: "Gemini through the OpenAI-compatible endpoint",
  },
  {
    id: "lmstudio",
    label: "LM Studio (Local)",
    url: "http://127.0.0.1:1234/v1",
    local: true,
    hint: "local OpenAI-compatible server",
  },
  {
    id: "ollama",
    label: "Ollama (Local)",
    url: "http://127.0.0.1:11434/v1",
    local: true,
    hint: "local Ollama OpenAI-compatible endpoint",
  },
];

export const ACP_AGENT_PRESETS: AcpAgentPreset[] = [
  { id: "devin", label: "Devin CLI", command: "devin acp", hint: "uses the host's Devin CLI login" },
  {
    id: "claude",
    label: "Claude Code",
    command: "npx -y @agentclientprotocol/claude-agent-acp",
    hint: "Claude Code through the ACP adapter",
  },
  {
    id: "codex",
    label: "Codex CLI",
    command: "npx -y @agentclientprotocol/codex-acp",
    hint: "Codex through the ACP adapter",
  },
];

const LS_HIDDEN_PROVIDERS = "klanker.hiddenProviders";

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

/** Locally mirrored hidden-provider set. The relay endpoint is the source of
 * truth on newer hosts; this mirror keeps hides instant and is the whole
 * fallback on relays that predate /v1/providers/hidden. */
export function readHiddenProviders(): string[] {
  try {
    const raw = localStorage.getItem(LS_HIDDEN_PROVIDERS);
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    return Array.isArray(list) ? uniqueNames(list.filter((n): n is string => typeof n === "string")) : [];
  } catch {
    return [];
  }
}

export function writeHiddenProviders(names: string[]): void {
  try {
    localStorage.setItem(LS_HIDDEN_PROVIDERS, JSON.stringify(uniqueNames(names)));
  } catch {}
}

export function mergeHiddenProviders(serverHidden?: string[]): string[] {
  const merged = uniqueNames([...(serverHidden || []), ...readHiddenProviders()]);
  writeHiddenProviders(merged);
  return merged;
}

/** Central visibility rule for picker and settings: hidden built-ins stay
 * operator-controlled, and test fixtures/broken legacy ACP stubs are dev
 * scaffolding unless explicitly requested. */
export function filterVisibleProviders(rows: ProviderRow[], showTest: boolean): ProviderRow[] {
  const hidden = new Set(readHiddenProviders());
  return rows.filter((row) => {
    if (hidden.has(row.name)) return false;
    if (showTest) return true;
    const kind = (row.kind || "").toLowerCase();
    if (kind === "echo" || kind === "scripted" || kind === "scripted.tool") return false;
    if (kind === "acp") return false;
    return true;
  });
}

export function readShowTestProviders(): boolean {
  try {
    return localStorage.getItem("klanker.showTestProviders") === "1";
  } catch {
    return false;
  }
}

export function writeShowTestProviders(value: boolean): void {
  try {
    localStorage.setItem("klanker.showTestProviders", value ? "1" : "0");
  } catch {}
}

function scalar(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** Normalize the optional relay agent endpoint. Its exact shape is still
 * evolving, so accept id/name/command/path aliases and unknown rows. */
export function normalizeAcpAgentRows(raw: unknown): Partial<AcpAgentInfo>[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const id = scalar(rec.id) || scalar(rec.agent) || scalar(rec.name).replace(/^acp\./, "");
    if (!id) return [];
    return [{
      id,
      label: scalar(rec.label) || scalar(rec.title) || id,
      command: scalar(rec.command) || scalar(rec.cmd),
      installed: truthy(rec.installed) || truthy(rec.available) || !!scalar(rec.path),
      path: scalar(rec.path) || scalar(rec.resolved_path) || scalar(rec.executable),
      error: scalar(rec.error),
    }];
  });
}

/** Zed-style coding-agent catalog. When the relay has no detection endpoint,
 * curated agents remain one-click installable but are marked as undetected. */
export function mergeAcpAgentCatalog(rows: unknown, endpointAvailable: boolean): AcpAgentInfo[] {
  const detected = new Map(normalizeAcpAgentRows(rows).map((row) => [row.id || "", row]));
  return ACP_AGENT_PRESETS.map((preset) => {
    const live = detected.get(preset.id) || {};
    return {
      ...preset,
      command: live.command || preset.command,
      installed: endpointAvailable ? !!live.installed : false,
      path: live.path,
      error: live.error,
      detectionUnavailable: !endpointAvailable,
    };
  });
}

export function isAcpConfigured(rows: ProviderRow[], agentId: string): boolean {
  const name = `acp.${agentId}`;
  return rows.some((row) => row.name === name && row.kind === "acp-agent");
}
