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

export function isAcpProviderRow(row: Pick<ProviderRow, "name" | "kind">): boolean {
  return (row.kind || "").toLowerCase() === "acp-agent" || row.name.toLowerCase().startsWith("acp.");
}

function isTestProviderRow(row: ProviderRow): boolean {
  const kind = (row.kind || "").toLowerCase();
  const name = row.name.toLowerCase();
  return (
    kind === "echo" ||
    kind === "scripted" ||
    kind === "scripted.tool" ||
    kind === "acp" ||
    name === "echo" ||
    name === "scripted.tool" ||
    name.startsWith("scripted.")
  );
}

function isEchoProviderRow(row: ProviderRow): boolean {
  return (row.kind || "").toLowerCase() === "echo" || row.name.toLowerCase() === "echo";
}

/** Central visibility rule for picker and settings. Test fixtures are dev
 * scaffolding, never end-user choices: a stale showTestProviders flag must not
 * leak echo/scripted rows into the picker. `showTest` remains only as a legacy
 * signature for older callers and is intentionally ignored. */
export function filterVisibleProviders(rows: ProviderRow[], _showTest = false): ProviderRow[] {
  void _showTest;
  const hidden = new Set(readHiddenProviders());
  const visible = rows.filter((row) => !hidden.has(row.name));
  const realRows = visible.filter((row) => !isTestProviderRow(row));
  if (realRows.length > 0) return realRows;
  return visible.filter(isEchoProviderRow);
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

export type CodingAgentEntry = AcpAgentInfo & {
  providerName: string;
  configured: boolean;
  row?: ProviderRow;
  custom?: boolean;
};

/** One unified coding-agent list: curated detection rows plus every configured
 * acp.* manifest, including custom agents. This is the anti-duplication oracle
 * for the settings surface — configured ACP rows must never also render in the
 * model-provider list. */
export function mergeCodingAgentCatalog(
  rows: unknown,
  endpointAvailable: boolean,
  providers: ProviderRow[],
): CodingAgentEntry[] {
  const detected = new Map(normalizeAcpAgentRows(rows).map((row) => [(row.id || "").toLowerCase(), row]));
  const acpRows = providers.filter(isAcpProviderRow);
  const byProvider = new Map(acpRows.map((row) => [row.name.toLowerCase(), row]));
  const byAgentId = new Map(acpRows.map((row) => [(row.name.replace(/^acp\./i, "") || row.name).toLowerCase(), row]));
  const out: CodingAgentEntry[] = [];
  const seen = new Set<string>();

  for (const agent of mergeAcpAgentCatalog(rows, endpointAvailable)) {
    const canonicalName = `acp.${agent.id}`;
    const row = byProvider.get(canonicalName.toLowerCase()) || byAgentId.get(agent.id.toLowerCase());
    const providerName = row?.name || canonicalName;
    seen.add(canonicalName.toLowerCase());
    if (row) seen.add(row.name.toLowerCase());
    out.push({
      ...agent,
      label: row?.label?.trim() || agent.label,
      command: row?.command?.trim() || agent.command,
      error: row?.error || agent.error,
      providerName,
      configured: !!row,
      row,
    });
  }

  for (const row of acpRows) {
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = row.name.replace(/^acp\./i, "") || row.name;
    const live = detected.get(id.toLowerCase()) || {};
    out.push({
      id,
      label: row.label?.trim() || live.label || id,
      command: row.command?.trim() || live.command || "",
      hint: "custom ACP agent",
      installed: endpointAvailable ? !!live.installed : false,
      path: live.path,
      error: row.error || live.error,
      detectionUnavailable: !endpointAvailable,
      providerName: row.name,
      configured: true,
      row,
      custom: true,
    });
  }
  return out;
}

export function isAcpConfigured(rows: ProviderRow[], agentId: string): boolean {
  const name = `acp.${agentId}`;
  return rows.some((row) => row.name === name && isAcpProviderRow(row));
}
