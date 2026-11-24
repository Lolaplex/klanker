import React from "react";
import { Globe, Layers, Menu, Minus, QrCode, Settings, SlidersHorizontal, Square, Volume2, VolumeX, X } from "lucide-react";
import { KlankerInstance, ProcessStatus } from "../types/klanker";

interface HeaderProps {
  activeInstance: KlankerInstance | null;
  selWs: string;
  /** Selected contact id (resolved display name wins via personaLabel). */
  selPersona?: string;
  personaLabel?: string;
  /** Title of the open chat/session. */
  chatTitle?: string;
  /** Primary endpoint status — the pill opens the devices panel. */
  status?: ProcessStatus | null;
  onOpenDevices?: () => void;
  onOpenSettings: () => void;
  onOpenManage: () => void;
  onOpenNav: () => void;
  onOpenPair?: () => void;
  showStoreToggle?: boolean;
  storeOpen?: boolean;
  onToggleStore?: () => void;
  showVoiceToggle?: boolean;
  voiceEnabled?: boolean;
  onToggleVoice?: () => void;
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
      return { label: "online", dot: "bg-white animate-pulse" };
    case "starting":
      return { label: "starting", dot: "bg-white animate-pulse" };
    case "port_busy":
      return { label: "port busy", dot: "bg-[#a3a3a3]" };
    default:
      return { label: status?.state === "lost" ? "lost" : "offline", dot: "bg-[#525252]" };
  }
}

export const Header: React.FC<HeaderProps> = ({
  activeInstance,
  selWs,
  selPersona,
  personaLabel,
  chatTitle,
  status,
  onOpenDevices,
  onOpenSettings,
  onOpenManage,
  onOpenNav,
  onOpenPair,
  showStoreToggle,
  storeOpen,
  onToggleStore,
  showVoiceToggle,
  voiceEnabled,
  onToggleVoice,
}) => {
  const url = activeInstance?.endpoint?.base_url || activeInstance?.base_url || window.location.host;
  const win = tauriWindow();
  const run = (fn: (w: TauriWindow) => Promise<void>) => () => {
    if (win) void fn(win).catch(() => undefined);
  };
  const pill = statusMeta(status);

  return (
    <header data-tauri-drag-region className="min-h-12 shrink-0 bg-[#000000] border-b border-[#262626] flex items-center justify-between px-3 select-none z-30 touch-none">
      <div className="flex items-center min-w-0 space-x-3 text-xs font-mono" data-tauri-drag-region>
        <button
          onClick={onOpenNav}
          className="md:hidden -ml-1 inline-flex h-11 w-11 items-center justify-center text-[#a3a3a3] hover:text-white"
          aria-label="Open navigation"
        >
          <Menu className="w-4 h-4" />
        </button>
        {activeInstance && (
          <div className="flex items-center space-x-1 min-w-0 text-[11px]">
            <Globe className="w-3 h-3 text-[#525252] shrink-0 hidden md:inline" />
            <span className="font-semibold text-white truncate" title={url.replace(/^https?:\/\//, "")}>
              {selWs || activeInstance.name}
            </span>
            {selPersona && (
              <>
                <span className="text-[#525252] shrink-0">&gt;</span>
                <span className="text-[#a3a3a3] truncate">{personaLabel || selPersona}</span>
              </>
            )}
            {chatTitle && <span className="hidden md:inline text-[#525252] truncate">· {chatTitle}</span>}
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
            className="inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1.5 px-3 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-xs font-mono text-[#a3a3a3] hover:text-white transition-colors"
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pill.dot}`} />
            <span className="hidden md:inline">{pill.label}</span>
          </button>
        )}
        {activeInstance && showStoreToggle && onToggleStore && (
          <button
            type="button"
            onClick={onToggleStore}
            aria-label="Workspace store"
            className={`inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1 px-3 border rounded text-xs font-mono transition-colors ${
              storeOpen
                ? "bg-[#171717] border-white text-white"
                : "bg-[#0a0a0a] hover:bg-[#141414] border-[#262626] text-[#a3a3a3] hover:text-white"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Store</span>
          </button>
        )}
        {activeInstance && showVoiceToggle && onToggleVoice && (
          <button
            type="button"
            onClick={onToggleVoice}
            aria-label="Voice read-aloud"
            className={`inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1 px-3 border rounded text-xs font-mono transition-colors ${
              voiceEnabled
                ? "bg-[#171717] border-white text-white"
                : "bg-[#0a0a0a] hover:bg-[#141414] border-[#262626] text-[#a3a3a3] hover:text-white"
            }`}
          >
            {voiceEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            <span className="hidden md:inline">Voice</span>
          </button>
        )}
        {activeInstance && onOpenPair && (
          <button
            type="button"
            onClick={onOpenPair}
            aria-label="Pair device"
            className="inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1 px-3 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-xs font-mono text-[#a3a3a3] hover:text-white transition-colors"
          >
            <QrCode className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Pair</span>
          </button>
        )}
        {activeInstance && (
          <button
            onClick={onOpenManage}
            aria-label="Manage"
            className="inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1 px-3 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-xs font-mono text-[#a3a3a3] hover:text-white transition-colors"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Manage</span>
          </button>
        )}
        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          className="inline-flex h-11 min-w-11 md:h-8 md:min-w-0 items-center justify-center gap-1 px-3 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-xs font-mono text-[#a3a3a3] hover:text-white transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
          <span className="hidden md:inline">Settings</span>
        </button>

        {win && (
          <div className="hidden md:flex items-center">
            <div className="h-4 w-[1px] bg-[#262626] mx-1" />
            <button
              onClick={run((w) => w.minimize())}
              aria-label="Minimize"
              className="w-7 h-7 flex items-center justify-center text-[#737373] hover:text-white hover:bg-[#141414] rounded transition-colors"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              onClick={run((w) => w.toggleMaximize())}
              aria-label="Maximize"
              className="w-7 h-7 flex items-center justify-center text-[#737373] hover:text-white hover:bg-[#141414] rounded transition-colors"
            >
              <Square className="w-2.5 h-2.5" />
            </button>
            <button
              onClick={run((w) => w.close())}
              aria-label="Close"
              className="w-7 h-7 flex items-center justify-center text-[#737373] hover:text-white hover:bg-[#262626] rounded transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
