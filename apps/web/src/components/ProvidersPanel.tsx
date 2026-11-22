import { useCallback, useEffect, useState } from "react";
import { Pencil, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { KlankerInstance, ProviderRow } from "../types/klanker";
import { api } from "../services/api";
import { dialogs } from "../services/dialogs";

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-[#525252] rounded-xl px-3 py-3 md:py-2.5 text-white outline-none text-base md:text-sm";

/** Host-scoped provider setup — Zed-style rows over /v1/providers.
 *  Providers belong to the instance's host: keys live in the host vault,
 *  acp agents spawn by manifest command, env rows are read-only here. */
export function ProvidersPanel({
  instance,
  onChanged,
}: {
  instance: KlankerInstance;
  /** fired after add/delete so the chat picker refreshes its rows. */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [stale, setStale] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** Name being edited — env acp rows get overridden by a file manifest. */
  const [editing, setEditing] = useState("");
  const [probeBusy, setProbeBusy] = useState<string | null>(null);
  const [probeOut, setProbeOut] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    name: "",
    url: "",
    key_env: "LLM_API_KEY",
    model: "",
    kind: "openai_compat",
    command: "",
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api.listProviders(instance).then((r) => {
      setRows(r.rows);
      setStale(r.stale);
    });
  }, [instance]);

  useEffect(() => load(), [load]);

  const probe = async (name: string) => {
    setProbeBusy(name);
    try {
      const out = await api.probeProvider(instance, name);
      setProbeOut((prev) => ({
        ...prev,
        [name]: out === null ? "probe unsupported on this relay" : `${out.status || "?"}${out.detail ? ` — ${out.detail}` : ""}`,
      }));
      load();
    } finally {
      setProbeBusy(null);
    }
  };

  const drop = async (row: ProviderRow) => {
    if (!(await dialogs.confirm(`Delete provider ${row.name}?`, { danger: true }))) return;
    try {
      await api.deleteProvider(instance, row.name);
      load();
      onChanged?.();
    } catch (e) {
      setNote(`delete: ${e instanceof Error ? e.message : e}`);
    }
  };

  const submit = async () => {
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
      setAdding(false);
      setEditing("");
      setForm({ name: "", url: "", key_env: "LLM_API_KEY", model: "", kind: "openai_compat", command: "" });
      load();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNote(
        /^404|^501/.test(msg)
          ? "host relay predates the provider write API — update agents-relay on that host"
          : msg
      );
    } finally {
      setBusy(false);
    }
  };

  const edit = (row: ProviderRow) => {
    setEditing(row.name);
    setAdding(true);
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

  const statusOf = (row: ProviderRow): { text: string; cls: string } => {
    const probed = probeOut[row.name];
    if (probed) return { text: probed, cls: "text-[#a3a3a3]" };
    if (row.error) return { text: row.error, cls: "text-[#a3a3a3]" };
    if (row.source === "env") return { text: "managed by host env", cls: "text-[#525252]" };
    return { text: "", cls: "" };
  };

  return (
    <div className="flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[#737373] uppercase tracking-wider">
          providers &amp; agents{stale ? " — offline cache" : ""}
        </span>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            if (adding) setEditing("");
            setNote(null);
          }}
          className="inline-flex h-9 w-9 items-center justify-center text-[#737373] hover:text-white"
          title="add provider"
        >
          {adding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        </button>
      </div>

      {adding && (
        <div className="border border-[#262626] rounded-xl p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, kind: "openai_compat" }))}
              className={`px-2 py-1.5 min-h-9 rounded border text-[11px] ${
                form.kind === "openai_compat"
                  ? "bg-white text-black border-white"
                  : "bg-[#0a0a0a] text-[#a3a3a3] border-[#262626] hover:text-white"
              }`}
            >
              OpenAI-compatible
            </button>
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, kind: "acp-agent" }))}
              className={`px-2 py-1.5 min-h-9 rounded border text-[11px] ${
                form.kind === "acp-agent"
                  ? "bg-white text-black border-white"
                  : "bg-[#0a0a0a] text-[#a3a3a3] border-[#262626] hover:text-white"
              }`}
            >
              ACP agent
            </button>
          </div>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={form.kind === "acp-agent" ? "acp.devin" : "lmstudio.local"}
            spellCheck={false}
            className={inputClass}
          />
          {form.kind === "acp-agent" ? (
            <>
              <input
                value={form.command}
                onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                placeholder='spawn command, e.g. "devin acp" or "ssh box devin acp"'
                spellCheck={false}
                className={inputClass}
              />
              <p className="text-[10px] text-[#525252] leading-relaxed">
                Command runs on this host per turn — the agent speaks ACP over
                stdio. Auth stays with the agent: it uses its own stored creds
                (e.g. run <code className="text-[#737373]">devin auth login</code> on
                the host once), or set <code className="text-[#737373]">AGENTS_ACP_API_KEY</code> in
                the host env. Probe the row after adding to list its models.
              </p>
            </>
          ) : (
            <>
              <input
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="base url, e.g. http://127.0.0.1:1234/v1"
                spellCheck={false}
                className={inputClass}
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={form.key_env}
                  onChange={(e) => setForm((f) => ({ ...f, key_env: e.target.value }))}
                  placeholder="key env var"
                  spellCheck={false}
                  className={inputClass}
                />
                <input
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder="default model (opt.)"
                  spellCheck={false}
                  className={inputClass}
                />
              </div>
            </>
          )}
          {form.kind !== "acp-agent" && (
            <p className="text-[10px] text-[#525252]">
              Keys live in the host secret vault under the env name above — set
              it via <code className="text-[#737373]">agents-workspace secrets set LLM_API_KEY</code>,
              never in this app.
            </p>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !form.name.trim() || (form.kind === "acp-agent" && !form.command.trim()) || (form.kind !== "acp-agent" && !form.url.trim())}
            className="w-full px-4 py-3 md:py-2.5 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded-xl text-[11px] transition-colors"
          >
            {busy ? "saving…" : editing ? "Save provider" : "Add provider"}
          </button>
        </div>
      )}

      {note && <p className="text-[11px] text-[#a3a3a3]">{note}</p>}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center py-6 text-[#525252]">
          <div className="w-9 h-9 border border-[#262626] rounded-full flex items-center justify-center mb-2 text-[11px]">∅</div>
          <p className="text-[11px]">no providers on this host</p>
        </div>
      ) : (
        rows.map((row) => {
          const st = statusOf(row);
          const deletable = row.source === "file";
          // env acp rows are editable: POST writes a file manifest whose
          // command wins over AGENTS_ACP_CMD* (delete restores the env row).
          const editable = deletable || (row.source === "env" && row.kind === "acp-agent");
          return (
            <div key={row.name} className="border border-[#262626] bg-[#101010] rounded-xl p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-[11px] truncate">{row.name}</span>
                    {row.kind && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded border border-[#262626] text-[10px] text-[#737373]">
                        {row.kind}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10px] text-[#525252] truncate">
                    {row.command || row.model || ""}
                    {row.models && row.models.length > 0 && ` · ${row.models.length} model(s)`}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    title={deletable ? "edit" : editable ? "override env row with a file manifest" : "managed by host env — edit on the host"}
                    onClick={() => edit(row)}
                    disabled={!editable}
                    className="inline-flex h-9 w-9 items-center justify-center text-[#737373] hover:text-white disabled:opacity-30 disabled:hover:text-[#737373]"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="probe"
                    onClick={() => void probe(row.name)}
                    disabled={probeBusy === row.name}
                    className="inline-flex h-9 w-9 items-center justify-center text-[#737373] hover:text-white disabled:opacity-40"
                  >
                    {probeBusy === row.name ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    title={deletable ? "delete" : "managed by host env — delete on the host"}
                    onClick={() => void drop(row)}
                    disabled={!deletable}
                    className="inline-flex h-9 w-9 items-center justify-center text-[#737373] hover:text-white disabled:opacity-30 disabled:hover:text-[#737373]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {st.text && <div className={`mt-1.5 text-[10px] ${st.cls}`}>{st.text}</div>}
            </div>
          );
        })
      )}
    </div>
  );
}
