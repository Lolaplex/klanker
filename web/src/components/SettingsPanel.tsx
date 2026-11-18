import React, { useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { DesktopSettings } from "../types/klanker";
import { LM_URL, ModelProvider, providerLabel, ProviderKind, toggleFavorite } from "../openrouterModels";
import { ModelControl } from "./ModelControl";
import { SecretField } from "./SecretField";

interface SettingsPanelProps {
  settings: DesktopSettings;
  rankedIds: string[];
  modelNote: string | null;
  loadingModels: boolean;
  onClose: () => void;
  onSave: (settings: DesktopSettings) => void;
  onStar: (provider: ModelProvider, id: string) => void;
}

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";

const choices: ProviderKind[] = ["echo", "lmstudio", "openrouter"];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  rankedIds,
  modelNote,
  loadingModels,
  onClose,
  onSave,
  onStar,
}) => {
  const [draft, setDraft] = useState<DesktopSettings>({ ...settings, openrouter_api_key: "" });
  const [keyDraft, setKeyDraft] = useState("");
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;

  const pickWorkdir = async () => {
    const dir = await (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<string | null> } } })
      .__TAURI__.core.invoke("plugin:dialog|open", { options: { directory: true, title: "Choose default workdir" } })
      .catch(() => null);
    if (dir) setDraft((d) => ({ ...d, workspace: dir }));
  };
  const kind: ProviderKind = draft.provider === "lmstudio" || draft.provider === "openrouter" ? draft.provider : "echo";

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const provider = kind;
    onSave({
      ...draft,
      provider,
      model: provider === "echo" ? "" : draft.model.trim(),
      lmstudio_base_url: draft.lmstudio_base_url.trim() || LM_URL,
      openrouter_api_key: keyDraft.trim(),
      workspace: draft.workspace.trim(),
    });
  };

  const star = (id: string) => {
    if (kind === "echo") return;
    const next = toggleFavorite(draft, kind, id);
    setDraft(next);
    onStar(kind, id);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="modal-card flex flex-col overflow-hidden bg-[#0a0a0a] border border-[#262626] w-full max-w-md rounded-lg shadow-2xl font-mono text-xs select-text">
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider">SETTINGS</span>
          <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center text-[#737373] hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={save} className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 space-y-4">
          <div>
            <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
              Default workdir
            </label>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={draft.workspace}
                onChange={(e) => setDraft({ ...draft, workspace: e.target.value })}
                placeholder="tool confinement dir for new local instances"
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
            <p className="text-[10px] text-[#525252] mt-1">
              Fallback file-access boundary for local instances that don't set their own.
            </p>
          </div>

          <div>
            <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Fallback provider</div>
            <div className="grid grid-cols-3 gap-1">
              {choices.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setDraft({ ...draft, provider: item })}
                  className={`px-2 py-1.5 min-h-9 rounded border text-[11px] transition-colors ${
                    kind === item
                      ? "bg-white text-black border-white"
                      : "bg-[#0a0a0a] text-[#a3a3a3] border-[#262626] hover:text-white"
                  }`}
                >
                  {providerLabel(item)}
                </button>
              ))}
            </div>
          </div>

          {kind === "lmstudio" && (
            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                LM Studio base URL
              </label>
              <input
                type="text"
                value={draft.lmstudio_base_url}
                onChange={(event) => setDraft({ ...draft, lmstudio_base_url: event.target.value })}
                placeholder={LM_URL}
                className={inputClass}
              />
            </div>
          )}

          {kind === "openrouter" && (
            <SecretField
              label="OpenRouter API key"
              stored={settings.openrouter_key_set}
              value={keyDraft}
              onChange={setKeyDraft}
            />
          )}

          {kind !== "echo" && (
            <ModelControl
              provider={kind}
              label="Fallback model"
              model={draft.model}
              recent={draft.recent_models[kind]}
              favorites={draft.favorites[kind]}
              ranked={kind === "openrouter" ? rankedIds : []}
              loading={kind === "openrouter" && loadingModels}
              note={kind === "openrouter" ? modelNote : null}
              onDraft={(id) => setDraft({ ...draft, model: id })}
              onCommit={(id) => setDraft({ ...draft, model: id.trim() })}
              onToggleStar={star}
            />
          )}

          <div className="flex items-center justify-end space-x-2">
            <button type="button" onClick={onClose} className="inline-flex min-h-9 items-center px-3 py-1.5 text-[#737373] hover:text-white">
              Cancel
            </button>
            <button type="submit" className="inline-flex min-h-9 items-center px-4 py-1.5 bg-white hover:bg-[#e5e5e5] text-black font-semibold rounded">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
