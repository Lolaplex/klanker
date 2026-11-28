import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronDown, EyeOff, Pencil, Play, Plus, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import type { KlankerInstance, ProviderRow } from "../types/klanker";
import { api } from "../services/api";
import { dialogs } from "../services/dialogs";
import { fetchSWR, invalidateSWR, mutateSWR, peekSWR, swrKey, useSWR } from "../services/swrCache";
import { providerCatalogKey, providerRowsKey } from "../services/sessionCache";
import {
  CURATED_PROVIDER_PRESETS,
  filterVisibleProviders,
  isAcpProviderRow,
  mergeCodingAgentCatalog,
  readHiddenProviders,
  type CodingAgentEntry,
  type ProviderPreset,
} from "../services/providerCatalog";
import { providerDisplayName } from "../providerDisplay";
import { inputClass } from "./ui/inputClass";

/** Compatibility export for the older settings tests; the canonical rule
 * lives in services/providerCatalog so picker and panel cannot drift. */
export function visibleProviderRows(rows: ProviderRow[], showTest: boolean): ProviderRow[] {
  return filterVisibleProviders(rows, showTest);
}

type ProbeInfo = { status: string; detail?: string; models?: string[]; modes?: string[] };
type ProviderListResult = { rows: ProviderRow[]; stale: boolean; hidden?: string[] };
type EditForm = {
  label: string;
  url: string;
  key_env: string;
  model: string;
  models: string;
  kind: "openai_compat" | "acp-agent";
  command: string;
};

const emptyCustomProviderForm = {
  name: "",
  url: "",
  key_env: "LLM_API_KEY",
  model: "",
};

const emptyCustomAcpForm = {
  name: "",
  label: "",
  command: "",
};

const emptyEditForm: EditForm = {
  label: "",
  url: "",
  key_env: "LLM_API_KEY",
  model: "",
  models: "",
  kind: "openai_compat",
  command: "",
};

function pillFor(status: string): { label: string; cls: string } {
  const s = status.toLowerCase();
  if (s === "ok" || s === "configured") return { label: s === "configured" ? "CONFIGURED" : s, cls: "border-success/50 text-success" };
  if (s === "auth" || s === "missing-key" || s === "missing-url") return { label: s === "missing-key" ? "missing key" : s, cls: "border-warn/50 text-warn" };
  if (s === "error") return { label: s, cls: "border-danger/50 text-danger" };
  return { label: status || "unknown", cls: "border-strong text-ink-muted" };
}

function probeText(info: ProbeInfo): string {
  return `${info.status}${info.detail ? ` — ${info.detail}` : ""}${info.models?.length ? ` · ${info.models.length} model(s)` : ""}`;
}

function parseModelsInput(raw: string): string[] {
  return [...new Set(raw.split(/[\n,]+/).map((m) => m.trim()).filter(Boolean))];
}

function modelCountLabel(count: number | undefined): string {
  if (!count) return "";
  return `${count} ${count === 1 ? "model" : "models"}`;
}

/** Host-scoped provider setup. Model providers and external ACP coding agents
 * are separate capability classes: a configured acp.* row renders exactly once,
 * in the coding-agent section, never as a duplicate model-provider card. */
