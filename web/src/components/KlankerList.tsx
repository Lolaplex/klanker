import React, { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Radar, Settings2, X } from "lucide-react";
import { KlankerInstance, ProcessStatus } from "../types/klanker";
import { KlankerMark } from "./KlankerMark";

export interface SessionRow {
  chatId: string;
  session: string;
  label: string;
  pending: boolean;
}

export interface PersonaRow {
  id: string;
  name?: string;
}

interface KlankerListProps {
  instances: KlankerInstance[];
  activeId: string | null;
  unread: ReadonlySet<string>;
  statuses: Record<string, ProcessStatus | undefined>;
  selWs: string;
  selPersona: string;
  openChatId: string | null;
  workspaces: { id: string; label?: string }[];
  personasOf: (ws: string) => PersonaRow[] | undefined;
  sessionRowsOf: (ws: string, persona: string) => SessionRow[] | undefined;
  onSelect: (instance: KlankerInstance) => void;
  onExpandWs: (ws: string) => void;
  onExpandPersona: (ws: string, persona: string) => void;
  onSelectChat: (ws: string, persona: string, chatId: string) => void;
  onNewChat: (ws: string, persona: string) => void;
  onDeleteChat: (ws: string, persona: string, row: SessionRow) => void;
  onNewHost: () => void;
  onNewWorkspace: () => void;
  onHostSettings: (instance: KlankerInstance) => void;
  onDeleteWorkspace: (ws: string) => void;
  onNewPersona: (ws: string) => void;
  onDeletePersona: (ws: string, persona: string) => void;
}

function rowHealth(row: ProcessStatus | undefined): "up" | "down" | "busy" {
  if (row?.state === "running" || row?.state === "not_owned") return "up";
  if (row?.state === "port_busy") return "busy";
  return "down";
}

function dotClass(row: ProcessStatus | undefined): string {
  const health = rowHealth(row);
  if (health === "down") return "bg-[#525252]";
  if (health === "busy") return "border border-white";
  return row?.state === "running" ? "bg-white animate-pulse" : "bg-white";
}

