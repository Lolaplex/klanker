import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Cloud, Globe, Lock, Plus, Settings2, WifiOff, X } from "lucide-react";
import { WorkspaceHosts, WorkspaceRow } from "../types/klanker";
import { KlankerMark } from "./KlankerMark";
import { wsSyncBadge, type WsBadge, type WsBadgeKind } from "../wsTree";

export interface SessionRow {
  chatId: string;
  session: string;
  label: string;
  pending: boolean;
  /** Bound/executing host label — session:host binding or live lease. */
  host?: string;
}

export interface PersonaRow {
  id: string;
  name?: string;
  /** Manifest role (persona.json) — the contact's function. */
  role?: string;
  /** Open + running handoffs for this contact (ws inbox feed). */
  unread?: number;
}

interface KlankerListProps {
  /** Top-level rows — local + synced + shared workspaces fronted by the
   *  serving relay, deduped to one row per id (klanker#150). */
  workspaces: WorkspaceRow[];
  wsHostsOf: (ws: string) => WorkspaceHosts | undefined;
  personasOf: (ws: string) => PersonaRow[] | undefined;
  sessionRowsOf: (ws: string, persona: string) => SessionRow[] | undefined;
  selWs: string;
  selPersona: string;
  openChatId: string | null;
  onExpandWs: (ws: string) => void;
  onExpandPersona: (ws: string, persona: string) => void;
  onSelectChat: (ws: string, persona: string, chatId: string) => void;
  onNewChat: (ws: string, persona: string) => void;
  onDeleteChat: (ws: string, persona: string, row: SessionRow) => void;
  onNewWorkspace: () => void;
  onDeleteWorkspace: (ws: string) => void;
  onWorkspaceSettings: (ws: string) => void;
  onNewPersona: (ws: string) => void;
  onDeletePersona: (ws: string, persona: string) => void;
}

const badgeClass = (kind: WsBadgeKind): string => {
  const base = "shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px]";
  switch (kind) {
    case "hub":
      return `${base} text-white`;
    case "synced":
      return `${base} text-[#a3a3a3]`;
    case "offline":
      return `${base} text-red-400`;
    default:
      return `${base} text-[#525252]`;
  }
};

/** Compact sync badge — icon + optional member count, words live only in
 *  the tooltip (klanker#158 U03: a multi-word pill stole up to 88px of
 *  flex flow and crushed workspace titles to 0px). */
const SyncBadge: React.FC<{ badge: WsBadge }> = ({ badge }) => (
  <span className={badgeClass(badge.kind)} title={badge.tooltip} aria-label={badge.tooltip}>
    {badge.kind === "local" && <Lock className="w-2.5 h-2.5" />}
    {badge.kind === "synced" && (
      <>
        <Cloud className="w-2.5 h-2.5" />
        {badge.count > 0 && <span className="font-mono">{badge.count}</span>}
      </>
    )}
    {badge.kind === "hub" && <Globe className="w-2.5 h-2.5" />}
    {badge.kind === "offline" && <WifiOff className="w-2.5 h-2.5" />}
  </span>
);

/**
 * Workspace-first sidebar (klanker#150): Workspaces at root with a sync
 * badge + share/settings action, expanding to Personas (contacts: role +
 * handoff count) and then Chats/Sessions (title + bound-host pill).
 * Devices/hosts live in the DevicesPanel — never as tree roots.
 */
