import React, { useEffect, useRef, useState } from "react";
import { Save, Trash2, LogIn, LogOut } from "lucide-react";
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

interface ConfigPanelProps {
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
  workspaces: { id: string; label?: string }[];
  personas: { id: string; name?: string }[];
  wsNote: string | null;
}

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";

const choices: ProviderChoice[] = ["echo", "lmstudio", "openrouter", "inherit"];

export const ConfigPanel: React.FC<ConfigPanelProps> = ({
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
  workspaces,
  personas,
  wsNote,
}) => {
  const [formData, setFormData] = useState<KlankerInstance>(instance);
  const draftRef = useRef(instance);
  const [isSaved, setIsSaved] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [loginToken, setLoginToken] = useState("");
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [newWs, setNewWs] = useState("");
  const [wsBusy, setWsBusy] = useState(false);
  const choice = choiceOf(formData);
  const kind = choice === "inherit" ? windowKind(settings) : choice;
  const showModel = choice === "lmstudio" || choice === "openrouter";

  useEffect(() => {
    setFormData(instance);
    draftRef.current = instance;
    setIsSaved(false);
    setLoginNote(null);
    setAuthed(null);
    void api
      .authStatus(instance)
      .then((s) => setAuthed(s.authenticated))
      .catch(() => setAuthed(null));
  }, [instance.id, instance.updated_at]);

  useEffect(() => {
    if (choice === "openrouter") onNeedModels();
  }, [choice, onNeedModels]);

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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    save();
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
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

  const starModel = (id: string) => {
    if (choice !== "lmstudio" && choice !== "openrouter") return;
    onStar(choice, id);
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

  const doCreateWorkspace = async () => {
    const id = newWs.trim();
    if (!id) return;
    setWsBusy(true);
    try {
      const wsId = await api.createWorkspace(instance, id);
      const next = { ...draftRef.current, workspace: wsId };
      writeForm(next);
      save(next);
      setNewWs("");
    } catch (e) {
      setLoginNote(e instanceof Error ? e.message : String(e));
    } finally {
      setWsBusy(false);
    }
  };

  const windowModel = kind !== "echo" ? settings.model.trim() : "";

  return (
    <details
      className="shrink-0 border-t border-[#262626] bg-[#0a0a0a] font-mono text-xs max-md:hidden"
      onToggle={(event) => setPanelOpen(event.currentTarget.open)}
    >
      <summary className="list-none cursor-pointer px-3 py-2 text-[11px] uppercase tracking-wider text-[#737373] hover:text-white [&::-webkit-details-marker]:hidden">
        Advanced
      </summary>
      <div className="max-h-[50vh] overflow-y-auto border-t border-[#262626]">
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] text-[#737373] uppercase tracking-wider">
              {status?.state === "running" ? "relay up" : "relay down"}
              {authed !== null && <span className="ml-2">{authed ? "· authed" : "· not authed"}</span>}
            </div>
            <div className="flex items-center space-x-2">
              {instance.id !== "local" && (
                <button
                  type="button"
                  onClick={() => onDelete(instance.id)}
                  className="p-1.5 bg-[#141414] hover:bg-[#262626] text-[#a3a3a3] border border-[#262626] rounded transition-colors"
                  title="Remove this relay"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="submit"
                className="flex items-center space-x-1.5 px-3 py-1.5 bg-white hover:bg-[#e5e5e5] text-black font-semibold rounded transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                <span>{isSaved ? "Saved" : "Save"}</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => writeForm({ ...draftRef.current, name: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Relay URL</label>
              <input
                type="text"
                value={formData.endpoint?.base_url || ""}
                onChange={(e) =>
                  writeForm({ ...draftRef.current, endpoint: { base_url: e.target.value } })
                }
                placeholder="https://relay.example.com (empty = this origin)"
                className={inputClass}
              />
            </div>
          </div>

          <SecretField
            label="Relay secret"
            stored={Boolean(instance.has_secret || instance.secret)}
            value={formData.secret || ""}
            onChange={(value) => writeForm({ ...draftRef.current, secret: value || undefined })}
            help="RELAY_SECRET — sent as Authorization: Bearer on every call. Needed unless cookie login or open relay."
          />

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
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Workspace</label>
              <select
                value={formData.workspace}
                onChange={(e) => {
                  const next = { ...draftRef.current, workspace: e.target.value };
                  writeForm(next);
                  save(next);
                }}
                className={inputClass}
              >
                <option value="">(relay default)</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label || w.id}
                  </option>
                ))}
              </select>
              <div className="mt-1 flex items-center gap-1">
                <input
                  type="text"
                  value={newWs}
                  onChange={(e) => setNewWs(e.target.value)}
                  placeholder="new workspace id"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => void doCreateWorkspace()}
                  disabled={wsBusy || !newWs.trim()}
                  className="shrink-0 px-2.5 py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
                >
                  + ws
                </button>
              </div>
            </div>
            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Persona</label>
              <select
                value={formData.persona || ""}
                onChange={(e) => {
                  const next = { ...draftRef.current, persona: e.target.value || undefined };
                  writeForm(next);
                  save(next);
                }}
                className={inputClass}
              >
                <option value="">(relay default)</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {wsNote && <p className="text-[11px] text-[#737373]">{wsNote}</p>}

          <div className="space-y-2">
            <div className="text-[10px] text-[#737373] uppercase tracking-wider">Provider</div>
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
            {choice === "inherit" && (
              <p className="text-[11px] text-[#737373] truncate">
                Window: {providerLabel(kind)}
                {windowModel ? ` · ${windowModel}` : ""}
              </p>
            )}
            {showModel && (
              <ModelControl
                provider={choice}
                label="Model"
                model={formData.model}
                recent={settings.recent_models[choice]}
                favorites={settings.favorites[choice]}
                ranked={choice === "openrouter" ? rankedIds : []}
                loading={choice === "openrouter" && loadingModels}
                note={choice === "openrouter" ? modelNote : null}
                onDraft={(id) => writeForm({ ...draftRef.current, model: id })}
                onCommit={commitModel}
                onToggleStar={starModel}
              />
            )}
          </div>
        </form>
        {panelOpen && (
          <div className="h-64 border-t border-[#262626] overflow-hidden">
            <TracesPanel instance={instance} />
          </div>
        )}
      </div>
    </details>
  );
};