export const KlankerList: React.FC<KlankerListProps> = ({
  instances,
  activeId,
  unread,
  statuses,
  selWs,
  selPersona,
  openChatId,
  workspaces,
  personasOf,
  sessionRowsOf,
  onSelect,
  onExpandWs,
  onExpandPersona,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onNewHost,
  onNewWorkspace,
  onHostSettings,
  onDeleteWorkspace,
  onNewPersona,
  onDeletePersona,
}) => {
  const [openWs, setOpenWs] = useState<ReadonlySet<string>>(new Set());
  const [openPersona, setOpenPersona] = useState<ReadonlySet<string>>(new Set());
  const rows = instances.slice().sort((a, b) => Number(unread.has(b.id)) - Number(unread.has(a.id)));

  const toggleWs = (ws: string) => {
    setOpenWs((prev) => {
      const next = new Set(prev);
      if (next.has(ws)) next.delete(ws);
      else {
        next.add(ws);
        onExpandWs(ws);
      }
      return next;
    });
  };

  const togglePersona = (ws: string, persona: string) => {
    const key = `${ws} ${persona}`;
    setOpenPersona((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        onExpandPersona(ws, persona);
      }
      return next;
    });
  };

  const chevron = (open: boolean) =>
    open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />;

  return (
    <aside className="h-full w-[80vw] max-w-72 md:w-52 shrink-0 flex flex-col border-r border-[#262626] bg-[#000000]">
      <div className="h-12 shrink-0 flex items-center px-3 border-b border-[#262626] font-mono text-xs font-semibold tracking-wider text-white">
        <KlankerMark size={20} className="mr-2 shrink-0" />
        <span>KLANKER</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {instances.length === 0 ? (
          <p className="px-3 py-3 text-[#525252] font-mono text-xs">No Klankers.</p>
        ) : (
          rows.map((inst) => {
            const row = statuses[inst.id];
            const selected = inst.id === activeId;
            const hot = unread.has(inst.id) && !selected;
            return (
              <div key={inst.id}>
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => onSelect(inst)}
                    title={rowHealth(row)}
                    className={`flex-1 min-w-0 text-left px-3 py-3 md:py-2 flex items-center gap-2 font-mono text-xs transition-colors ${
                      selected ? "bg-[#141414] text-white" : "text-[#a3a3a3] hover:bg-[#181818]"
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass(row)}`} />
                    <span className={`truncate ${hot ? "font-semibold text-white" : ""}`}>{inst.name}</span>
                    {hot ? <span className="ml-auto h-1.5 w-1.5 shrink-0 bg-white" /> : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => onHostSettings(inst)}
                    title="Host settings"
                    className={`shrink-0 p-2 transition-colors ${
                      selected ? "text-[#a3a3a3] hover:text-white" : "text-[#525252] hover:text-white"
                    }`}
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {selected && (
                  <div className="pb-1">
                    {workspaces.map((w) => {
                      const wsOpen = openWs.has(w.id);
                      const personas = personasOf(w.id);
                      return (
                        <div key={w.id} className="group">
                          <div className="flex items-center">
                            <button
                              type="button"
                              onClick={() => toggleWs(w.id)}
                              className={`flex-1 min-w-0 text-left pl-6 pr-2 py-2 md:py-1 flex items-center gap-1 font-mono text-[11px] transition-colors ${
                                selWs === w.id ? "text-white" : "text-[#a3a3a3] hover:bg-[#181818]"
                              }`}
                            >
                              {chevron(wsOpen)}
                              <span className="truncate">{w.label || w.id}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteWorkspace(w.id)}
                              title="Archive workspace"
                              className="shrink-0 p-1 mr-1 text-[#525252] opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-white transition-opacity"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                          {wsOpen && (
                            <div>
                              {(personas ?? []).map((p) => {
                                const pKey = `${w.id} ${p.id}`;
                                const pOpen = openPersona.has(pKey);
                                const sessions = sessionRowsOf(w.id, p.id);
                                return (
                                  <div key={p.id} className="group/persona">
                                    <div className="flex items-center">
                                      <button
                                        type="button"
                                        onClick={() => togglePersona(w.id, p.id)}
                                        className={`flex-1 min-w-0 text-left pl-9 pr-2 py-2 md:py-1 flex items-center gap-1 font-mono text-[11px] transition-colors ${
                                          selPersona === p.id && selWs === w.id
                                            ? "text-white"
                                            : "text-[#a3a3a3] hover:bg-[#181818]"
                                        }`}
                                      >
                                        {chevron(pOpen)}
                                        <span className="truncate">{p.name || p.id}</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => onDeletePersona(w.id, p.id)}
                                        title="Archive persona"
                                        className="shrink-0 p-1 mr-1 text-[#525252] opacity-100 md:opacity-0 md:group-hover/persona:opacity-100 hover:text-white transition-opacity"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                    {pOpen && (
                                      <div>
                                        {(sessions ?? []).map((s) => (
                                          <div key={s.chatId} className="group flex items-center">
                                            <button
                                              type="button"
                                              onClick={() => onSelectChat(w.id, p.id, s.chatId)}
                                              title={s.session}
                                              className={`flex-1 min-w-0 text-left pl-12 pr-1 py-2 md:py-0.5 font-mono text-[11px] truncate transition-colors ${
                                                openChatId === s.chatId
                                                  ? "bg-[#141414] text-white"
                                                  : "text-[#a3a3a3] hover:bg-[#181818]"
                                              }`}
                                            >
                                              {s.label}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => onDeleteChat(w.id, p.id, s)}
                                              title="Delete session"
                                              className="shrink-0 p-0.5 mr-1 text-[#525252] opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-white transition-opacity"
                                            >
                                              <X className="w-3 h-3" />
                                            </button>
                                          </div>
                                        ))}
                                        <button
                                          type="button"
                                          onClick={() => onNewChat(w.id, p.id)}
                                          className="w-full text-left pl-12 pr-2 py-2 md:py-0.5 font-mono text-[11px] text-[#737373] hover:bg-[#181818] hover:text-white transition-colors"
                                        >
                                          new chat
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                              {personas === undefined && (
                                <div className="pl-9 py-0.5 font-mono text-[11px] text-[#525252]">…</div>
                              )}
                              <button
                                type="button"
                                onClick={() => onNewPersona(w.id)}
                                className="w-full text-left pl-9 pr-2 py-2 md:py-1 font-mono text-[11px] text-[#737373] hover:bg-[#181818] hover:text-white transition-colors flex items-center gap-1"
                              >
                                <Plus className="w-3 h-3" /> persona
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      onClick={onNewWorkspace}
                      className="w-full text-left pl-6 pr-2 py-2 md:py-1 font-mono text-[11px] text-[#737373] hover:bg-[#181818] hover:text-white transition-colors flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" /> workspace
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 p-2 border-t border-[#262626]">
        <button
          type="button"
          onClick={onNewHost}
          className="w-full flex items-center justify-center space-x-1.5 px-2.5 py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] text-[#a3a3a3] hover:text-white rounded text-xs font-mono transition-colors"
        >
          <Radar className="w-3.5 h-3.5" />
          <span>Discover</span>
        </button>
      </div>
    </aside>
  );
};
