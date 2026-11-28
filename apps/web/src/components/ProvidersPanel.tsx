import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronDown, Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { KlankerInstance, ProviderRow } from "../types/klanker";
import { api } from "../services/api";
import { dialogs } from "../services/dialogs";
import { fetchSWR, invalidateSWR, mutateSWR, peekSWR, swrKey, useSWR } from "../services/swrCache";
import { providerCatalogKey, providerRowsKey } from "../services/sessionCache";
import {
  CURATED_PROVIDER_PRESETS,
  filterVisibleProviders,
  isAcpConfigured,
  mergeAcpAgentCatalog,
  readShowTestProviders,
  writeShowTestProviders,
  type ProviderPreset,
} from "../services/providerCatalog";
import { inputClass } from "./ui/inputClass";
import { Switch } from "./ui/Switch";

/** Compatibility export for the older settings tests; the canonical rule
 * lives in services/providerCatalog so picker and panel cannot drift. */
export function visibleProviderRows(rows: ProviderRow[], showTest: boolean): ProviderRow[] {
  return filterVisibleProviders(rows, showTest);
}

type ProbeInfo = { status: string; detail?: string; models?: string[]; modes?: string[] };

function pillFor(status: string): { label: string; cls: string } {
  const s = status.toLowerCase();
  if (s === "ok" || s === "configured") return { label: s, cls: "border-success/50 text-success" };
  if (s === "auth" || s === "missing-key" || s === "missing-url") return { label: s, cls: "border-warn/50 text-warn" };
  if (s === "error") return { label: s, cls: "border-danger/50 text-danger" };
  return { label: status || "unknown", cls: "border-strong text-ink-muted" };
}

function probeText(info: ProbeInfo): string {
  return `${info.status}${info.detail ? ` — ${info.detail}` : ""}${info.models?.length ? ` · ${info.models.length} model(s)` : ""}`;
}

/** Host-scoped provider setup. Curated one-click flows stay on the existing
 * provider wire contract; custom manifests remain available for power users. */
