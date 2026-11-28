import React from "react";
import { Command, Menu, Minus, PanelLeftOpen, PanelRight, Settings, Square, X } from "lucide-react";
import { KlankerInstance, ProcessStatus } from "../types/klanker";
import { ThemeSwitcher } from "./ui/ThemeSwitcher";
import { KlankerMark } from "./KlankerMark";

interface HeaderProps {
  activeInstance: KlankerInstance | null;
  selWs: string;
  workspaceLabel?: string;
  selPersona?: string;
  personaLabel?: string;
  chatTitle?: string;
  status?: ProcessStatus | null;
  onOpenDevices?: () => void;
  onOpenSettings: () => void;
  onOpenWorkspace: () => void;
  onOpenNav: () => void;
  onOpenPalette: () => void;
  onToggleWorkbench: () => void;
  workbenchOpen?: boolean;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  workspaceUnread?: number;
  pendingApprovals?: number;
  /** Host/provider pickers and turn controls moved out of the chat stream. */
  controls?: React.ReactNode;
}

type TauriWindow = { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void> };

function tauriWindow(): TauriWindow | null {
  const w = window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindow } } };
  return w.__TAURI__?.window?.getCurrentWindow?.() ?? null;
}

function statusMeta(status: ProcessStatus | null | undefined): { label: string; dot: string } {
  if (status?.detail === "unauthorized") return { label: "auth", dot: "bg-red-500" };
  switch (status?.state) {
    case "running":
    case "not_owned":
      return { label: "online", dot: "bg-success animate-pulse" };
    case "starting":
      return { label: "starting", dot: "bg-accent animate-pulse" };
    case "port_busy":
      return { label: "port busy", dot: "bg-ink-secondary" };
    default:
      return { label: status?.state === "lost" ? "lost" : "offline", dot: "bg-ink-dim" };
  }
}

const iconBtn =
  "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md border border-subtle bg-transparent px-2 text-[11px] font-mono text-ink-secondary transition-colors hover:bg-hover hover:border-strong hover:text-ink-primary";

const ghostBtn =
  "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent bg-transparent text-ink-secondary transition-colors hover:bg-hover hover:text-ink-primary";

/** Unified 44px shell header (klanker#171): one navigation row, breadcrumb
 *  context in the center, chat/host controls and shell commands on the right. */
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
  onOpenPalette,
  onToggleWorkbench,
  workbenchOpen = false,
  sidebarCollapsed = false,
  onToggleSidebar,
  workspaceUnread = 0,
  pendingApprovals = 0,
  controls,
}) => {
  const win = tauriWindow();
  const run = (fn: (w: TauriWindow) => Promise<void>) => () => {
    if (win) void fn(win).catch(() => undefined);
  };
  const pill = statusMeta(status);

  return (
    <header data-tauri-drag-region className="h-11 shrink-0 select-none border-b border-subtle bg-main z-30 touch-none">
      <div className="grid h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2" data-tauri-drag-region>
        <div className="flex min-w-0 items-center gap-1">
          {sidebarCollapsed && onToggleSidebar && (
            <button
              type="button"
              onClick={onToggleSidebar}
              className="hidden md:inline-flex h-8 w-8 items-center justify-center rounded-md border border-subtle bg-transparent text-ink-secondary transition-colors hover:bg-hover hover:border-strong hover:text-ink-primary"
              aria-label="Expand sidebar"
              title="Expand sidebar (Ctrl/⌘ B)"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={onOpenNav}
            className="md:hidden inline-flex h-9 w-9 items-center justify-center text-ink-secondary hover:text-ink-primary"
            aria-label="Open navigation"
          >
            <Menu className="w-4 h-4" />
          </button>
          <div className={`${sidebarCollapsed ? "flex" : "flex md:hidden"} items-center gap-2 pl-1 text-xs font-semibold text-ink-primary`}>
            <KlankerMark size={16} className="shrink-0" />
            <span className="tracking-wider">klanker</span>
          </div>
        </div>

        <nav aria-label="Current context" className="flex min-w-0 items-center justify-center gap-1 font-mono text-[11px]" data-tauri-drag-region>
          {activeInstance ? (
            <>
              <button type="button" onClick={onOpenWorkspace} className="max-w-32 truncate rounded px-1 py-1 text-left font-semibold text-ink-primary hover:bg-hover" title="Workspace settings">
                {workspaceLabel || selWs || activeInstance.name}
              </button>
              {workspaceUnread > 0 && (
                <span className="rounded-full bg-accent px-1 text-[9px] text-accent-ink" aria-label={`${workspaceUnread} open handoffs`}>
                  {workspaceUnread}
                </span>
              )}
              {selPersona && (
                <>
                  <span className="text-ink-dim">/</span>
                  <span className="max-w-24 truncate text-ink-secondary">{personaLabel || selPersona}</span>
                </>
              )}
              {chatTitle && (
                <>
                  <span className="hidden md:inline text-ink-dim">/</span>
                  <span className="hidden md:inline max-w-64 truncate text-ink-dim">{chatTitle}</span>
                </>
              )}
            </>
          ) : (
            <span className="text-ink-dim">no relay connected</span>
          )}
        </nav>

        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          {pendingApprovals > 0 && (
            <span className="rounded-full border border-strong bg-accent px-1.5 py-0.5 font-mono text-[9px] text-accent-ink" title="Pending approvals">
              {pendingApprovals}
            </span>
          )}
          {controls}
          <button type="button" onClick={onOpenPalette} aria-label="Open command palette" title="Command palette (Ctrl/⌘ K)" className={iconBtn}>
            <Command className="h-3.5 w-3.5" />
            <kbd className="hidden lg:inline text-[9px] text-ink-dim">⌘K</kbd>
          </button>
          {activeInstance && onOpenDevices && (
            <button type="button" onClick={onOpenDevices} aria-label="Devices" title={`Devices · ${pill.label}`} className={iconBtn}>
              <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
              <span className="hidden xl:inline">{pill.label}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onToggleWorkbench}
            aria-label="Toggle workbench"
            aria-pressed={workbenchOpen}
            title="Workbench (Ctrl/⌘ J)"
            className={`${ghostBtn} ${workbenchOpen ? "border-subtle bg-elevated text-ink-primary" : ""}`}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
          <div className="hidden sm:block">
            <ThemeSwitcher compact />
          </div>
          <button type="button" onClick={onOpenSettings} aria-label="Settings" title="Settings" className={ghostBtn}>
            <Settings className="h-3.5 w-3.5" />
          </button>
          {win && (
            <div className="hidden md:flex items-center">
              <div className="mx-1 h-4 w-px bg-hover" />
              <button onClick={run((w) => w.minimize())} aria-label="Minimize" className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-elevated hover:text-ink-primary">
                <Minus className="h-3 w-3" />
              </button>
              <button onClick={run((w) => w.toggleMaximize())} aria-label="Maximize" className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-elevated hover:text-ink-primary">
                <Square className="h-2.5 w-2.5" />
              </button>
              <button onClick={run((w) => w.close())} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-hover hover:text-ink-primary">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
