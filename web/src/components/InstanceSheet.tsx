import React, { useEffect, useRef, useState } from "react";
import { Trash2, FolderOpen, LogIn, LogOut, X } from "lucide-react";
import { DesktopSettings, KlankerInstance, ProcessStatus } from "../types/klanker";
import {
  choiceOf,
  ProviderChoice,
  providerLabel,
  ModelProvider,
  sameChoice,
  windowKind,
  withChoice,
} from "../openrouterModels";
import { ModelControl } from "./ModelControl";
import { SecretField } from "./SecretField";
import { TracesPanel } from "./TracesPanel";
import { api } from "../services/api";
import { dialogs } from "../services/dialogs";

interface InstanceSheetProps {
  instance: KlankerInstance;
  status: ProcessStatus | null;
  settings: DesktopSettings;
  rankedIds: string[];
  modelNote: string | null;
  loadingModels: boolean;
  onNeedModels: () => void;
  onSave: (updated: KlankerInstance) => void | Promise<void>;
  onStar: (provider: ModelProvider, id: string) => void;
  onDelete: (id: string) => void;
  /** Job id is its goal-session id — open it as a chat. */
  onOpenSession?: (ws: string, persona: string, session: string) => void;
  onClose: () => void;
}

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-[#525252] rounded-xl px-3 py-3 md:py-2.5 text-white outline-none text-base md:text-sm";

const choices: ProviderChoice[] = ["echo", "lmstudio", "openrouter", "inherit"];

export const InstanceSheet: React.FC<InstanceSheetProps> = ({
  instance,
  status,
  settings,
  rankedIds,
  modelNote,
  loadingModels,
  onNeedModels,
  onSave,
  onStar,
  onDelete,
  onOpenSession,
  onClose,
}) => {
  const [formData, setFormData] = useState<KlankerInstance>(instance);
  const draftRef = useRef(instance);
  const [loginToken, setLoginToken] = useState("");
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"config" | "traces" | "jobs">("config");
  const [jobWs, setJobWs] = useState("");
  const [jobPersona, setJobPersona] = useState("");
  const [jobGoal, setJobGoal] = useState("");
  const [jobList, setJobList] = useState<any[]>([]);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobNote, setJobNote] = useState<string | null>(null);
  const [newPersona, setNewPersona] = useState("");
  const [providers, setProviders] = useState<{ name: string; kind?: string; model?: string; models?: string[] }[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; label?: string }[]>([]);
  const [personas, setPersonas] = useState<{ id: string; name?: string }[]>([]);
  const choice = choiceOf(formData);
  const kind = choice === "inherit" ? windowKind(settings) : choice;
  const showModel = choice === "lmstudio" || choice === "openrouter";
  // Real manifest pick (acp.devin, openai.default, …) — generic override.
  const providerRow = providers.find((p) => p.name === formData.provider);

  useEffect(() => {
    setFormData(instance);
    draftRef.current = instance;
    setLoginNote(null);
    setAuthed(null);
    void api.authStatus(instance).then((s) => setAuthed(s.authenticated)).catch(() => setAuthed(null));
    void api.listProviders(instance).then(setProviders).catch(() => undefined);
    void api.listWorkspaces(instance).then(setWorkspaces).catch(() => undefined);
  }, [instance.id, instance.updated_at]);

  // Workspace ids come from the relay; instance.workspace is the workdir
  // boundary (a filesystem path), never a ws id.
  const firstWs = workspaces[0]?.id || "";
  const jobWsEff = jobWs || firstWs;
  const jobPersonaEff = jobPersona || (formData.persona || "").trim() || personas[0]?.id || "";

  useEffect(() => {
    const ws = tab === "jobs" ? jobWsEff : firstWs;
    if (!ws) {
      setPersonas([]);
      return;
    }
    void api.listPersonas(instance, ws).then(setPersonas).catch(() => setPersonas([]));
  }, [instance.id, firstWs, tab, jobWsEff]);

  useEffect(() => {
    if (choice === "openrouter") onNeedModels();
  }, [choice, onNeedModels]);

  useEffect(() => {
    if (tab !== "jobs" || !jobWsEff) return;
    let alive = true;
    const load = () =>
      api
        .listJobs(instance, jobWsEff, jobPersonaEff)
        .then((rows) => alive && setJobList(rows))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tab, instance.id, jobWsEff, jobPersonaEff]);

  const submitJob = async () => {
    const goal = jobGoal.trim();
    if (!goal || !jobWsEff || !jobPersonaEff) return;
    setJobBusy(true);
    setJobNote(null);
    try {
      const job = await api.createJob(instance, {
        workspace: jobWsEff,
        persona: jobPersonaEff,
        goal,
        provider: choice === "inherit" ? undefined : formData.provider || undefined,
        model: formData.model || undefined,
      });
      setJobNote(`job ${job.id || ""} queued`);
      setJobGoal("");
      setJobList(await api.listJobs(instance, jobWsEff, jobPersonaEff));
    } catch (e) {
      setJobNote(e instanceof Error ? e.message : String(e));
    } finally {
      setJobBusy(false);
    }
  };

  const writeForm = (next: KlankerInstance) => {
    draftRef.current = next;
    setFormData(next);
  };

  const [saveNote, setSaveNote] = useState<string | null>(null);

  const save = (next?: KlankerInstance) => {
    const inst = next ?? draftRef.current;
    void Promise.resolve(
      onSave({
        ...inst,
        name: inst.name.trim(),
        secret: inst.secret?.trim() || undefined,
        endpoint: { base_url: (inst.endpoint?.base_url || "").trim().replace(/\/+$/, "") },
        workspace: inst.workspace.trim(),
        persona: (inst.persona || "").trim() || undefined,
        kind: inst.kind || instance.kind,
      })
    )
      .then(() => setSaveNote("saved"))
      .catch((e) => setSaveNote(`save: ${e instanceof Error ? e.message : e}`));
  };

  const pickProvider = (next: ProviderChoice) => {
    if (choice === next) return;
    const carry = choice === "lmstudio" || choice === "openrouter";
    const modelForNext =
      next === "echo" || next === "inherit" ? "" : carry ? formData.model : windowKind(settings) === next ? settings.model : "";
    const saved = withChoice(draftRef.current, next, settings, modelForNext);
    writeForm(saved);
    save(saved);
  };

  const commitModel = (id: string) => {
    if (choice !== "lmstudio" && choice !== "openrouter") return;
    const trimmed = id.trim();
    const saved = withChoice(draftRef.current, choice, settings, trimmed);
    writeForm(saved);
    if (sameChoice(instance, choice, trimmed)) return;
    save(saved);
  };

  const doLogin = async () => {
    const token = loginToken.trim();
    if (!token) return;
    setLoginBusy(true);
    setLoginNote(null);
    try {
      await api.login(instance, token);
      setAuthed(true);
      setLoginNote("logged in — cookie set for 30d");
      setLoginToken("");
    } catch (e) {
      setLoginNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
    }
  };

  const doLogout = async () => {
    setLoginBusy(true);
    try {
      await api.logout(instance);
      setAuthed(false);
      setLoginNote("logged out");
    } catch (e) {
      setLoginNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
    }
  };

  const windowModel = kind !== "echo" ? settings.model.trim() : "";
  // Managed/spawned locals: endpoint is derived, bearer secret lives in the
  // keyring — the remote-only fields (URL, cookie login) stay hidden.
  const local = instance.kind === "local";
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;

  const pickWorkdir = async () => {
    const dir = await (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<string | null> } } })
      .__TAURI__.core.invoke("plugin:dialog|open", { options: { directory: true, title: "Choose workdir" } })
      .catch(() => null);
    if (dir) {
      const next = { ...draftRef.current, workspace: dir };
      writeForm(next);
      save(next);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-stretch md:justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-card relative w-full md:w-[420px] md:max-h-none bg-[#0a0a0a] rounded-t-2xl md:rounded-none border-t md:border-t-0 md:border-l border-[#262626] flex flex-col font-mono text-xs shadow-2xl">
        <div className="md:hidden shrink-0 pt-2 pb-1 flex justify-center">
          <span className="w-10 h-1 rounded-full bg-[#2e2e2e]" />
        </div>
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider truncate">
            {instance.name || "instance"}
          </span>
          <div className="flex items-center gap-2">
            {instance.id !== "local" && (
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    if (await dialogs.confirm(`Remove ${instance.name || instance.id}?`, { danger: true })) onDelete(instance.id);
                  })();
                }}
                className="inline-flex h-11 w-11 md:h-9 md:w-9 items-center justify-center text-[#737373] hover:text-white transition-colors"
                title="Remove this instance"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button type="button" onClick={onClose} className="inline-flex h-11 w-11 md:h-9 md:w-9 items-center justify-center text-[#737373] hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="shrink-0 px-4 py-2 border-b border-[#262626] flex items-center justify-between text-[11px]">
          <span className="text-[#737373]">
            {status?.state === "running" ? "up" : "down"}
            {!local && !desktop && authed !== null && <span className="ml-2">{authed ? "· authed" : "· not authed"}</span>}
          </span>
          <div className="flex bg-[#141414] border border-[#262626] rounded-full p-1 gap-0.5">
            {(["config", "traces", "jobs"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3.5 py-1.5 md:py-1 min-h-9 md:min-h-0 rounded-full transition-colors ${
                  tab === t
                    ? "bg-white text-black"
                    : "text-[#a3a3a3] hover:text-white"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {saveNote && (
          <div className="shrink-0 px-4 py-1 border-b border-[#262626] text-[10px] text-[#737373] truncate">
            {saveNote}
          </div>
        )}

        {tab === "traces" ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <TracesPanel instance={instance} />
          </div>
        ) : tab === "jobs" ? (
          <div className="flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Workspace</label>
                <select value={jobWsEff} onChange={(e) => setJobWs(e.target.value)} className={inputClass}>
                  {!jobWsEff && <option value="">(pick)</option>}
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.label || w.id}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Persona</label>
                <select value={jobPersonaEff} onChange={(e) => setJobPersona(e.target.value)} className={inputClass}>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>{p.name || p.id}</option>
                  ))}
                </select>
              </div>
            </div>
            {personas.length === 0 && jobWsEff && (
              <div className="flex gap-2">
                <input
                  value={newPersona}
                  onChange={(e) => setNewPersona(e.target.value)}
                  placeholder="new persona id"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => {
                    const id = newPersona.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
                    if (!id) return;
                    void api.createPersona(instance, jobWsEff, id).then(() => {
                      setNewPersona("");
                      setJobPersona(id);
                      return api.listPersonas(instance, jobWsEff).then(setPersonas);
                    }).catch((e) => setJobNote(e instanceof Error ? e.message : String(e)));
                  }}
                  className="px-4 py-3 md:py-2.5 bg-white text-black rounded-xl text-[11px] shrink-0"
                >
                  create
                </button>
              </div>
            )}
            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Goal</label>
              <textarea
                rows={3}
                value={jobGoal}
                onChange={(e) => setJobGoal(e.target.value)}
                placeholder="e.g. fix klanker#44: add delete buttons to the tree"
                className={`${inputClass} resize-none`}
              />
              <button
                type="button"
                onClick={() => void submitJob()}
                disabled={jobBusy || !jobGoal.trim() || !jobWsEff || !jobPersonaEff}
                className="mt-2 w-full sm:w-auto px-4 py-3 md:py-2.5 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded-xl text-[11px] transition-colors"
              >
                {jobBusy ? "queueing…" : "Run job"}
              </button>
              {jobNote && <p className="mt-1 text-[11px] text-[#737373]">{jobNote}</p>}
            </div>
            <div className="border-t border-[#262626] pt-3 space-y-2">
              {jobList.length === 0 ? (
                <div className="flex flex-col items-center py-6 text-[#525252]">
                  <div className="w-9 h-9 border border-[#262626] rounded-full flex items-center justify-center mb-2 text-[11px]">∅</div>
                  <p className="text-[11px]">no jobs in this workspace</p>
                </div>
              ) : (
                jobList.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => onOpenSession?.(jobWsEff, jobPersonaEff, j.id)}
                    title={onOpenSession ? "Open the job's chat" : undefined}
                    className={`w-full text-left border border-[#262626] bg-[#101010] rounded-xl p-3 ${
                      onOpenSession ? "hover:border-[#525252] cursor-pointer" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-white text-[11px] leading-snug break-words min-w-0">{j.goal || j.id}</span>
                      <span
                        className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] ${
                          j.status === "done"
                            ? "border-white text-white"
                            : j.status === "failed" || j.status === "stopped"
                            ? "border-[#525252] text-[#a3a3a3] line-through"
                            : "border-[#262626] text-[#a3a3a3] animate-pulse"
                        }`}
                      >
                        {j.status || "?"}
                      </span>
                    </div>
                    {j.result && <div className="mt-1.5 text-[11px] text-[#737373] line-clamp-3">{j.result}</div>}
                    <div className="mt-1.5 text-[10px] text-[#3f3f3f] truncate">{j.id}</div>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => writeForm({ ...draftRef.current, name: e.target.value })}
                  onBlur={() => save()}
                  className={inputClass}
                />
              </div>
              {!local && (
                <div>
                  <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Instance URL</label>
                  <input
                    type="text"
                    value={formData.endpoint?.base_url || ""}
                    onChange={(e) => writeForm({ ...draftRef.current, endpoint: { base_url: e.target.value } })}
                    onBlur={() => save()}
                    placeholder="https://klanker.example.com (empty = this origin)"
                    className={inputClass}
                  />
                </div>
              )}
            </div>

            <div onBlur={() => save()}>
              <SecretField
                label="Instance secret"
                stored={Boolean(instance.has_secret || instance.secret)}
                value={formData.secret || ""}
                onChange={(value) => writeForm({ ...draftRef.current, secret: value || undefined })}
                help="RELAY_SECRET — sent as Authorization: Bearer on every call. Needed unless cookie login or open relay."
              />
              {status?.detail === "unauthorized" && (
                <p className="mt-1.5 text-[10px] text-red-400">
                  relay rejected the stored secret — re-enter and it saves on blur
                </p>
              )}
            </div>

            {!local && !desktop && (
            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                Browser dashboard login (optional)
              </label>
              <p className="text-[10px] text-[#525252] mb-1.5">
                RELAY_WEB_TOKEN cookie — only for the web UI served by the relay itself. This app uses the instance secret above; you can skip this.
              </p>
              <div className="flex items-center gap-1">
                <input
                  type="password"
                  value={loginToken}
                  onChange={(e) => setLoginToken(e.target.value)}
                  placeholder="RELAY_WEB_TOKEN"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => void doLogin()}
                  disabled={loginBusy || !loginToken.trim()}
                  className="shrink-0 flex items-center gap-1 px-3 py-3 md:py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>login</span>
                </button>
                <button
                  type="button"
                  onClick={() => void doLogout()}
                  disabled={loginBusy || !authed}
                  className="shrink-0 flex items-center gap-1 px-3 py-3 md:py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
              {loginNote && <p className="mt-1 text-[11px] text-[#737373]">{loginNote}</p>}
            </div>
            )}

            {local && (
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                  Workdir
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={formData.workspace}
                    onChange={(e) => writeForm({ ...draftRef.current, workspace: e.target.value })}
                    onBlur={() => save()}
                    placeholder="tool confinement dir (empty = workspace work dir)"
                    className={inputClass}
                  />
                  {desktop && (
                    <button
                      type="button"
                      title="Browse…"
                      onClick={() => void pickWorkdir()}
                      className="shrink-0 p-2 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="text-[10px] text-[#737373] uppercase tracking-wider">Provider</div>
              {providers.length > 0 ? (
                <select
                  value={formData.provider}
                  onChange={(e) => {
                    const next = { ...draftRef.current, provider: e.target.value };
                    writeForm(next);
                    save(next);
                  }}
                  className={inputClass}
                >
                  <option value="">host default (env)</option>
                  {desktop && <option value="inherit">inherit app setting</option>}
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.model ? ` · ${p.model}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div>
                  <div className="grid grid-cols-4 gap-1">
                    {choices.map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => pickProvider(item)}
                        className={`px-2 py-1.5 min-h-9 rounded border text-[11px] transition-colors ${
                          choice === item
                            ? "bg-white text-black border-white"
                            : "bg-[#0a0a0a] text-[#a3a3a3] border-[#262626] hover:text-white"
                        }`}
                      >
                        {item === "inherit" ? "Inherit" : providerLabel(item)}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[10px] text-[#525252]">
                    host provider list unavailable — showing app fallback providers
                  </p>
                </div>
              )}
              {choice === "inherit" && providers.length === 0 && (
                <p className="text-[11px] text-[#737373] truncate">
                  Window: {providerLabel(kind)}
                  {windowModel ? ` · ${windowModel}` : ""}
                </p>
              )}
              {providerRow && (
                <div>
                  <div className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                    Model override
                  </div>
                  <input
                    type="text"
                    value={formData.model}
                    spellCheck={false}
                    placeholder={providerRow.model || "provider default"}
                    onChange={(e) => {
                      const next = { ...draftRef.current, model: e.target.value };
                      writeForm(next);
                    }}
                    onBlur={() => save()}
                    className={inputClass}
                  />
                  {(providerRow.models ?? []).length > 0 && (
                    <div className="mt-1 max-h-36 overflow-y-auto border border-[#262626] rounded">
                      {(providerRow.models ?? []).map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => {
                            const next = { ...draftRef.current, model: id };
                            writeForm(next);
                            save(next);
                          }}
                          className={`w-full min-h-9 truncate px-2 py-1.5 text-left ${
                            id === formData.model.trim()
                              ? "bg-[#141414] text-white"
                              : "text-[#a3a3a3] hover:bg-[#181818] hover:text-white"
                          }`}
                        >
                          {id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {showModel && (
                <ModelControl
                  provider={choice}
                  label="Model override"
                  model={formData.model}
                  recent={settings.recent_models[choice]}
                  favorites={settings.favorites[choice]}
                  ranked={choice === "openrouter" ? rankedIds : []}
                  loading={choice === "openrouter" && loadingModels}
                  note={choice === "openrouter" ? modelNote : null}
                  onDraft={(id) => writeForm({ ...draftRef.current, model: id })}
                  onCommit={commitModel}
                  onToggleStar={(id) => onStar(choice, id)}
                />
              )}
            </div>

            <button
              type="button"
              onClick={() => save()}
              className="w-full px-4 py-3 md:py-2.5 bg-white hover:bg-[#e5e5e5] text-black rounded-xl text-[11px] transition-colors"
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