export function ProvidersPanel({
  instance,
  onChanged,
}: {
  instance: KlankerInstance;
  onChanged?: () => void;
}) {
  const providersKey = providerRowsKey(instance.id);
  const catalogKey = providerCatalogKey(instance.id);
  const cachedProviders = peekSWR<ProviderListResult>(providersKey);
  const providersSwr = useSWR(providersKey, () => api.listProviders(instance), { ttlMs: 60_000, persist: "session", revalidateOnFocus: true });
  const agentsSwr = useSWR(catalogKey, () => api.listProviderAgents(instance), { ttlMs: 300_000, persist: "local" });
  const [rows, setRows] = useState<ProviderRow[]>(cachedProviders?.rows ?? []);
  const [stale, setStale] = useState(cachedProviders?.stale ?? false);
  const [hiddenProviders, setHiddenProviders] = useState<string[]>(() => cachedProviders?.hidden ?? readHiddenProviders());
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState<string | null>(null);
  const [probeOut, setProbeOut] = useState<Record<string, ProbeInfo>>({});
  const [keyTarget, setKeyTarget] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [keyNote, setKeyNote] = useState<Record<string, string>>({});
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [presetKey, setPresetKey] = useState("");
  const [presetUrl, setPresetUrl] = useState("");
  const [presetModel, setPresetModel] = useState("");
  const [agentRows, setAgentRows] = useState<unknown[] | null>(null);
  const [agentBusy, setAgentBusy] = useState("");
  const [customProviderOpen, setCustomProviderOpen] = useState(false);
  const [customAcpOpen, setCustomAcpOpen] = useState(false);
  const [editing, setEditing] = useState("");
  const [customProviderForm, setCustomProviderForm] = useState(emptyCustomProviderForm);
  const [customAcpForm, setCustomAcpForm] = useState(emptyCustomAcpForm);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);

  useEffect(() => {
    if (!providersSwr.data) return;
    setRows(providersSwr.data.rows);
    setStale(providersSwr.data.stale);
    setHiddenProviders(providersSwr.data.hidden ?? readHiddenProviders());
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
      onChanged?.();
    } finally {
      setProbeBusy(null);
    }
  };

  const drop = async (row: ProviderRow) => {
    if (!(await dialogs.confirm(`Delete provider ${row.name}?`, { danger: true }))) return;
    try {
      await mutateSWR<ProviderListResult>(
        providersKey,
        (current) => {
          const baseRows = current?.rows ?? rows;
          return { rows: baseRows.filter((p) => p.name !== row.name), stale: current?.stale ?? false, hidden: current?.hidden ?? readHiddenProviders() };
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

  const disableAgent = async (row: ProviderRow) => {
    setAgentBusy(row.name);
    setNote(null);
    try {
      await api.deleteProvider(instance, row.name);
      setProbeOut((prev) => {
        const next = { ...prev };
        delete next[row.name];
        return next;
      });
      if (editing === row.name) cancelEdit();
      invalidateProviders();
      load();
      onChanged?.();
    } catch (e) {
      setNote(`disable: ${e instanceof Error ? e.message : e}`);
    } finally {
      setAgentBusy("");
    }
  };

  const edit = (row: ProviderRow) => {
    setNote(null);
    if (editing === row.name) {
      setEditing("");
      return;
    }
    setEditing(row.name);
    setEditForm({
      label: row.label || "",
      kind: row.kind === "acp-agent" ? "acp-agent" : "openai_compat",
      command: row.command || "",
      url: row.url || "",
      key_env: row.key_env || "LLM_API_KEY",
      model: row.model || "",
      models: (row.models || []).join("\n"),
    });
  };

  const cancelEdit = () => {
    setEditing("");
    setEditForm(emptyEditForm);
  };

  const saveEdit = async (row: ProviderRow) => {
    setBusy(true);
    setNote(null);
    try {
      const label = editForm.label.trim();
      if (editForm.kind === "acp-agent") {
        await api.addProvider(instance, {
          name: row.name,
          kind: "acp-agent",
          label,
          command: editForm.command.trim(),
        });
      } else {
        const modelsRaw = editForm.models.trim();
        await api.addProvider(instance, {
          name: row.name,
          kind: "openai_compat",
          label,
          url: editForm.url.trim(),
          key_env: editForm.key_env.trim() || "LLM_API_KEY",
          model: editForm.model.trim(),
          ...(row.models !== undefined || modelsRaw ? { models: parseModelsInput(editForm.models) } : {}),
        });
      }
      cancelEdit();
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

  const submitCustomProvider = async () => {
    const name = customProviderForm.name.trim();
    if (!name) return;
    setBusy(true);
    setNote(null);
    try {
      await api.addProvider(instance, {
        name,
        url: customProviderForm.url.trim(),
        key_env: customProviderForm.key_env.trim() || "LLM_API_KEY",
        model: customProviderForm.model.trim(),
      });
      setCustomProviderOpen(false);
      setCustomProviderForm(emptyCustomProviderForm);
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

  const submitCustomAcp = async () => {
    const rawName = customAcpForm.name.trim();
    if (!rawName) return;
    const name = rawName.startsWith("acp.") ? rawName : `acp.${rawName}`;
    setBusy(true);
    setNote(null);
    try {
      await api.addProvider(instance, {
        name,
        kind: "acp-agent",
        label: customAcpForm.label.trim(),
        command: customAcpForm.command.trim(),
      });
      rememberProbe(name, await api.probeProvider(instance, name));
      setCustomAcpOpen(false);
      setCustomAcpForm(emptyCustomAcpForm);
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

  const hideProvider = async (row: ProviderRow) => {
    setNote(null);
    try {
      await api.setProviderHidden(instance, row.name, true);
      setHiddenProviders(readHiddenProviders());
      invalidateProviders();
      load();
      onChanged?.();
    } catch (e) {
      setNote(`hide: ${e instanceof Error ? e.message : e}`);
    }
  };

  const restoreHidden = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.restoreHiddenProviders(instance);
      setHiddenProviders([]);
      invalidateProviders();
      load();
      onChanged?.();
    } catch (e) {
      setNote(`restore: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
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

  const visibleRows = filterVisibleProviders(rows, false);
  const llmRows = visibleRows.filter((row) => !isAcpProviderRow(row));
  const agents = mergeCodingAgentCatalog(agentRows, agentRows !== null, visibleRows);
  const hiddenCount = hiddenProviders.length;

  const renderInlineEditor = (row: ProviderRow, displayName: string) => (
    <div className="mt-3 space-y-2 rounded-lg border border-subtle bg-main p-2.5" data-testid="inline-provider-edit">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-muted">edit {displayName}</span>
        <button type="button" onClick={cancelEdit} aria-label="Close provider editor" className="text-ink-muted hover:text-ink-primary"><X className="h-3.5 w-3.5" /></button>
      </div>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wider text-ink-dim">Display name</span>
        <input autoFocus value={editForm.label} onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))} placeholder={displayName} aria-label="Display name" spellCheck={false} className={inputClass} />
      </label>
      {editForm.kind === "acp-agent" ? (
        <label className="block space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-ink-dim">Spawn command</span>
          <input value={editForm.command} onChange={(e) => setEditForm((f) => ({ ...f, command: e.target.value }))} placeholder='spawn command, e.g. "devin acp"' aria-label="Spawn command" spellCheck={false} className={inputClass} />
        </label>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-ink-dim">Base URL</span>
            <input value={editForm.url} onChange={(e) => setEditForm((f) => ({ ...f, url: e.target.value }))} placeholder="base url" aria-label="Base URL" spellCheck={false} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-ink-dim">Default model</span>
              <input value={editForm.model} onChange={(e) => setEditForm((f) => ({ ...f, model: e.target.value }))} placeholder="default model" aria-label="Default model" spellCheck={false} className={inputClass} />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] uppercase tracking-wider text-ink-dim">Key env var</span>
              <input value={editForm.key_env} onChange={(e) => setEditForm((f) => ({ ...f, key_env: e.target.value }))} placeholder="key env var" aria-label="Key env var" spellCheck={false} className={inputClass} />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-ink-dim">Models</span>
            <textarea value={editForm.models} onChange={(e) => setEditForm((f) => ({ ...f, models: e.target.value }))} placeholder="model ids, comma or newline separated" aria-label="Models list" spellCheck={false} rows={3} className={`${inputClass} min-h-16 resize-y`} />
          </label>
        </>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={cancelEdit} className="rounded-md px-3 py-1.5 text-[10px] text-ink-muted hover:text-ink-primary">Cancel</button>
        <button type="button" onClick={() => void saveEdit(row)} disabled={busy || (editForm.kind === "acp-agent" ? !editForm.command.trim() : !editForm.url.trim())} className="rounded-md bg-accent px-3 py-1.5 text-[10px] text-accent-ink disabled:bg-hover disabled:text-ink-dim">{busy ? "saving…" : "Save"}</button>
      </div>
    </div>
  );

  const renderModelProvider = (row: ProviderRow) => {
    const probed = probeOut[row.name];
    const status = probed?.status || (row.error ? "error" : row.key_env && !row.key_configured ? "missing-key" : row.key_configured ? "configured" : "");
    const pill = status ? pillFor(status) : null;
    const displayName = providerDisplayName(row);
    const keyConfigured = row.key_configured === true;
    return (
      <article key={row.name} className="rounded-xl border border-strong bg-surface p-3" data-provider={row.name}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[12px] font-medium text-ink-primary">{displayName}</span>
              {row.kind ? <span className="rounded-md border border-strong px-1.5 py-0.5 text-[9px] uppercase text-ink-muted">{row.kind}</span> : null}
              {pill ? <span className={`rounded-md border px-1.5 py-0.5 text-[9px] uppercase ${pill.cls}`}>{pill.label}</span> : null}
              {row.models?.length ? <span className="text-[10px] text-ink-dim">{modelCountLabel(row.models.length)}</span> : null}
            </div>
            {displayName !== row.name ? <div className="mt-0.5 truncate text-[10px] font-mono text-ink-dim">{row.name}</div> : null}
            <div className="mt-1 truncate text-[10px] text-ink-dim" title={row.url || row.model || ""}>{row.url || row.model || "host provider"}</div>
            {probed ? <div className="mt-1 text-[10px] text-ink-secondary">{probeText(probed)}</div> : row.error ? <div className="mt-1 text-[10px] text-danger">{row.error}</div> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <button type="button" onClick={() => void probe(row.name)} disabled={probeBusy === row.name} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary disabled:opacity-40">{probeBusy === row.name ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}Probe</button>
            {row.key_env ? (
              <button
                type="button"
                onClick={() => { setKeyTarget(keyTarget === row.name ? "" : row.name); setKeyValue(""); }}
                className={keyConfigured
                  ? "h-8 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary"
                  : "h-8 rounded-md border border-warn/60 bg-accent px-2 text-[10px] text-accent-ink"}
              >
                {keyConfigured ? "Update key" : "Set API key"}
              </button>
            ) : null}
            <button type="button" onClick={() => edit(row)} aria-expanded={editing === row.name} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary"><Pencil className="h-3 w-3" />Edit</button>
            {row.source === "file" ? (
              <button type="button" onClick={() => void drop(row)} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-danger"><Trash2 className="h-3 w-3" />Delete</button>
            ) : (
              <button type="button" onClick={() => void hideProvider(row)} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary"><EyeOff className="h-3 w-3" />Hide</button>
            )}
          </div>
        </div>
        {row.key_env && keyTarget === row.name ? (
          <div className="mt-2 flex items-center gap-1">
            <input type="password" autoFocus value={keyValue} onChange={(e) => setKeyValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void setKey(row); if (e.key === "Escape") { setKeyTarget(""); setKeyValue(""); } }} placeholder={`${row.key_env} value`} aria-label={`API key for ${row.name}`} className={inputClass} />
            <button type="button" onClick={() => void setKey(row)} disabled={!keyValue.trim()} className="shrink-0 rounded-md bg-accent px-3 py-2 text-[10px] text-accent-ink disabled:opacity-40">save</button>
          </div>
        ) : null}
        {keyNote[row.name] ? <div className="mt-1 text-[10px] text-ink-muted">{keyNote[row.name]}</div> : null}
        {editing === row.name ? renderInlineEditor(row, displayName) : null}
      </article>
    );
  };

  const renderCodingAgent = (agent: CodingAgentEntry) => {
    const row = agent.row;
    const configured = agent.configured && !!row;
    const providerName = agent.providerName;
    const agentProbe = probeOut[providerName];
    const count = agentProbe?.models?.length ?? row?.models?.length;
    const countLabel = configured ? modelCountLabel(count) : "";
    const probeError = agentProbe && agentProbe.status !== "ok" ? probeText(agentProbe) : "";
    return (
      <article key={providerName} className="rounded-xl border border-strong bg-surface p-3" data-coding-agent={agent.id} {...(configured ? { "data-provider": providerName } : {})}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Bot className="h-3.5 w-3.5 text-ink-muted" />
              <span className="truncate text-[12px] text-ink-primary">{agent.label}</span>
              {agent.installed ? <span className="rounded-md border border-success/50 px-1.5 py-0.5 text-[9px] uppercase text-success" title={agent.path || "installed"}>INSTALLED</span> : <span className="rounded-md border border-strong px-1.5 py-0.5 text-[9px] uppercase text-ink-muted">NOT INSTALLED</span>}
              {configured ? <span className="rounded-md border border-success/50 px-1.5 py-0.5 text-[9px] uppercase text-success">ENABLED</span> : null}
              {countLabel ? <span className="rounded-md border border-subtle px-1.5 py-0.5 text-[9px] text-ink-muted">{countLabel}</span> : null}
              {agent.custom ? <span className="rounded-md border border-subtle px-1.5 py-0.5 text-[9px] uppercase text-ink-muted">custom</span> : null}
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-ink-dim" title={agent.command}>{agent.command || "no spawn command configured"}</div>
            <div className="mt-1 text-[10px] text-ink-dim">{agent.detectionUnavailable ? "Restart local relay to refresh CLI detection" : agent.hint}</div>
            {agent.error ? <div className="mt-1 text-[10px] text-danger">{agent.error}</div> : null}
            {agentProbe && agentProbe.status !== "ok" ? <div className="mt-1 text-[10px] text-danger">probe: {probeText(agentProbe)}</div> : null}
            {!agent.error && !probeError && agentProbe?.detail ? <div className="mt-1 text-[10px] text-ink-secondary">{agentProbe.detail}</div> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {configured && row ? (
              <>
                <button type="button" onClick={() => void probe(providerName)} disabled={probeBusy === providerName} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary disabled:opacity-40">{probeBusy === providerName ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}Probe</button>
                <button type="button" onClick={() => edit(row)} aria-expanded={editing === providerName} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-ink-primary"><Pencil className="h-3 w-3" />Edit</button>
                <button type="button" onClick={() => void disableAgent(row)} disabled={agentBusy === providerName} className="inline-flex h-8 items-center gap-1 rounded-md border border-strong px-2 text-[10px] text-ink-secondary hover:text-danger disabled:opacity-40"><Trash2 className="h-3 w-3" />{agentBusy === providerName ? "disabling…" : "Disable"}</button>
              </>
            ) : (
              <button type="button" onClick={() => void enableAgent(agent.id, agent.command)} disabled={agentBusy === agent.id || !agent.command.trim()} className="shrink-0 rounded-md bg-accent px-3 py-2 text-[10px] text-accent-ink disabled:bg-hover disabled:text-ink-dim">{agentBusy === agent.id ? "enabling…" : "Enable"}</button>
            )}
          </div>
        </div>
        {configured && row && editing === row.name ? renderInlineEditor(row, agent.label) : null}
      </article>
    );
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-muted">providers &amp; agents</div>
          <div className="mt-0.5 text-[10px] text-ink-dim">{stale ? "offline cache" : "host-scoped model access"}</div>
        </div>
      </div>
      {note ? <p className="rounded-md border border-danger/50 px-2.5 py-2 text-[11px] text-danger">{note}</p> : null}

      <section className="space-y-4" aria-label="Model Providers">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-muted">Model Providers</div>
            <div className="mt-0.5 text-[10px] text-ink-dim">Klanker harness models and OpenAI-compatible endpoints</div>
          </div>
          {hiddenCount > 0 ? (
            <button type="button" onClick={() => void restoreHidden()} disabled={busy} className="inline-flex h-7 items-center gap-1 rounded-md border border-subtle px-2 text-[10px] text-ink-secondary hover:border-strong hover:text-ink-primary disabled:opacity-40">
              <RotateCcw className="h-3 w-3" />Restore defaults ({hiddenCount})
            </button>
          ) : null}
        </div>
        {llmRows.length === 0 ? <div className="rounded-xl border border-subtle bg-surface px-3 py-4 text-center text-[11px] text-ink-dim">no model providers on this host</div> : llmRows.map(renderModelProvider)}

      <div className="space-y-2">
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
        <section className="rounded-xl border border-subtle bg-surface">
          <button type="button" onClick={() => setCustomProviderOpen((v) => !v)} className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[11px] text-ink-secondary hover:text-ink-primary">
            <span>+ Custom OpenAI-compatible provider…</span><ChevronDown className={`h-3.5 w-3.5 transition-transform ${customProviderOpen ? "rotate-180" : ""}`} />
          </button>
          {customProviderOpen ? (
            <div className="space-y-2 border-t border-subtle p-3">
              <input value={customProviderForm.name} onChange={(e) => setCustomProviderForm((f) => ({ ...f, name: e.target.value }))} placeholder="lmstudio.local" aria-label="Custom provider name" spellCheck={false} className={inputClass} />
              <input value={customProviderForm.url} onChange={(e) => setCustomProviderForm((f) => ({ ...f, url: e.target.value }))} placeholder="base url" aria-label="Custom provider base URL" spellCheck={false} className={inputClass} />
              <div className="grid grid-cols-2 gap-2">
                <input value={customProviderForm.key_env} onChange={(e) => setCustomProviderForm((f) => ({ ...f, key_env: e.target.value }))} placeholder="key env var" aria-label="Custom provider key env var" spellCheck={false} className={inputClass} />
                <input value={customProviderForm.model} onChange={(e) => setCustomProviderForm((f) => ({ ...f, model: e.target.value }))} placeholder="default model" aria-label="Custom provider default model" spellCheck={false} className={inputClass} />
              </div>
              <button type="button" onClick={() => void submitCustomProvider()} disabled={busy || !customProviderForm.name.trim() || !customProviderForm.url.trim()} className="w-full rounded-xl bg-accent px-4 py-2.5 text-[11px] text-accent-ink disabled:bg-hover disabled:text-ink-dim">{busy ? "saving…" : "Add custom provider"}</button>
            </div>
          ) : null}
        </section>
      </div>
      </section>

      <section className="space-y-2" aria-label="Coding Agents · ACP">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-muted">Coding Agents · ACP</div>
          <div className="mt-0.5 text-[10px] text-ink-dim">external coding agents; models stay agent-owned</div>
        </div>
        {agents.map(renderCodingAgent)}
        {agents.length === 0 ? <div className="text-[10px] text-ink-dim">no ACP agent catalog entries available</div> : null}
        <section className="rounded-xl border border-subtle bg-surface">
          <button type="button" onClick={() => setCustomAcpOpen((v) => !v)} className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[11px] text-ink-secondary hover:text-ink-primary">
            <span>+ Custom ACP agent…</span><ChevronDown className={`h-3.5 w-3.5 transition-transform ${customAcpOpen ? "rotate-180" : ""}`} />
          </button>
          {customAcpOpen ? (
            <div className="space-y-2 border-t border-subtle p-3">
              <input value={customAcpForm.name} onChange={(e) => setCustomAcpForm((f) => ({ ...f, name: e.target.value }))} placeholder="acp.myagent" aria-label="Custom ACP agent name" spellCheck={false} className={inputClass} />
              <input value={customAcpForm.label} onChange={(e) => setCustomAcpForm((f) => ({ ...f, label: e.target.value }))} placeholder="display name (optional)" aria-label="Custom ACP agent display name" spellCheck={false} className={inputClass} />
              <input value={customAcpForm.command} onChange={(e) => setCustomAcpForm((f) => ({ ...f, command: e.target.value }))} placeholder='spawn command, e.g. "my-agent acp"' aria-label="Custom ACP agent command" spellCheck={false} className={inputClass} />
              <button type="button" onClick={() => void submitCustomAcp()} disabled={busy || !customAcpForm.name.trim() || !customAcpForm.command.trim()} className="w-full rounded-xl bg-accent px-4 py-2.5 text-[11px] text-accent-ink disabled:bg-hover disabled:text-ink-dim">{busy ? "saving…" : "Add custom ACP agent"}</button>
            </div>
          ) : null}
        </section>
      </section>
    </div>
  );
}
