import React from "react";
import { Globe, Menu, Minus, Settings, SlidersHorizontal, Square, X } from "lucide-react";
import { KlankerInstance, ProcessStatus } from "../types/klanker";
import { ThemeSwitcher } from "./ui/ThemeSwitcher";

interface HeaderProps {
  activeInstance: KlankerInstance | null;
  selWs: string;
  /** Display label of the selected workspace — wins over the raw id
   *  (klanker#158 U03: never headline a bare workspace id when the
   *  operator named it). */
  workspaceLabel?: string;
  /** Selected contact id (resolved display name wins via personaLabel). */
  selPersona?: string;
  personaLabel?: string;
  /** Title of the open chat/session. */
  chatTitle?: string;
  /** Primary endpoint status — the pill opens the devices panel. */
  status?: ProcessStatus | null;
  onOpenDevices?: () => void;
  onOpenSettings: () => void;
  onOpenWorkspace: () => void;
  onOpenNav: () => void;
  /** Open handoffs in the selected workspace — unread badge on the
   *  Workspace button (klanker#166 U11). */
  workspaceUnread?: number;
}

type TauriWindow = { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void> };

function tauriWindow(): TauriWindow | null {
  const w = window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindow } } };
  return w.__TAURI__?.window?.getCurrentWindow?.() ?? null;
}

/** Status pill text/dot for the primary endpoint. */
function statusMeta(status: ProcessStatus | null | undefined): { label: string; dot: string } {
  if (status?.detail === "unauthorized") return { label: "auth", dot: "bg-red-500" };
  switch (status?.state) {
    case "running":
    case "not_owned":
      return { label: "online", dot: "bg-accent animate-pulse" };
    case "starting":
      return { label: "starting", dot: "bg-accent animate-pulse" };
    case "port_busy":
      return { label: "port busy", dot: "bg-ink-secondary" };
    default:
      return { label: status?.state === "lost" ? "lost" : "offline", dot: "bg-ink-dim" };
  }
}

export const Header: React.FC<HeaderProps> = ({
  activeInstance,
  selWs,
  workspaceLabel,
  selPersona,
  personaLabel,
  chatTitle,
  status,
  onOpenDevices,
  onOpenSettings,
  onOpenWorkspace,
  onOpenNav,
  workspaceUnread = 0,
}) => {
  const url = activeInstance?.endpoint?.base_url || activeInstance?.base_url || window.location.host;
  const win = tauriWindow();
  const run = (fn: (w: TauriWindow) => Promise<void>) => () => {
    if (win) void fn(win).catch(() => undefined);
  };
  const pill = statusMeta(status);

  return (
    <header data-tauri-drag-region className="min-h-12 shrink-0 bg-main border-b border-strong flex items-center justify-between px-3 select-none z-30 touch-none">
      <div className="flex items-center min-w-0 space-x-3 text-xs font-mono" data-tauri-drag-region>
        <button
          onClick={onOpenNav}
          className="md:hidden -ml-1 inline-flex h-11 w-11 items-center justify-center text-ink-secondary hover:text-ink-primary"
          aria-label="Open navigation"
        >
          <Menu className="w-4 h-4" />
        </button>
        {activeInstance && (
          <div className="flex items-center space-x-1 min-w-0 text-[11px]">
            <Globe className="w-3 h-3 text-ink-dim shrink-0 hidden md:inline" />
            <span className="font-semibold text-ink-primary truncate" title={url.replace(/^https?:\/\//, "")}>
              {workspaceLabel || selWs || activeInstance.name}
            </span>
            {selPersona && (
              <>
                <span className="text-ink-dim shrink-0">&gt;</span>
                <span className="text-ink-secondary truncate">{personaLabel || selPersona}</span>
              </>
            )}
            {chatTitle && <span className="hidden md:inline text-ink-dim truncate">· {chatTitle}</span>}
          </div>
        )}
      </div>

      <div className="flex items-center space-x-2 shrink-0">
        {activeInstance && onOpenDevices && (
          <button
            type="button"
            onClick={onOpenDevices}
            aria-label="Devices"
            title="Devices &amp; presence"
            className="inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1.5 px-3 bg-surface hover:bg-elevated border border-strong rounded-md text-xs font-mono text-ink-secondary hover:text-ink-primary transition-colors"
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pill.dot}`} />
            <span className="hidden md:inline">Devices · {pill.label}</span>
          </button>
        )}
        {activeInstance && (
          <button
            onClick={onOpenWorkspace}
            aria-label="Workspace"
            className="relative inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1 px-3 bg-surface hover:bg-elevated border border-strong rounded-md text-xs font-mono text-ink-secondary hover:text-ink-primary transition-colors"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Workspace</span>
            {workspaceUnread > 0 && (
              <span
                className="absolute -top-1.5 -right-1.5 min-w-4 px-1 rounded-full bg-accent text-accent-ink text-[9px] font-mono text-center"
                title={`${workspaceUnread} open handoff${workspaceUnread === 1 ? "" : "s"}`}
                aria-label={`${workspaceUnread} open handoffs`}
              >
                {workspaceUnread}
              </span>
            )}
          </button>
        )}
        <div className="hidden sm:block">
          <ThemeSwitcher compact />
        </div>
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          className="inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1 px-3 bg-surface hover:bg-elevated border border-strong rounded-md text-xs font-mono text-ink-secondary hover:text-ink-primary transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Settings</span>
        </button>

        {win && (
          <div className="hidden md:flex items-center">
            <div className="h-4 w-[1px] bg-hover mx-1" />
            <button
              onClick={run((w) => w.minimize())}
              aria-label="Minimize"
              className="w-7 h-7 flex items-center justify-center text-ink-muted hover:text-ink-primary hover:bg-elevated rounded-md transition-colors"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              onClick={run((w) => w.toggleMaximize())}
              aria-label="Maximize"
              className="w-7 h-7 flex items-center justify-center text-ink-muted hover:text-ink-primary hover:bg-elevated rounded-md transition-colors"
            >
              <Square className="w-2.5 h-2.5" />
            </button>
            <button
              onClick={run((w) => w.close())}
              aria-label="Close"
              className="w-7 h-7 flex items-center justify-center text-ink-muted hover:text-ink-primary hover:bg-hover rounded-md transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
