import React from "react";
import { Globe, Menu, Minus, Settings, SlidersHorizontal, Square, X } from "lucide-react";
import { KlankerInstance } from "../types/klanker";

interface HeaderProps {
  activeInstance: KlankerInstance | null;
  selWs: string;
  onOpenSettings: () => void;
  onOpenManage: () => void;
  onOpenNav: () => void;
}

type TauriWindow = { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void> };

function tauriWindow(): TauriWindow | null {
  const w = window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindow } } };
  return w.__TAURI__?.window?.getCurrentWindow?.() ?? null;
}

export const Header: React.FC<HeaderProps> = ({ activeInstance, selWs, onOpenSettings, onOpenManage, onOpenNav }) => {
  const url = activeInstance?.endpoint?.base_url || activeInstance?.base_url || window.location.host;
  const remote = activeInstance?.kind === "remote";
  const win = tauriWindow();
  const run = (fn: (w: TauriWindow) => Promise<void>) => () => {
    if (win) void fn(win).catch(() => undefined);
  };

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
          <>
            <span className="md:hidden font-semibold text-white truncate">{activeInstance.name}</span>
            <div className="hidden md:flex items-center space-x-1 text-[#737373] text-[11px] min-w-0">
              <Globe className="w-3 h-3 text-[#525252] shrink-0" />
              <span className="max-w-[280px] truncate">{url.replace(/^https?:\/\//, "")}</span>
              {selWs && <span className="text-[#525252]">· ws {selWs}</span>}
              {!remote && activeInstance.workspace && (
                <span className="text-[#525252]">· {activeInstance.workspace}</span>
              )}
              {activeInstance.persona && <span className="text-[#525252]">· {activeInstance.persona}</span>}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center space-x-2 shrink-0">
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