export const KlankerList: React.FC<KlankerListProps> = ({
  workspaces,
  wsHostsOf,
  personasOf,
  sessionRowsOf,
  selWs,
  selPersona,
  openChatId,
  onExpandWs,
  onExpandPersona,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onNewWorkspace,
  onDeleteWorkspace,
  onWorkspaceSettings,
  onNewPersona,
  onDeletePersona,
}) => {
  const [openWs, setOpenWs] = useState<ReadonlySet<string>>(() => new Set(selWs ? [selWs] : []));
  const [openPersona, setOpenPersona] = useState<ReadonlySet<string>>(
    () => new Set(selWs && selPersona ? [`${selWs} ${selPersona}`] : [])
  );
  // Expand the saved selection once so the tree opens where the user left it.
  useEffect(() => {
    if (selWs) {
      onExpandWs(selWs);
      if (selPersona) onExpandPersona(selWs, selPersona);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A freshly created workspace becomes the selection before its rows
  // load — expand it automatically so the tree follows the create flow
  // instead of leaving the new row collapsed (klanker#158 U03).
  const prevSelWs = useRef(selWs);
  useEffect(() => {
    if (selWs && selWs !== prevSelWs.current) {
      setOpenWs((prev) => (prev.has(selWs) ? prev : new Set(prev).add(selWs)));
      onExpandWs(selWs);
    }
    prevSelWs.current = selWs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selWs]);

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
    <aside className="h-full w-[80vw] max-w-72 md:w-60 shrink-0 flex flex-col border-r border-[#262626] bg-[#000000] select-none">
      <div className="h-12 shrink-0 flex items-center px-3 border-b border-[#262626] font-mono text-xs font-semibold tracking-wider text-white">
        <KlankerMark size={20} className="mr-2 shrink-0" />
        <span>KLANKER</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-[#525252]">workspaces</span>
          <button
            type="button"
            onClick={onNewWorkspace}
            title="New workspace"
            aria-label="New workspace"
            className="inline-flex h-6 w-6 items-center justify-center text-[#525252] hover:text-white transition-colors"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        {workspaces.length === 0 && (
          <p className="px-3 py-2 text-[#525252] font-mono text-[11px]">no workspaces yet — create one.</p>
        )}
        {workspaces.map((w) => {
          const wsOpen = openWs.has(w.id);
          const personas = personasOf(w.id);
          const badge = wsSyncBadge(w, wsHostsOf(w.id));
          return (
            <div key={w.id} className="group">
              {/* Action buttons ride an absolute overlay: 0px reserved in
                  flex flow when not hovered, so the title keeps the full
                  row width (klanker#158 U03). Touch keeps them visible. */}
              <div className="relative flex items-center hover:bg-[#181818] transition-colors">
                <button
                  type="button"
                  onClick={() => toggleWs(w.id)}
                  className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-3 pr-2 py-1.5 flex items-center gap-1 font-mono text-[11px] transition-colors ${
                    selWs === w.id ? "text-white" : "text-[#a3a3a3]"
                  }`}
                >
                  {chevron(wsOpen)}
                  <span className="truncate">{w.label || w.id}</span>
                  <SyncBadge badge={badge} />
                </button>
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center rounded bg-black/85 opacity-100 md:hidden md:group-hover:flex md:group-focus-within:flex">
                  <button
                    type="button"
                    onClick={() => onWorkspaceSettings(w.id)}
                    title="Share / workspace settings"
                    aria-label="Workspace settings"
                    className="inline-flex h-8 w-8 items-center justify-center text-[#525252] hover:text-white transition-colors"
                  >
                    <Settings2 className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteWorkspace(w.id)}
                    title="Archive workspace"
                    aria-label="Archive workspace"
                    className="inline-flex h-8 w-8 items-center justify-center text-[#525252] hover:text-white transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </div>
              {wsOpen && (
                <div>
                  {(personas ?? []).map((p) => {
                    const pKey = `${w.id} ${p.id}`;
                    const pOpen = openPersona.has(pKey);
                    const sessions = sessionRowsOf(w.id, p.id);
                    return (
                      <div key={p.id} className="group/persona">
                        <div className="relative flex items-center hover:bg-[#181818] transition-colors">
                          <button
                            type="button"
                            onClick={() => togglePersona(w.id, p.id)}
                            className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-6 pr-2 py-1.5 flex items-center gap-1 font-mono text-[11px] transition-colors ${
                              selPersona === p.id && selWs === w.id ? "text-white" : "text-[#a3a3a3]"
                            }`}
                          >
                            {chevron(pOpen)}
                            <span className="truncate">{p.name || p.id}</span>
                            {p.role && (
                              <span className="shrink-0 text-[9px] uppercase tracking-wider text-[#525252]">
                                {p.role}
                              </span>
                            )}
                          </button>
                          {(p.unread ?? 0) > 0 && (
                            <span
                              className="shrink-0 min-w-4 px-1 text-center rounded-full bg-white text-black text-[9px] font-mono"
                              title="open/running handoffs"
                            >
                              {p.unread}
                            </span>
                          )}
                          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center rounded bg-black/85 opacity-100 md:hidden md:group-hover/persona:flex md:group-focus-within/persona:flex">
                            <button
                              type="button"
                              onClick={() => onDeletePersona(w.id, p.id)}
                              title="Archive persona"
                              aria-label="Archive persona"
                              className="inline-flex h-8 w-8 items-center justify-center text-[#525252] hover:text-white transition-colors"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        {pOpen && (
                          <div>
                            <button
                              type="button"
                              onClick={() => onNewChat(w.id, p.id)}
                              className="min-h-11 md:min-h-8 w-full text-left pl-9 pr-2 py-1.5 font-mono text-[11px] text-[#737373] hover:bg-[#181818] hover:text-white transition-colors"
                            >
                              new chat
                            </button>
                            {(sessions ?? []).map((s) => {
                              const chatSelected = openChatId === s.chatId;
                              return (
                                <div
                                  key={s.chatId}
                                  className={`group relative flex items-center transition-colors ${
                                    chatSelected ? "bg-[#141414]" : "hover:bg-[#181818]"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => onSelectChat(w.id, p.id, s.chatId)}
                                    title={s.session}
                                    className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-9 pr-1 py-1.5 font-mono text-[11px] flex items-center gap-1 transition-colors ${
                                      chatSelected ? "text-white" : "text-[#a3a3a3]"
                                    }`}
                                  >
                                    <span className="truncate">{s.label}</span>
                                    {s.host && (
                                      <span
                                        className="shrink-0 max-w-[76px] truncate px-1.5 py-0.5 rounded-full border border-[#262626] text-[9px] uppercase tracking-wider text-[#737373]"
                                        title={`bound host: ${s.host}`}
                                      >
                                        @{s.host}
                                      </span>
                                    )}
                                  </button>
                                  <div
                                    className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center rounded bg-black/85 opacity-100 md:hidden md:group-hover:flex md:group-focus-within:flex`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => onDeleteChat(w.id, p.id, s)}
                                      title="Delete session"
                                      aria-label="Delete session"
                                      className={`inline-flex h-8 w-8 items-center justify-center hover:text-white transition-colors ${
                                        chatSelected ? "text-[#a3a3a3]" : "text-[#525252]"
                                      }`}
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {personas === undefined && (
                    <div className="pl-6 py-0.5 font-mono text-[11px] text-[#525252]">…</div>
                  )}
                  <button
                    type="button"
                    onClick={() => onNewPersona(w.id)}
                    className="flex min-h-11 md:min-h-8 w-full items-center gap-1 text-left pl-6 pr-2 py-1.5 font-mono text-[11px] text-[#737373] hover:bg-[#181818] hover:text-white transition-colors"
                  >
                    <Plus className="w-3 h-3" /> persona
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
};
