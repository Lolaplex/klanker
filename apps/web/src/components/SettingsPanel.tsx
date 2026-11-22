import React, { useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { DesktopSettings, KlankerInstance } from "../types/klanker";
import { getPushSubscription, pushSupported, subscribePush, unsubscribePush } from "../push";
import { api } from "../services/api";

interface SettingsPanelProps {
  settings: DesktopSettings;
  instance?: KlankerInstance | null;
  workspace?: string;
  persona?: string;
  instances?: KlankerInstance[];
  onClose: () => void;
  onSave: (settings: DesktopSettings) => void;
  onAddInstance?: () => void;
  onEditInstance?: (inst: KlankerInstance) => void;
}

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  instance,
  workspace,
  persona,
  instances,
  onClose,
  onSave,
  onAddInstance,
  onEditInstance,
}) => {
  const [draft, setDraft] = useState<DesktopSettings>({ ...settings });
  const [pushBusy, setPushBusy] = useState(false);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [recallOn, setRecallOn] = useState<boolean | null>(null);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;

  // Auto-recall is a workspace flag on the serving relay — fetch once per open.
  useEffect(() => {
    if (!instance) return;
    api.getRecall(instance, workspace || "").then(setRecallOn).catch(() => setRecallOn(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleRecall = (on: boolean) => {
    if (!instance) return;
    setRecallOn(on);
    setRecallNote(null);
    api
      .setRecall(instance, workspace || "", on)
      .then((applied) => setRecallOn(applied))
      .catch((e) => {
        setRecallOn(!on);
        setRecallNote(`recall off: ${e instanceof Error ? e.message : e}`);
      });
  };

  // Desktop truth wins over the stored flag (user may have toggled the OS
  // setting outside the app). Hydrate once per open.
  useEffect(() => {
    if (!desktop) return;
    void api.autostartIsEnabled().then((on) => {
      setDraft((d) => (d.autostart === on ? d : { ...d, autostart: on }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect the real browser subscription — the button is a state toggle,
  // not a one-shot "enable" that looks identical before and after.
  useEffect(() => {
    if (!instance || !pushSupported()) return;
    void getPushSubscription()
      .then((sub) => setPushOn(!!sub))
      .catch(() => setPushOn(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePush = async () => {
    if (!instance) return;
    setPushBusy(true);
    setPushNote(null);
    try {
      if (pushOn) {
        const dropped = await unsubscribePush();
        setPushOn(false);
        setPushNote(
          dropped
            ? "Push off on this device — the relay drops the stored endpoint on the next send."
            : "Push was already off."
        );
        return;
      }
      const r = await subscribePush(instance, workspace, persona);
      if (r.ok) {
        setPushOn(true);
        setPushNote("Push enabled — reminders and approvals reach this device while the app is closed.");
      } else {
        setPushNote(`Push off: ${r.reason}`);
      }
    } catch (e) {
      setPushNote(`Push failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setPushBusy(false);
    }
  };

  const pickWorkdir = async () => {
    const dir = await (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<string | null> } } })
      .__TAURI__.core.invoke("plugin:dialog|open", { options: { directory: true, title: "Choose default workdir" } })
      .catch(() => null);
    if (dir) setDraft((d) => ({ ...d, workspace: dir }));
  };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    onSave({ ...draft, workspace: draft.workspace.trim() });
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
          {instances && (
            <div>
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Instances</div>
              <div className="space-y-1">
                {instances.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => onEditInstance?.(i)}
                    className="w-full text-left min-h-9 px-2 py-1.5 rounded border border-[#262626] text-[#a3a3a3] hover:bg-[#141414] hover:text-white transition-colors"
                  >
                    {i.name}
                    <span className="text-[#525252]">
                      {" "}
                      {i.kind === "local" ? "local" : (i.endpoint?.base_url || "").replace(/^https?:\/\//, "")}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={onAddInstance}
                  className="w-full min-h-9 px-2 py-1.5 rounded border border-dashed border-[#262626] text-[#737373] hover:border-[#525252] hover:text-white transition-colors"
                >
                  + connect
                </button>
              </div>
            </div>
          )}

          {/* Workdir + LM Studio/Echo are desktop-local concepts: a browser
              can't spawn a local serve and the relay never sees these URLs. */}
          {desktop && (
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
              <button
                type="button"
                title="Browse…"
                onClick={() => void pickWorkdir()}
                className="shrink-0 p-2 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-[10px] text-[#525252] mt-1">
              Fallback file-access boundary for local instances that don't set their own.
            </p>
          </div>
          )}

          {desktop && (
            <div>
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Desktop</div>
              <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-[#0a0a0a] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.autostart}
                  onChange={(e) => setDraft({ ...draft, autostart: e.target.checked })}
                  className="accent-white"
                />
                Launch klanker on login
              </label>
            </div>
          )}

          {instance && (
            <div>
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Context</div>
              <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-[#0a0a0a] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!recallOn}
                  disabled={recallOn === null}
                  onChange={(e) => toggleRecall(e.target.checked)}
                  className="accent-white"
                />
                Auto-recall memory + repo before each turn
              </label>
              {recallNote && <p className="text-[10px] text-[#525252] mt-1">{recallNote}</p>}
            </div>
          )}

          {instance && pushSupported() && (
            <div>
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Notifications</div>
              <button
                type="button"
                disabled={pushBusy || pushOn === null}
                onClick={() => void togglePush()}
                className={`inline-flex min-h-9 items-center px-3 py-1.5 border rounded text-[11px] transition-colors disabled:opacity-50 ${
                  pushOn
                    ? "bg-white text-black border-white hover:bg-[#e5e5e5]"
                    : "bg-[#0a0a0a] border-[#262626] text-[#a3a3a3] hover:bg-[#141414] hover:text-white"
                }`}
              >
                {pushBusy ? "…" : pushOn ? "Push on — disable" : "Enable push on this relay"}
              </button>
              {pushOn && !pushNote && (
                <p className="text-[10px] text-[#525252] mt-1">Push enabled — reminders and approvals reach this device while the app is closed.</p>
              )}
              {pushNote && <p className="text-[10px] text-[#525252] mt-1">{pushNote}</p>}
            </div>
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
