import type { ModelPick, ProviderRow } from "./types/klanker";
import { modelDisplayName, providerDisplayName } from "./providerDisplay";

export interface PickRow {
  provider: string;
  model: string;
  /** display label: bare model id, or the provider name for default rows. */
  label: string;
  /** provider name — grouping key for the optional grouped view. */
  group: string;
  /** provider-level error (e.g. acp agent without a command). */
  error?: string;
  /** this row selects the provider's own default model. */
  isDefault?: boolean;
  /** manifest default model behind a provider-default pick row. */
  displayModel?: string;
}

const samePick = (a: ModelPick, b: ModelPick): boolean =>
  a.provider === b.provider && a.model === b.model;

export function isAcpProvider(provider: Pick<ProviderRow, "name" | "kind">): boolean {
  return (provider.kind || "").toLowerCase() === "acp-agent" || provider.name.toLowerCase().startsWith("acp.");
}

/** Split Klanker's own LLM harness providers from external ACP coding agents. */
export function splitProviderRows(providers: ProviderRow[]): { llmProviders: ProviderRow[]; acpProviders: ProviderRow[] } {
  const llmProviders: ProviderRow[] = [];
  const acpProviders: ProviderRow[] = [];
  for (const provider of providers) {
    if (isAcpProvider(provider)) acpProviders.push(provider);
    else llmProviders.push(provider);
  }
  return { llmProviders, acpProviders };
}

/** Expand provider rows into one pick row per model.
 *  A provider without a `models` list still yields one row — its manifest
 *  default model (`model: ""` selects it on the wire). */
export function expandRows(providers: ProviderRow[]): PickRow[] {
  const out: PickRow[] = [];
  for (const p of providers) {
    const models = (p.models ?? []).filter((m) => m && m.trim());
    if (models.length === 0) {
      out.push({
        provider: p.name,
        model: "",
        label: p.model || providerDisplayName(p.name),
        group: p.name,
        error: p.error,
        isDefault: true,
        displayModel: p.model || "",
      });
      continue;
    }
    for (const model of models) {
      out.push({
        provider: p.name,
        model,
        label: model,
        group: p.name,
        error: p.error,
      });
    }
  }
  return out;
}

/** Flat pick list: favorites first (in stored order), then every
 *  provider/model row. Duplicate favorites are dropped from the tail so a
 *  starred row appears exactly once. `filter` matches provider:model
 *  case-insensitively and hides nothing from favorites. */
export function pickerRows(
  providers: ProviderRow[],
  favorites: ModelPick[],
  filter = ""
): { favorites: PickRow[]; rows: PickRow[] } {
  const q = filter.trim().toLowerCase();
  const match = (r: PickRow) => {
    if (!q) return true;
    const displayProvider = providerDisplayName(r.provider).toLowerCase();
    const displayModel = modelDisplayName(r.displayModel || r.model, r.provider).primary.toLowerCase();
    return (
      r.provider.toLowerCase().includes(q) ||
      r.model.toLowerCase().includes(q) ||
      `${r.provider}:${r.model}`.includes(q) ||
      r.label.toLowerCase().includes(q) ||
      displayProvider.includes(q) ||
      displayModel.includes(q)
    );
  };
  const favSet = new Set(favorites.map((f) => `${f.provider} ${f.model}`));
  const byPick = new Map<string, PickRow>();
  for (const r of expandRows(providers)) byPick.set(`${r.provider} ${r.model}`, r);
  const favoritesOut: PickRow[] = [];
  for (const f of favorites) {
    const row = byPick.get(`${f.provider} ${f.model}`) ?? {
      provider: f.provider,
      model: f.model,
      label: f.model || providerDisplayName(f.provider),
      group: f.provider,
    };
    if (match(row)) favoritesOut.push(row);
  }
  const rows = expandRows(providers).filter(
    (r) => !favSet.has(`${r.provider} ${r.model}`) && match(r)
  );
  return { favorites: favoritesOut, rows };
}

/** Group flat rows by provider for the optional two-level view. */
export function groupRows(rows: PickRow[]): { provider: string; error?: string; rows: PickRow[] }[] {
  const groups = new Map<string, { provider: string; error?: string; rows: PickRow[] }>();
  for (const r of rows) {
    let g = groups.get(r.group);
    if (!g) {
      g = { provider: r.group, error: r.error, rows: [] };
      groups.set(r.group, g);
    }
    g.rows.push(r);
  }
  return [...groups.values()];
}

/** Free-id input: "provider:model" is explicit; a bare model id binds to
 *  `fallbackProvider` when given, else the single provider in `providers`
 *  when unambiguous, else the raw text as provider (provider-default row).
 *  "provider:" alone = that provider's default model. */
export function parseFreeId(
  text: string,
  providers: ProviderRow[],
  fallbackProvider = ""
): ModelPick | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.includes(":")) {
    const [provider, ...rest] = raw.split(":");
    const p = provider.trim();
    if (!p) return null;
    return { provider: p, model: rest.join(":").trim() };
  }
  if (providers.some((p) => p.name === raw)) return { provider: raw, model: "" };
  if (fallbackProvider) return { provider: fallbackProvider, model: raw };
  const owners = providers.filter((p) => (p.models ?? []).includes(raw));
  if (owners.length === 1) return { provider: owners[0].name, model: raw };
  return { provider: "", model: raw };
}

export function picksEqual(a: ModelPick | null | undefined, b: ModelPick | null | undefined): boolean {
  return (a?.provider || "") === (b?.provider || "") && (a?.model || "") === (b?.model || "");
}

export function isStarred(row: PickRow, favorites: ModelPick[]): boolean {
  return favorites.some((f) => samePick(f, row));
}
