import React from "react";
import { Globe, Settings } from "lucide-react";
import { KlankerInstance } from "../types/klanker";

interface HeaderProps {
  activeInstance: KlankerInstance | null;
  onOpenSettings: () => void;
}

export const Header: React.FC<HeaderProps> = ({ activeInstance, onOpenSettings }) => {
  const url = activeInstance?.endpoint?.base_url || activeInstance?.base_url || window.location.host;

  return (
    <header className="h-12 shrink-0 bg-[#000000] border-b border-[#262626] flex items-center justify-between px-3 select-none z-30">
      <div className="flex items-center min-w-0 space-x-3 text-xs font-mono">
        {activeInstance && (
          <div className="flex items-center space-x-1 text-[#737373] text-[11px] min-w-0">
            <Globe className="w-3 h-3 text-[#525252] shrink-0" />
            <span className="max-w-[280px] truncate">{url.replace(/^https?:\/\//, "")}</span>
            {activeInstance.workspace && <span className="text-[#525252]">· ws {activeInstance.workspace}</span>}
            {activeInstance.persona && <span className="text-[#525252]">· {activeInstance.persona}</span>}
          </div>
        )}
      </div>

      <div className="flex items-center space-x-2 shrink-0">
        <button
          onClick={onOpenSettings}
          className="flex items-center space-x-1 px-2 py-1 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-xs font-mono text-[#a3a3a3] hover:text-white transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Settings</span>
        </button>
      </div>
    </header>
  );
};