export function ProvidersPanel({
  instance,
  onChanged,
}: {
  instance: KlankerInstance;
  onChanged?: () => void;
}) {
  const providersKey = providerRowsKey(instance.id);
  const catalogKey = providerCatalogKey(instance.id);
  const cachedProviders = peekSWR<{ rows: ProviderRow[]; stale: boolean }>(providersKey);
  const providersSwr = useSWR(providersKey, () => api.listProviders(instance), { ttlMs: 60_000, persist: "session", revalidateOnFocus: true });
  const agentsSwr = useSWR(catalogKey, () => api.listProviderAgents(instance), { ttlMs: 300_000, persist: "local" });
  const [rows, setRows] = useState<ProviderRow[]>(cachedProviders?.rows ?? []);
  const [stale, setStale] = useState(cachedProviders?.stale ?? false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState<string | null>(null);
  const [probeOut, setProbeOut] = useState<Record<string, ProbeInfo>>({});
  const [showTestProviders, setShowTestProvidersState] = useState(readShowTestProviders);
  const [keyTarget, setKeyTarget] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [keyNote, setKeyNote] = useState<Record<string, string>>({});
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [presetKey, setPresetKey] = useState("");
  const [presetUrl, setPresetUrl] = useState("");
  const [presetModel, setPresetModel] = useState("");
  const [agentRows, setAgentRows] = useState<unknown[] | null>(null);
  const [agentBusy, setAgentBusy] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [editing, setEditing] = useState("");
  const [form, setForm] = useState({
    name: "",
    url: "",
    key_env: "LLM_API_KEY",
    model: "",
    kind: "openai_compat",
    command: "",
  });

  useEffect(() => {
    if (!providersSwr.data) return;
    setRows(providersSwr.data.rows);
    setStale(providersSwr.data.stale);
  }, [providersSwr.data]);

  useEffect(() => {
    if (agentsSwr.hasData) setAgentRows(agentsSwr.data ?? null);
  }, [agentsSwr.data, agentsSwr.hasData]);

  const invalidateProviders = useCallback(() => {
    invalidateSWR(providersKey);
    invalidateSWR(catalogKey);
  }, [catalogKey, providersKey]);

  const load = useCallback(() => {
    void providersSwr.refresh().catch(() => {});
    void agentsSwr.refresh().catch(() => {});
  }, [agentsSwr, providersSwr]);

  const setShowTestProviders = (value: boolean) => {
    setShowTestProvidersState(value);
    writeShowTestProviders(value);
    onChanged?.();
  };

  const rememberProbe = (name: string, out: Awaited<ReturnType<typeof api.probeProvider>>) => {
    setProbeOut((prev) => ({
      ...prev,
      [name]: out === null
        ? { status: "unknown", detail: "probe unsupported on this relay" }
        : { status: out.status || "unknown", detail: out.detail, models: out.models, modes: out.modes },
    }));
  };

  const probe = async (name: string) => {
    setProbeBusy(name);
    try {
      rememberProbe(name, await fetchSWR(swrKey(instance.id, "_root", `providers:probe:${name}`), () => api.probeProvider(instance, name), { ttlMs: 15_000, persist: false, force: true }));
      invalidateProviders();
      load();
    } finally {
      setProbeBusy(null);
    }
  };

  const drop = async (row: ProviderRow) => {
    if (!(await dialogs.confirm(`Delete provider ${row.name}?`, { danger: true }))) return;
    try {
      await mutateSWR<{ rows: ProviderRow[]; stale: boolean }>(
        providersKey,
        (current) => {
          const baseRows = current?.rows ?? rows;
          return { rows: baseRows.filter((p) => p.name !== row.name), stale: current?.stale ?? false };
        },
        async () => {
          await api.deleteProvider(instance, row.name);
        },
        () => setNote(`delete failed — restored ${row.name}`)
      );
      invalidateProviders();
      load();
      onChanged?.();
    } catch (e) {
      setNote(`delete: ${e instanceof Error ? e.message : e}`);
    }
  };

  const edit = (row: ProviderRow) => {
    setEditing(row.name);
    setCustomOpen(true);
    setNote(null);
    setForm({
      name: row.name,
      kind: row.kind === "acp-agent" ? "acp-agent" : "openai_compat",
      command: row.command || "",
      url: row.url || "",
      key_env: row.key_env || "LLM_API_KEY",
      model: row.model || "",
    });
  };

  const submitCustom = async () => {
    const name = form.name.trim();
    if (!name) return;
    setBusy(true);
    setNote(null);
    try {
      if (form.kind === "acp-agent") {
        await api.addProvider(instance, { name, kind: "acp-agent", command: form.command.trim() });
      } else {
        await api.addProvider(instance, {
          name,
          url: form.url.trim(),
          key_env: form.key_env.trim() || "LLM_API_KEY",
          model: form.model.trim(),
        });
      }
      setCustomOpen(false);
      setEditing("");
      setForm({ name: "", url: "", key_env: "LLM_API_KEY", model: "", kind: "openai_compat", command: "" });
      invalidateProviders();
      load();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNote(/^404|^501/.test(msg) ? "host relay predates the provider write API — update agents-relay on that host" : msg);
    } finally {
      setBusy(false);
    }
  };

  const setKey = async (row: ProviderRow) => {
    const value = keyValue.trim();
    const keyEnv = (row.key_env || "").trim();
    if (!value || !keyEnv) return;
    try {
      await api.setProviderSecret(instance, keyEnv, value);
      setKeyValue("");
      setKeyTarget("");
      setKeyNote((prev) => ({ ...prev, [row.name]: "key saved to host vault" }));
      load();
    } catch (e) {
      setKeyNote((prev) => ({ ...prev, [row.name]: `key: ${e instanceof Error ? e.message : e}` }));
    }
  };

  const openPreset = (next: ProviderPreset) => {
    setPreset(next);
    setPresetKey("");
    setPresetUrl(next.url);
    setPresetModel("");
    setNote(null);
  };

  const enablePreset = async () => {
    if (!preset) return;
    setBusy(true);
    setNote(null);
    try {
      await api.addProvider(instance, {
        name: preset.id,
        url: presetUrl.trim() || preset.url,
        key_env: preset.keyEnv,
        model: presetModel.trim() || undefined,
      });
      if (preset.keyEnv && presetKey.trim()) {
        await api.setProviderSecret(instance, preset.keyEnv, presetKey.trim());
      }
      rememberProbe(preset.id, await api.probeProvider(instance, preset.id));
      setPreset(null);
      setPresetKey("");
      invalidateProviders();
      load();
      onChanged?.();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enableAgent = async (id: string, command: string) => {
    const name = `acp.${id}`;
    setAgentBusy(id);
    setNote(null);
    try {
      await api.addProvider(instance, { name, kind: "acp-agent", command });
      rememberProbe(name, await api.probeProvider(instance, name));
      invalidateProviders();
      load();
      onChanged?.();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setAgentBusy("");
    }
  };

  const visibleRows = filterVisibleProviders(rows, showTestProviders);
  const agents = mergeAcpAgentCatalog(agentRows, agentRows !== null);
  const hasTestRows = rows.length !== visibleRows.length;

  return (
    <div className="flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-muted">providers &amp; agents</div>
          <div className="mt-0.5 text-[10px] text-ink-dim">{stale ? "offline cache" : "host-scoped model access"}</div>
        </div>
        {hasTestRows ? <label className="flex items-center gap-1.5 text-[10px] text-ink-muted"><Switch checked={showTestProviders} onCheckedChange={setShowTestProviders} ariaLabel="show test providers" />test fixtures</label> : null}
      </div>
      {note ? <p className="rounded-md border border-danger/50 px-2.5 py-2 text-[11px] text-danger">{note}</p> : null}

      <section className="space-y-2" aria-label="Configured providers and agents">
        <div className="text-[10px] uppercase tracking-wider text-ink-muted">configured providers &amp; agents</div>
        {visibleRows.length === 0 ? <div className="rounded-xl border border-subtle bg-surface px-3 py-4 text-center text-[11px] text-ink-dim">no visible providers on this host</div> : visibleRows.map((row) => {
          const probed = probeOut[row.name];
          const status = probed?.status || (row.error ? "error" : row.key_env && !row.key_configured ? "missing-key" : row.key_configured ? "configured" : "");
          const pill = status ? pillFor(status) : null;
          return (
            <article key={row.name} className="rounded-xl border border-strong bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-ink-primary">{row.name}</span>
                    {row.kind ? <span className="rounded-md border border-strong px-1.5 py-0.5 text-[9px] uppercase text-ink-muted">{row.kind}</span> : null}
                    {pill ? <span className={`rounded-md border px-1.5 py-0.5 text-[9px] uppercase ${pill.cls}`}>{pill.label}</span> : null}
                    {row.models?.length ? <span className="text-[10px] text-ink-dim">{row.models.length} model(s)</span> : null}
                  </div>
                  <div className="mt-1 truncate text-[10px] text-ink-dim" title={row.command || row.url || row.model || ""}>{row.command || row.url || row.model || "host provider"}</div>
                  {probed ? <div className="mt-1 text-[10px] text-ink-secondary">{probeText(probed)}</div> : row.error ? <div className="mt-1 text-[10px] text-danger">{row.error}</div> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                  <button type="button" onClick={() => void probe(row.name)} disabled={probeBusy === row.name} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary disabled:opacity-40">{probeBusy === row.name ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}Probe</button>
                  {row.key_env && row.source !== "env" ? <button type="button" onClick={() => { setKeyTarget(keyTarget === row.name ? "" : row.name); setKeyValue(""); }} className="h-8 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary">Set API key</button> : null}
                  <button type="button" onClick={() => edit(row)} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary"><Pencil className="h-3 w-3" />Edit</button>
                  <button type="button" onClick={() => void drop(row)} disabled={row.source !== "file"} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-danger disabled:opacity-30"><Trash2 className="h-3 w-3" />Delete</button>
                </div>
              </div>
              {row.key_env && row.source !== "env" && keyTarget === row.name ? (
                <div className="mt-2 flex items-center gap-1">
                  <input type="password" autoFocus value={keyValue} onChange={(e) => setKeyValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void setKey(row); if (e.key === "Escape") { setKeyTarget(""); setKeyValue(""); } }} placeholder={`${row.key_env} value`} aria-label={`Set API key for ${row.name}`} className={inputClass} />
                  <button type="button" onClick={() => void setKey(row)} disabled={!keyValue.trim()} className="shrink-0 rounded-md bg-accent px-3 py-2 text-[10px] text-accent-ink disabled:opacity-40">save</button>
                </div>
              ) : null}
              {keyNote[row.name] ? <div className="mt-1 text-[10px] text-ink-muted">{keyNote[row.name]}</div> : null}
            </article>
          );
        })}
      </section>

      <section className="space-y-2" aria-label="Add model provider">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-muted">add model provider</div>
          <div className="mt-0.5 text-[10px] text-ink-dim">one-click curated setup; no manifest plumbing</div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {CURATED_PROVIDER_PRESETS.map((item) => {
            const configured = rows.some((row) => row.name === item.id);
            return (
              <button key={item.id} type="button" onClick={() => openPreset(item)} className={`rounded-xl border p-3 text-left transition-colors ${preset?.id === item.id ? "border-accent bg-elevated" : "border-strong bg-surface hover:bg-hover"}`}>
                <div className="flex items-center justify-between gap-2"><span className="text-[12px] text-ink-primary">{item.label}</span>{configured ? <span className="rounded-md border border-success/50 px-1.5 py-0.5 text-[9px] uppercase text-success">configured</span> : <Plus className="h-3.5 w-3.5 text-ink-muted" />}</div>
                <div className="mt-1 text-[10px] text-ink-dim">{item.hint}</div>
              </button>
            );
          })}
        </div>
        {preset ? (
          <div className="space-y-2 rounded-xl border border-accent/60 bg-elevated p-3" data-testid="curated-provider-setup">
            <div className="flex items-center justify-between"><span className="text-[11px] text-ink-primary">Set up {preset.label}</span><button type="button" onClick={() => setPreset(null)} className="text-ink-muted hover:text-ink-primary" aria-label="Close provider setup"><X className="h-3.5 w-3.5" /></button></div>
            {preset.keyEnv ? (
              <input type="password" value={presetKey} onChange={(e) => setPresetKey(e.target.value)} placeholder={`${preset.keyEnv} API key`} aria-label={`${preset.label} API key`} className={inputClass} />
            ) : (
              <input value={presetUrl} onChange={(e) => setPresetUrl(e.target.value)} placeholder="server URL" aria-label={`${preset.label} URL`} className={inputClass} />
            )}
            <input value={presetModel} onChange={(e) => setPresetModel(e.target.value)} placeholder="default model (optional)" aria-label={`${preset.label} model`} className={inputClass} />
            <button type="button" onClick={() => void enablePreset()} disabled={busy || (!!preset.keyEnv && !presetKey.trim()) || (!preset.keyEnv && !presetUrl.trim())} className="w-full rounded-xl bg-accent px-4 py-2.5 text-[11px] text-accent-ink disabled:bg-hover disabled:text-ink-dim">{busy ? "setting up…" : `Add ${preset.label}`}</button>
          </div>
        ) : null}
      </section>

      <section className="space-y-2" aria-label="Coding agents">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-muted">coding agents · ACP</div>
          <div className="mt-0.5 text-[10px] text-ink-dim">auto-detected host CLIs, enabled as acp.* providers</div>
        </div>
        {agents.map((agent) => {
          const configured = isAcpConfigured(rows, agent.id);
          return (
            <div key={agent.id} className="rounded-xl border border-strong bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5 text-ink-muted" />
                    <span className="text-[12px] text-ink-primary">{agent.label}</span>
                    {agent.installed ? <span className="rounded-md border border-success/50 px-1.5 py-0.5 text-[9px] uppercase text-success" title={agent.path || "installed"}>installed</span> : <span className="rounded-md border border-strong px-1.5 py-0.5 text-[9px] uppercase text-ink-muted">{agent.detectionUnavailable ? "not detected" : "not installed"}</span>}
                    {configured ? <span className="rounded-md border border-success/50 px-1.5 py-0.5 text-[9px] uppercase text-success">enabled</span> : null}
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-dim" title={agent.command}>{agent.command}</div>
                  <div className="mt-1 text-[10px] text-ink-dim">{agent.detectionUnavailable ? "agent detection unavailable on this relay — curated command can still be enabled" : agent.hint}</div>
                  {agent.error ? <div className="mt-1 text-[10px] text-danger">{agent.error}</div> : null}
                </div>
                <button type="button" onClick={() => void enableAgent(agent.id, agent.command)} disabled={configured || agentBusy === agent.id} className="shrink-0 rounded-md bg-accent px-3 py-2 text-[10px] text-accent-ink disabled:bg-hover disabled:text-ink-dim">{agentBusy === agent.id ? "enabling…" : configured ? "enabled" : "Enable"}</button>
              </div>
            </div>
          );
        })}
        {agents.length === 0 ? <div className="text-[10px] text-ink-dim">no ACP agent catalog entries available</div> : null}
      </section>

      <section className="rounded-xl border border-subtle bg-surface">
        <button type="button" onClick={() => { setCustomOpen((v) => !v); if (customOpen) setEditing(""); }} className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[11px] text-ink-secondary hover:text-ink-primary">
          <span>Custom provider or ACP agent…</span><ChevronDown className={`h-3.5 w-3.5 transition-transform ${customOpen ? "rotate-180" : ""}`} />
        </button>
        {customOpen ? (
          <div className="space-y-2 border-t border-subtle p-3">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setForm((f) => ({ ...f, kind: "openai_compat" }))} className={`rounded-md border px-2 py-1.5 text-[11px] ${form.kind === "openai_compat" ? "border-accent bg-accent text-accent-ink" : "border-strong bg-surface text-ink-secondary"}`}>OpenAI-compatible</button>
              <button type="button" onClick={() => setForm((f) => ({ ...f, kind: "acp-agent" }))} className={`rounded-md border px-2 py-1.5 text-[11px] ${form.kind === "acp-agent" ? "border-accent bg-accent text-accent-ink" : "border-strong bg-surface text-ink-secondary"}`}>ACP agent</button>
            </div>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={form.kind === "acp-agent" ? "acp.devin" : "lmstudio.local"} spellCheck={false} className={inputClass} />
            {form.kind === "acp-agent" ? (
              <input value={form.command} onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))} placeholder='spawn command, e.g. "devin acp"' spellCheck={false} className={inputClass} />
            ) : (
              <>
                <input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="base url" spellCheck={false} className={inputClass} />
                <div className="grid grid-cols-2 gap-2">
                  <input value={form.key_env} onChange={(e) => setForm((f) => ({ ...f, key_env: e.target.value }))} placeholder="key env var" spellCheck={false} className={inputClass} />
                  <input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="default model" spellCheck={false} className={inputClass} />
                </div>
              </>
            )}
            <button type="button" onClick={() => void submitCustom()} disabled={busy || !form.name.trim() || (form.kind === "acp-agent" ? !form.command.trim() : !form.url.trim())} className="w-full rounded-xl bg-accent px-4 py-2.5 text-[11px] text-accent-ink disabled:bg-hover disabled:text-ink-dim">{busy ? "saving…" : editing ? "Save provider" : "Add custom provider"}</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
