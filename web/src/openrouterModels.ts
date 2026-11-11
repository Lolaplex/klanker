import { DesktopSettings, KlankerInstance, ProviderModelLists } from "./types/klanker";

export const LM_URL = "http://127.0.0.1:1234/v1";
export const OR_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_WORKSPACE = "C:\\Users\\felix\\Coding";

export const DEFAULT_SETTINGS: DesktopSettings = {
  provider: "echo",
  openrouter_api_key: "",
  openrouter_key_set: false,
  model: "",
  workspace: DEFAULT_WORKSPACE,
  lmstudio_base_url: LM_URL,
  recent_models: { openrouter: [], lmstudio: [] },
  favorites: { openrouter: [], lmstudio: [] },
};

export interface OpenRouterModel {
  id?: string;
  name?: string;
}

export type ProviderChoice = "inherit" | "echo" | "lmstudio" | "openrouter";
export type ProviderKind = "echo" | "lmstudio" | "openrouter";
export type ModelProvider = "lmstudio" | "openrouter";

const RANK_FIELDS: { canon: string; higher: boolean }[] = [
  { canon: "weeklyusage", higher: true },
  { canon: "popularity", higher: true },
  { canon: "rank", higher: false },
];

export function isLoopback(raw: string | undefined): boolean {
  const text = (raw || "").trim();
  const rest = text.startsWith("http://")
    ? text.slice("http://".length)
    : text.startsWith("https://")
      ? text.slice("https://".length)
      : "";
  if (!rest) return false;
  const authority = rest.split(/[/?#]/)[0] || "";
  const host = authority.startsWith("[")
    ? authority.slice(1).split("]")[0] || ""
    : authority.split(":")[0] || "";
  const name = host.toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

export function isOpenRouterUrl(raw: string | undefined): boolean {
  const text = (raw || "").trim().toLowerCase();
  return text.startsWith("https://openrouter.ai") || text.startsWith("http://openrouter.ai");
}

export function choiceOf(inst: KlankerInstance): ProviderChoice {
  const provider = inst.provider.trim().toLowerCase();
  if (provider === "echo") return "echo";
  if (provider === "inherit") return "inherit";
  if (provider === "openrouter" || isOpenRouterUrl(inst.base_url)) return "openrouter";
  if (provider === "lmstudio" || provider === "lmstudio.local") return "lmstudio";
  if ((provider === "openai.default" || provider === "") && isLoopback(inst.base_url)) return "lmstudio";
  if (isLoopback(inst.base_url)) return "lmstudio";
  return "inherit";
}

export function windowKind(settings: DesktopSettings): ProviderKind {
  if (settings.provider === "lmstudio" || settings.provider === "openrouter") return settings.provider;
  return "echo";
}

export function providerLabel(kind: ProviderKind): string {
  if (kind === "openrouter") return "OpenRouter";
  if (kind === "lmstudio") return "LM Studio";
  return "Echo";
}

export function withChoice(
  inst: KlankerInstance,
  choice: ProviderChoice,
  settings: DesktopSettings,
  model: string
): KlankerInstance {
  if (choice === "inherit" || choice === "echo") {
    return { ...inst, provider: choice, model: "", base_url: undefined, api_key: undefined };
  }
  if (choice === "openrouter") {
    return {
      ...inst,
      provider: "openrouter",
      model: model.trim(),
      base_url: OR_URL,
      api_key: undefined,
    };
  }
  const base = (inst.base_url || "").trim();
  return {
    ...inst,
    provider: "lmstudio",
    model: model.trim(),
    base_url: base && !isOpenRouterUrl(base) ? base : settings.lmstudio_base_url.trim() || LM_URL,
    api_key: undefined,
  };
}

export function sameChoice(inst: KlankerInstance, choice: ProviderChoice, model: string): boolean {
  if (choiceOf(inst) !== choice) return false;
  if (choice === "echo" || choice === "inherit") return true;
  return inst.model.trim() === model.trim();
}

function takeIds(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (limit > 0 && out.length >= limit) break;
  }
  return out;
}

export function normalizeLists(raw: unknown, limit: number): ProviderModelLists {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { openrouter: [], lmstudio: [] };
  }
  const obj = raw as { openrouter?: unknown; lmstudio?: unknown };
  return {
    openrouter: takeIds(obj.openrouter, limit),
    lmstudio: takeIds(obj.lmstudio, limit),
  };
}

export function toggleFavorite(
  settings: DesktopSettings,
  provider: ModelProvider,
  model: string
): DesktopSettings {
  const id = model.trim();
  if (!id) return settings;
  const prev = settings.favorites[provider] ?? [];
  const has = prev.includes(id);
  return {
    ...settings,
    favorites: {
      ...settings.favorites,
      [provider]: has ? prev.filter((item) => item !== id) : [id, ...prev],
    },
  };
}

export function rememberModel(
  settings: DesktopSettings,
  provider: ModelProvider,
  model: string
): DesktopSettings {
  const id = model.trim();
  if (!id) return settings;
  const prev = settings.recent_models[provider] ?? [];
  const recent = [id, ...prev.filter((item) => item !== id)].slice(0, 8);
  if (recent.length === prev.length && recent.every((item, index) => item === prev[index])) return settings;
  return {
    ...settings,
    recent_models: { ...settings.recent_models, [provider]: recent },
  };
}

function canonKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usableId(id: string): boolean {
  return id !== "" && !id.startsWith("~") && !id.includes(":batch");
}

export function topRankedIds(rows: OpenRouterModel[]): { ids: string[]; field: string | null } {
  const live = rows.filter((row) => usableId((row.id || "").trim()));
  let found: { key: string; higher: boolean } | null = null;
  for (const want of RANK_FIELDS) {
    for (const row of live) {
      const record = row as OpenRouterModel & Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (canonKey(key) !== want.canon || asNumber(record[key]) === null) continue;
        found = { key, higher: want.higher };
        break;
      }
      if (found) break;
    }
    if (found) break;
  }
  if (!found) return { ids: [], field: null };
  const rank = found;
  const scored: { id: string; value: number }[] = [];
  for (const row of live) {
    const record = row as OpenRouterModel & Record<string, unknown>;
    const value = asNumber(record[rank.key]);
    const id = (row.id || "").trim();
    if (value === null || !usableId(id) || scored.some((item) => item.id === id)) continue;
    scored.push({ id, value });
  }
  scored.sort((a, b) => (rank.higher ? b.value - a.value : a.value - b.value));
  return { ids: scored.slice(0, 10).map((item) => item.id), field: rank.key };
}

export function rowsFromModelsPayload(body: unknown): OpenRouterModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is OpenRouterModel => !!row && typeof row === "object");
}

export async function fetchOpenRouterModels(): Promise<{
  ids: string[];
  field: string | null;
  error: string | null;
}> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) {
      return { ids: [], field: null, error: "OpenRouter model list unavailable." };
    }
    const ranked = topRankedIds(rowsFromModelsPayload(await res.json()));
    return { ids: ranked.ids, field: ranked.field, error: null };
  } catch {
    return { ids: [], field: null, error: "OpenRouter model list unavailable." };
  }
}
