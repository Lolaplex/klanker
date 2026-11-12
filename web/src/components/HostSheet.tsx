import React, { useEffect, useRef, useState } from "react";
import { Trash2, LogIn, LogOut, X } from "lucide-react";
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

interface HostSheetProps {
  instance: KlankerInstance;
  status: ProcessStatus | null;
  settings: DesktopSettings;
  rankedIds: string[];
  modelNote: string | null;
  loadingModels: boolean;
  onNeedModels: () => void;
  onSave: (updated: KlankerInstance) => void;
  onStar: (provider: ModelProvider, id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";

const choices: ProviderChoice[] = ["echo", "lmstudio", "openrouter", "inherit"];

export const HostSheet: React.FC<HostSheetProps> = ({
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
  const [providers, setProviders] = useState<{ name: string; model?: string }[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; label?: string }[]>([]);
  const [personas, setPersonas] = useState<{ id: string; name?: string }[]>([]);
  const choice = choiceOf(formData);
  const kind = choice === "inherit" ? windowKind(settings) : choice;
  const showModel = choice === "lmstudio" || choice === "openrouter";

  useEffect(() => {
    setFormData(instance);
    draftRef.current = instance;
    setLoginNote(null);
    setAuthed(null);
    void api.authStatus(instance).then((s) => setAuthed(s.authenticated)).catch(() => setAuthed(null));
    void api.listProviders(instance).then(setProviders).catch(() => undefined);
    void api.listWorkspaces(instance).then(setWorkspaces).catch(() => undefined);
  }, [instance.id, instance.updated_at]);

  useEffect(() => {
    const ws = formData.workspace.trim();
    if (!ws) {
      setPersonas([]);
      return;
    }
    void api.listPersonas(instance, ws).then(setPersonas).catch(() => setPersonas([]));
  }, [instance.id, formData.workspace]);

  useEffect(() => {
    if (choice === "openrouter") onNeedModels();
  }, [choice, onNeedModels]);

  const jobWsEff = jobWs || formData.workspace.trim();
  const jobPersonaEff = jobPersona || (formData.persona || "").trim() || personas[0]?.id || "";

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

  const save = (next?: KlankerInstance) => {
    const inst = next ?? draftRef.current;
    onSave({
      ...inst,
      name: inst.name.trim(),
      secret: inst.secret?.trim() || undefined,
      endpoint: { base_url: (inst.endpoint?.base_url || "").trim().replace(/\/+$/, "") },
      workspace: inst.workspace.trim(),
      persona: (inst.persona || "").trim() || undefined,
      kind: "remote",
    });
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

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-stretch md:justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full md:w-[420px] max-h-[85vh] md:max-h-none bg-[#0a0a0a] border-t md:border-t-0 md:border-l border-[#262626] flex flex-col font-mono text-xs shadow-2xl">
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider truncate">
            {instance.name || "host"}
          </span>
          <div className="flex items-center gap-2">
            {instance.id !== "local" && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Remove ${instance.name || instance.id}?`)) onDelete(instance.id);
                }}
                className="p-1.5 text-[#737373] hover:text-white transition-colors"
                title="Remove this host"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button type="button" onClick={onClose} className="p-1.5 text-[#737373] hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="shrink-0 px-4 py-2 border-b border-[#262626] flex items-center justify-between text-[11px]">
          <span className="text-[#737373]">
            {status?.state === "running" ? "up" : "down"}
            {authed !== null && <span className="ml-2">{authed ? "· authed" : "· not authed"}</span>}
          </span>
          <div className="flex gap-1">
            {(["config", "traces", "jobs"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-2 py-1 rounded border transition-colors ${
                  tab === t
                    ? "bg-white text-black border-white"
                    : "bg-[#0a0a0a] text-[#a3a3a3] border-[#262626] hover:text-white"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {tab === "traces" ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <TracesPanel instance={instance} />
          </div>
        ) : tab === "jobs" ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
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
                className="mt-2 px-3 py-1.5 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded text-[11px] transition-colors"
              >
                {jobBusy ? "queueing…" : "Run job"}
              </button>
              {jobNote && <p className="mt-1 text-[11px] text-[#737373]">{jobNote}</p>}
            </div>
            <div className="border-t border-[#262626] pt-2 space-y-2">
              {jobList.length === 0 ? (
                <p className="text-[11px] text-[#525252]">no jobs in this workspace</p>
              ) : (
                jobList.map((j) => (
                  <div key={j.id} className="border border-[#262626] rounded p-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-white truncate">{j.id}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded border ${
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
                    <div className="mt-1 text-[11px] text-[#737373] line-clamp-2">{j.goal}</div>
                    {j.result && <div className="mt-1 text-[11px] text-[#525252] line-clamp-3">{j.result}</div>}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-2">
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
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Host URL</label>
                <input
                  type="text"
                  value={formData.endpoint?.base_url || ""}
                  onChange={(e) => writeForm({ ...draftRef.current, endpoint: { base_url: e.target.value } })}
                  onBlur={() => save()}
                  placeholder="https://host.example.com (empty = this origin)"
                  className={inputClass}
                />
              </div>
            </div>

            <div onBlur={() => save()}>
              <SecretField
                label="Host secret"
                stored={Boolean(instance.has_secret || instance.secret)}
                value={formData.secret || ""}
                onChange={(value) => writeForm({ ...draftRef.current, secret: value || undefined })}
                help="RELAY_SECRET — sent as Authorization: Bearer on every call. Needed unless cookie login or open relay."
              />
            </div>

            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                Web token login (cookie, same-origin)
              </label>
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
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>login</span>
                </button>
                <button
                  type="button"
                  onClick={() => void doLogout()}
                  disabled={loginBusy || !authed}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
              {loginNote && <p className="mt-1 text-[11px] text-[#737373]">{loginNote}</p>}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                  Default workspace
                </label>
                <select
                  value={formData.workspace}
                  onChange={(e) => {
                    const next = { ...draftRef.current, workspace: e.target.value };
                    writeForm(next);
                    save(next);
                  }}
                  className={inputClass}
                >
                  <option value="">(host default)</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label || w.id}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                  Default persona
                </label>
                <select
                  value={formData.persona || ""}
                  onChange={(e) => {
                    const next = { ...draftRef.current, persona: e.target.value || undefined };
                    writeForm(next);
                    save(next);
                  }}
                  className={inputClass}
                >
                  <option value="">(host default)</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id}
                    </option>
                  ))}
                </select>
              </div>
            </div>

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
                  <option value="">(host default)</option>
                  <option value="inherit">inherit app setting</option>
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.model ? ` · ${p.model}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="grid grid-cols-4 gap-1">
                  {choices.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => pickProvider(item)}
                      className={`px-2 py-1.5 rounded border text-[11px] transition-colors ${
                        choice === item
                          ? "bg-white text-black border-white"
                          : "bg-[#0a0a0a] text-[#a3a3a3] border-[#262626] hover:text-white"
                      }`}
                    >
                      {item === "inherit" ? "Inherit" : providerLabel(item)}
                    </button>
                  ))}
                </div>
              )}
              {choice === "inherit" && providers.length === 0 && (
                <p className="text-[11px] text-[#737373] truncate">
                  Window: {providerLabel(kind)}
                  {windowModel ? ` · ${windowModel}` : ""}
                </p>
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
          </div>
        )}
      </div>
    </div>
  );
};
