import React, { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { DesktopSettings, KlankerInstance } from "../types/klanker";
import { getPushSubscription, pushSupported, subscribePush, unsubscribePush } from "../push";
import { api } from "../services/api";
import { getQuickAskConfig, quickAskShortcutFormatError, setQuickAskConfig, type QuickAskConfig } from "../services/desktopApi";
import { ThemeSwitcher } from "./ui/ThemeSwitcher";
import { ProvidersPanel } from "./ProvidersPanel";
import { Dialog } from "./ui/Dialog";
import { Tabs } from "./ui/Tabs";
import { Switch } from "./ui/Switch";

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
  // Desktop app version + update flow (klanker#169 U15): api.checkAppUpdates
  // / installAppUpdate / klankerVersion were already wired in services but
  // never surfaced anywhere.
  const [appVersion, setAppVersion] = useState("");
  const [updateInfo, setUpdateInfo] = useState<{ available: boolean; version?: string } | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [quickAsk, setQuickAsk] = useState<QuickAskConfig>({ enabled: true, shortcut: "Alt+Space" });
  const [quickAskShortcut, setQuickAskShortcut] = useState("Alt+Space");
  const [quickAskBusy, setQuickAskBusy] = useState(false);
  const [quickAskError, setQuickAskError] = useState<string | null>(null);
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;

  // Desktop truth wins over the stored flag (user may have toggled the OS
  // setting outside the app). Hydrate once per open.
  useEffect(() => {
    if (!desktop) return;
    void api.autostartIsEnabled().then((on) => {
      setDraft((d) => (d.autostart === on ? d : { ...d, autostart: on }));
    });
    void api
      .klankerVersion()
      .then((v) => setAppVersion(v.klanker_version || ""))
      .catch(() => {});
    void getQuickAskConfig()
      .then((cfg) => {
        setQuickAsk(cfg);
        setQuickAskShortcut(cfg.shortcut);
      })
      .catch((e) => setQuickAskError(e instanceof Error ? e.message : String(e)));
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
  const checkUpdate = async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      const info = await api.checkAppUpdates();
      setUpdateInfo({ available: !!info.available, version: info.version || undefined });
      if (!info.available) setUpdateNote("up to date");
    } catch (e) {
      setUpdateNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateBusy(false);
    }
  };

  const installUpdate = async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      await api.installAppUpdate();
      setUpdateNote("update installing — the app restarts when ready");
    } catch (e) {
      setUpdateNote(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdateBusy(false);
    }
  };

  const saveQuickAsk = async (enabled = quickAsk.enabled, shortcut = quickAskShortcut) => {
    if (quickAskBusy) return;
    const formatError = quickAskShortcutFormatError(shortcut);
    if (formatError) {
      setQuickAskError(formatError);
      return;
    }
    setQuickAskBusy(true);
    setQuickAskError(null);
    try {
      const next = await setQuickAskConfig(enabled, shortcut.trim());
      setQuickAsk(next);
      setQuickAskShortcut(next.shortcut);
    } catch (e) {
      setQuickAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuickAskBusy(false);
    }
  };

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
    <Dialog open onClose={onClose} title="SETTINGS" wide>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          ariaLabel="settings sections"
          tabs={TABS.map((t) => ({ value: t.id, label: t.label }))}
        />

        {tab === "providers" && (
          instance ? (
            <ProvidersPanel instance={instance} onChanged={onProvidersChanged} />
          ) : (
            <p className="p-4 text-[10px] text-ink-dim">no instance selected.</p>
          )
        )}

        {tab === "host" && (
          <form onSubmit={save} className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 space-y-4">
            <div>
              <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1">Theme</div>
              <ThemeSwitcher />
              <p className="text-[10px] text-ink-dim mt-1">
                Dark is the klanker default — White inverts the same monochrome slots, System follows the OS.
              </p>
            </div>
            <div>
              <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1">Host</div>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-ink-dim">Host name</span>
                <input
                  value={hostLabelDraft}
                  onChange={(e) => setHostLabelDraft(e.target.value)}
                  placeholder="how paired devices see this machine"
                  className="w-full bg-elevated border border-subtle hover:border-strong focus:border-strong rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
                />
              </label>
              {hostNote && <p className="text-[10px] text-red-400 mt-1">{hostNote}</p>}
            </div>

            {desktop && (
              <div>
                <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1">Desktop</div>
                <div className="space-y-1">
                  <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-surface border border-subtle rounded-md text-[11px] text-ink-secondary hover:border-strong hover:text-ink-primary cursor-pointer">
                    <Switch checked={draft.autostart} onCheckedChange={(v) => setDraft({ ...draft, autostart: v })} ariaLabel="Launch klanker on login" />
                    Launch klanker on login
                  </label>
                  <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-surface border border-subtle rounded-md text-[11px] text-ink-secondary hover:border-strong hover:text-ink-primary cursor-pointer">
                    <Switch checked={!!draft.hub_mode} onCheckedChange={(v) => setDraft({ ...draft, hub_mode: v })} ariaLabel="Hub mode — serve on LAN" />
                    Hub mode — serve on LAN (0.0.0.0)
                  </label>
                  <p className="text-[10px] text-ink-dim">
                    On: the local serve binds 0.0.0.0 so tailnet/LAN peers can reach the hub. Off: 127.0.0.1 only.
                    Applies to the next spawn/restart.
                  </p>
                </div>
                <div className="mt-2 space-y-2 border-t border-subtle pt-2">
                  <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-surface border border-subtle rounded-md text-[11px] text-ink-secondary hover:border-strong hover:text-ink-primary cursor-pointer">
                    <Switch
                      checked={quickAsk.enabled}
                      onCheckedChange={(v) => void saveQuickAsk(v, quickAsk.shortcut)}
                      ariaLabel="Quick-Ask overlay"
                      disabled={quickAskBusy}
                    />
                    Quick-Ask overlay
                  </label>
                  <div className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-ink-dim">Global hotkey</div>
                    <div className="flex items-center gap-2">
                      <input
                        value={quickAskShortcut}
                        onChange={(e) => setQuickAskShortcut(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveQuickAsk();
                          }
                        }}
                        placeholder="Alt+Space"
                        aria-label="Quick-Ask global hotkey"
                        className="w-44 bg-elevated border border-subtle hover:border-strong focus:border-strong rounded-md px-2.5 py-1.5 text-[11px] text-ink-primary outline-none"
                      />
                      <button
                        type="button"
                        disabled={quickAskBusy || quickAskShortcut.trim() === quickAsk.shortcut}
                        onClick={() => void saveQuickAsk()}
                        className="inline-flex min-h-8 items-center px-2.5 py-1 bg-surface border border-subtle rounded-md text-[10px] text-ink-secondary hover:border-strong hover:text-ink-primary hover:bg-elevated disabled:opacity-50"
                      >
                        {quickAskBusy ? "saving…" : "apply"}
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {["Alt+Space", "Ctrl+Shift+K", "Alt+K"].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          disabled={quickAskBusy}
                          onClick={() => {
                            setQuickAskShortcut(preset);
                            void saveQuickAsk(quickAsk.enabled, preset);
                          }}
                          className={`inline-flex min-h-7 items-center px-2 py-0.5 border rounded-md text-[10px] ${
                            quickAsk.shortcut === preset
                              ? "bg-accent text-accent-ink border-accent"
                              : "bg-surface border-subtle text-ink-secondary hover:border-strong hover:text-ink-primary"
                          }`}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                    {quickAskError && <p className="text-[10px] text-danger">{quickAskError}</p>}
                    <p className="text-[10px] text-ink-dim">
                      Live-registers without restart. When Quick-Ask is off, the same hotkey raises the main window composer.
                    </p>
                  </div>
                </div>
                <div className="mt-2 border-t border-subtle pt-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-ink-secondary">
                      App version{appVersion ? `: ${appVersion}` : ""}
                    </span>
                    <button
                      type="button"
                      disabled={updateBusy}
                      onClick={() => void checkUpdate()}
                      className="inline-flex min-h-7 items-center px-2.5 py-1 bg-surface border border-subtle rounded-md text-[10px] text-ink-secondary hover:border-strong hover:text-ink-primary hover:bg-elevated disabled:opacity-50"
                      aria-label="Check for app updates"
                    >
                      {updateBusy ? "checking…" : "check for updates"}
                    </button>
                    {updateInfo?.available && (
                      <button
                        type="button"
                        disabled={updateBusy}
                        onClick={() => void installUpdate()}
                        className="inline-flex min-h-7 items-center px-2.5 py-1 bg-accent text-accent-ink border border-accent rounded-md text-[10px] hover:bg-accent-hover disabled:opacity-50"
                        aria-label={`Install update ${updateInfo.version || ""}`}
                      >
                        install {updateInfo.version || "update"}
                      </button>
                    )}
                  </div>
                  {updateNote && <p className="text-[10px] text-ink-dim mt-1">{updateNote}</p>}
                </div>
              </div>
            )}

            {onToggleVoice && (
              <div>
                <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1">Web</div>
                <label className="inline-flex min-h-9 items-center gap-2 px-3 py-1.5 bg-surface border border-subtle rounded-md text-[11px] text-ink-secondary hover:border-strong hover:text-ink-primary cursor-pointer">
                  <Switch checked={!!voiceEnabled} onCheckedChange={() => onToggleVoice()} ariaLabel="Browser read-aloud" />
                  Browser read-aloud (experimental)
                </label>
              </div>
            )}

            <div className="flex items-center justify-end space-x-2">
              <button type="button" onClick={onClose} className="inline-flex min-h-9 items-center px-3 py-1.5 text-ink-muted hover:text-ink-primary">
                Cancel
              </button>
              <button type="submit" className="inline-flex min-h-9 items-center gap-1 px-4 py-1.5 bg-accent hover:bg-accent-hover text-accent-ink font-semibold rounded-md">
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
                  className={`inline-flex min-h-9 items-center px-3 py-1.5 border rounded-md text-[11px] transition-colors disabled:opacity-50 ${
                    pushOn
                      ? "bg-accent text-accent-ink border-accent hover:bg-accent-hover"
                      : "bg-surface border-subtle text-ink-secondary hover:border-strong hover:bg-elevated hover:text-ink-primary"
                  }`}
                >
                  {pushBusy ? "…" : pushOn ? "Push on — disable" : "Enable push on this relay"}
                </button>
                {pushOn && !pushNote && (
                  <p className="text-[10px] text-ink-dim">Push enabled — reminders and approvals reach this device while the app is closed.</p>
                )}
                {pushNote && <p className="text-[10px] text-ink-dim">{pushNote}</p>}
              </>
            ) : (
              <p className="text-[10px] text-ink-dim">
                web push is not available in this browser/context.
              </p>
            )}
          </div>
        )}
    </Dialog>
  );
};
