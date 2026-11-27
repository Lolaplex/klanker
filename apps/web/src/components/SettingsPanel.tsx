import React, { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { DesktopSettings, KlankerInstance } from "../types/klanker";
import { getPushSubscription, pushSupported, subscribePush, unsubscribePush } from "../push";
import { api } from "../services/api";
import { ProvidersPanel } from "./ProvidersPanel";

interface SettingsPanelProps {
  settings: DesktopSettings;
  instance?: KlankerInstance | null;
  workspace?: string;
  persona?: string;
  /** Browser read-aloud (speechSynthesis) — lives here, not the topbar
   *  (klanker#160 U05). */
  voiceEnabled?: boolean;
  onToggleVoice?: () => void;
  onClose: () => void;
  onSave: (settings: DesktopSettings) => void;
  onProvidersChanged?: () => void;
}

type Tab = "providers" | "host" | "notifications";

const TABS: { id: Tab; label: string }[] = [
  { id: "providers", label: "Providers & Agents" },
  { id: "host", label: "Host & Desktop" },
  { id: "notifications", label: "Notifications" },
];

/** Tabbed host settings (klanker#160 U05): providers & agents, host/desktop
 *  surface, notifications. The legacy INSTANCES list is gone — ops remotes
 *  live under DevicesPanel → Advanced / Ops remotes only. */
export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  instance,
  workspace,
  persona,
  voiceEnabled,
  onToggleVoice,
  onClose,
  onSave,
  onProvidersChanged,
}) => {
  const [tab, setTab] = useState<Tab>("providers");
  const [draft, setDraft] = useState<DesktopSettings>({ ...settings });
  const [pushBusy, setPushBusy] = useState(false);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [hostLabel, setHostLabel] = useState<string | null>(null);
  const [hostLabelDraft, setHostLabelDraft] = useState("");
  const [hostNote, setHostNote] = useState<string | null>(null);
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;

  // Desktop truth wins over the stored flag (user may have toggled the OS
  // setting outside the app). Hydrate once per open.
  useEffect(() => {
    if (!desktop) return;
    void api.autostartIsEnabled().then((on) => {
      setDraft((d) => (d.autostart === on ? d : { ...d, autostart: on }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // This host's friendly name (U01 GET /v1/host contract).
  useEffect(() => {
    void api
      .fetchHostInfo()
      .then((info) => {
        setHostLabel(info.host_label || "");
        setHostLabelDraft((cur) => cur || info.host_label || "");
      })
      .catch(() => setHostLabel(null));
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

  // Save is wired to exactly what this panel owns: host_label (PATCH
  // /v1/host) plus the desktop settings draft (autostart/hub_mode).
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setHostNote(null);
    const nextLabel = hostLabelDraft.trim();
    if (nextLabel && nextLabel !== (hostLabel || "")) {
      try {
        const info = await api.setHostLabel(nextLabel);
        setHostLabel(info.host_label || nextLabel);
      } catch (e) {
        setHostNote(`host name: ${e instanceof Error ? e.message : e}`);
        return;
      }
    }
    onSave({ ...draft, workspace: draft.workspace.trim() });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="modal-card flex flex-col overflow-hidden bg-[#0a0a0a] border border-[#262626] w-full max-w-md rounded-lg shadow-2xl font-mono text-xs select-text max-h-[90vh]">
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider">SETTINGS</span>
          <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center text-[#737373] hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="shrink-0 px-4 pt-3 flex items-center gap-1.5 flex-wrap">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-2.5 py-1 border rounded ${
                tab === t.id ? "border-white text-white" : "border-[#262626] text-[#737373] hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "providers" && (
          instance ? (
            <ProvidersPanel instance={instance} onChanged={onProvidersChanged} />
          ) : (
            <p className="p-4 text-[10px] text-[#525252]">no instance selected.</p>
          )
        )}

        {tab === "host" && (
          <form onSubmit={save} className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 space-y-4">
            <div>
              <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Host</div>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-[#525252]">Host name</span>
                <input
                  value={hostLabelDraft}
                  onChange={(e) => setHostLabelDraft(e.target.value)}
                  placeholder="how paired devices see this machine"
                  className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none"
                />
              </label>
              {hostNote && <p className="text-[10px] text-red-400 mt-1">{hostNote}</p>}
            </div>

            {desktop && (
              <div>
                <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Desktop</div>
                <div className="space-y-1">
                  <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-[#0a0a0a] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.autostart}
                      onChange={(e) => setDraft({ ...draft, autostart: e.target.checked })}
                    />
                    Launch klanker on login
                  </label>
                  <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-[#0a0a0a] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!draft.hub_mode}
                      onChange={(e) => setDraft({ ...draft, hub_mode: e.target.checked })}
                    />
                    Hub mode — serve on LAN (0.0.0.0)
                  </label>
                  <p className="text-[10px] text-[#525252]">
                    On: the local serve binds 0.0.0.0 so tailnet/LAN peers can reach the hub. Off: 127.0.0.1 only.
                    Applies to the next spawn/restart.
                  </p>
                </div>
              </div>
            )}

            {onToggleVoice && (
              <div>
                <div className="text-[10px] text-[#737373] uppercase tracking-wider mb-1">Web</div>
                <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-[#0a0a0a] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!voiceEnabled}
                    onChange={() => onToggleVoice()}
                  />
                  Browser read-aloud (experimental)
                </label>
              </div>
            )}

            <div className="flex items-center justify-end space-x-2">
              <button type="button" onClick={onClose} className="inline-flex min-h-9 items-center px-3 py-1.5 text-[#737373] hover:text-white">
                Cancel
              </button>
              <button type="submit" className="inline-flex min-h-9 items-center gap-1 px-4 py-1.5 bg-white hover:bg-[#e5e5e5] text-black font-semibold rounded">
                <Check className="w-3.5 h-3.5" />
                Save
              </button>
            </div>
          </form>
        )}

        {tab === "notifications" && (
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 space-y-3">
            {instance && pushSupported() ? (
              <>
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
                  <p className="text-[10px] text-[#525252]">Push enabled — reminders and approvals reach this device while the app is closed.</p>
                )}
                {pushNote && <p className="text-[10px] text-[#525252]">{pushNote}</p>}
              </>
            ) : (
              <p className="text-[10px] text-[#525252]">
                web push is not available in this browser/context.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
