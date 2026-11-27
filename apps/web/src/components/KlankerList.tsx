import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Cloud, CopyPlus, GitBranch, Globe, Lock, PanelLeftClose, Pencil, Plus, Search, Settings2, WifiOff, X } from "lucide-react";
import { WorkspaceHosts, WorkspaceRow } from "../types/klanker";
import { KlankerMark } from "./KlankerMark";
import { wsSyncBadge, type WsBadge, type WsBadgeKind } from "../wsTree";
import { inputClass } from "./ui/inputClass";

export interface SessionRow {
  chatId: string;
  session: string;
  label: string;
  pending: boolean;
  host?: string;
  branch?: string;
  repo?: string;
  wip_unpushed?: boolean;
  last_active?: string;
}

export interface PersonaRow {
  id: string;
  name?: string;
  role?: string;
  unread?: number;
}

interface KlankerListProps {
  workspaces: WorkspaceRow[];
  wsHostsOf: (ws: string) => WorkspaceHosts | undefined;
  personasOf: (ws: string) => PersonaRow[] | undefined;
  sessionRowsOf: (ws: string, persona: string) => SessionRow[] | undefined;
  selWs: string;
  selPersona: string;
  openChatId: string | null;
  width: number;
  collapsed: boolean;
  onResize: (width: number) => void;
  onToggleCollapse: () => void;
  onExpandWs: (ws: string) => void;
  onExpandPersona: (ws: string, persona: string) => void;
  onSelectChat: (ws: string, persona: string, chatId: string) => void;
  onNewChat: (ws: string, persona: string) => void;
  onDeleteChat: (ws: string, persona: string, row: SessionRow) => void;
  onRenameChat?: (ws: string, persona: string, row: SessionRow, title: string) => void;
  onForkChat?: (ws: string, persona: string, row: SessionRow) => void;
  onNewWorkspace: () => void;
  onDeleteWorkspace: (ws: string) => void;
  onWorkspaceSettings: (ws: string) => void;
  onNewPersona: (ws: string) => void;
  onDeletePersona: (ws: string, persona: string) => void;
  onEditPersona?: (ws: string, persona: string) => void;
}

const badgeClass = (kind: WsBadgeKind): string => {
  const base = "shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 text-[9px]";
  if (kind === "hub") return `${base} text-ink-primary`;
  if (kind === "synced") return `${base} text-ink-secondary`;
  if (kind === "offline") return `${base} text-red-400`;
  return `${base} text-ink-dim`;
};

const SyncBadge: React.FC<{ badge: WsBadge }> = ({ badge }) => (
  <span className={badgeClass(badge.kind)} title={badge.tooltip} aria-label={badge.tooltip}>
    {badge.kind === "local" && <Lock className="w-2.5 h-2.5" />}
    {badge.kind === "synced" && <><Cloud className="w-2.5 h-2.5" />{badge.count > 0 && <span className="font-mono">{badge.count}</span>}</>}
    {badge.kind === "hub" && <Globe className="w-2.5 h-2.5" />}
    {badge.kind === "offline" && <WifiOff className="w-2.5 h-2.5" />}
  </span>
);

const match = (q: string, ...parts: (string | undefined)[]) => !q || parts.some((p) => (p || "").toLowerCase().includes(q));

/** Workspace-first sidebar (klanker#150/#171): searchable, resizable,
 *  collapsible navigation tree with workspace sync state, persona contacts,
 *  and rich session rows. */
export const KlankerList: React.FC<KlankerListProps> = (props) => {
  const {
    workspaces, wsHostsOf, personasOf, sessionRowsOf, selWs, selPersona, openChatId,
    width, collapsed, onResize, onToggleCollapse, onExpandWs, onExpandPersona, onSelectChat,
    onNewChat, onDeleteChat, onRenameChat, onForkChat, onNewWorkspace, onDeleteWorkspace,
    onWorkspaceSettings, onNewPersona, onDeletePersona, onEditPersona,
  } = props;
  const [openWs, setOpenWs] = useState<ReadonlySet<string>>(() => new Set(selWs ? [selWs] : []));
  const [openPersona, setOpenPersona] = useState<ReadonlySet<string>>(() => new Set(selWs && selPersona ? [`${selWs} ${selPersona}`] : []));
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState("");
  const [renameText, setRenameText] = useState("");
  const resizing = useRef(false);

  useEffect(() => {
    if (selWs) {
      onExpandWs(selWs);
      if (selPersona) onExpandPersona(selWs, selPersona);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevSelWs = useRef(selWs);
  useEffect(() => {
    if (selWs && selWs !== prevSelWs.current) {
      setOpenWs((prev) => (prev.has(selWs) ? prev : new Set(prev).add(selWs)));
      onExpandWs(selWs);
    }
    prevSelWs.current = selWs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selWs]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!resizing.current) return;
      onResize(Math.max(200, Math.min(420, e.clientX)));
    };
    const up = () => { resizing.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [onResize]);

  const q = query.trim().toLowerCase();
  const toggleWs = (ws: string) => {
    setOpenWs((prev) => {
      const next = new Set(prev);
      if (next.has(ws)) next.delete(ws);
      else { next.add(ws); onExpandWs(ws); }
      return next;
    });
  };
  const togglePersona = (ws: string, persona: string) => {
    const key = `${ws} ${persona}`;
    setOpenPersona((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else { next.add(key); onExpandPersona(ws, persona); }
      return next;
    });
  };
  const chevron = (open: boolean) => open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />;
  const overlay = "absolute right-1 top-1/2 -translate-y-1/2 flex items-center rounded-md bg-main/95 opacity-100 md:hidden md:group-hover:flex md:group-focus-within:flex";

  if (collapsed) return <aside data-testid="sidebar-collapsed" className="hidden md:block w-0 shrink-0 overflow-hidden" aria-hidden="true" />;

  const visibleWorkspaces = workspaces.filter((w) => {
    if (!q) return true;
    const personas = personasOf(w.id) || [];
    return match(q, w.label, w.id) || personas.some((p) =>
      match(q, p.name, p.id, p.role) || (sessionRowsOf(w.id, p.id) || []).some((s) => match(q, s.label, s.session, s.branch, s.repo, s.host))
    );
  });
  const firstWs = selWs || workspaces[0]?.id || "";
  const firstPersona = selPersona || (firstWs ? personasOf(firstWs)?.[0]?.id || "" : "");

  return (
    <aside data-testid="klanker-sidebar" style={{ "--sidebar-width": `${width}px` } as React.CSSProperties} className="relative h-full w-[80vw] max-w-72 md:w-[var(--sidebar-width)] md:min-w-[200px] md:max-w-[420px] shrink-0 flex flex-col border-r border-subtle bg-main select-none">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(e) => { resizing.current = true; e.preventDefault(); }}
        className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize md:block hover:bg-strong"
      />
      <div className="h-11 shrink-0 flex items-center justify-between px-3 border-b border-subtle font-mono text-xs font-semibold tracking-wider text-ink-primary">
        <span className="flex items-center min-w-0"><KlankerMark size={18} className="mr-2 shrink-0" />KLANKER</span>
        <button type="button" onClick={onToggleCollapse} title="Collapse sidebar (Ctrl/⌘ B)" aria-label="Collapse sidebar" className="hidden md:inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-dim hover:bg-hover hover:text-ink-primary">
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="border-b border-subtle p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-dim" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter workspaces and chats" aria-label="Filter sidebar" className={`${inputClass} pl-7 text-[11px]`} />
        </div>
        {firstWs && firstPersona && !q && (
          <button type="button" onClick={() => onNewChat(firstWs, firstPersona)} className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-subtle bg-elevated px-2 font-mono text-xs text-ink-primary transition-colors hover:border-strong hover:bg-hover">
            <Plus className="h-3 w-3" /> new chat
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">workspaces</span>
          <button type="button" onClick={onNewWorkspace} title="New workspace" aria-label="New workspace" className="inline-flex h-6 w-6 items-center justify-center text-ink-dim hover:text-ink-primary">
            <Plus className="w-3 h-3" />
          </button>
        </div>
        {visibleWorkspaces.length === 0 && <p className="px-3 py-2 text-ink-dim font-mono text-[11px]">{q ? "no matches" : "no workspaces yet — create one."}</p>}
        {visibleWorkspaces.map((w) => {
          const wsOpen = q ? true : openWs.has(w.id);
          const allPersonas = personasOf(w.id);
          const personas = (allPersonas || []).filter((p) =>
            !q || match(q, w.label, w.id, p.name, p.id, p.role) || (sessionRowsOf(w.id, p.id) || []).some((s) => match(q, s.label, s.session, s.branch, s.repo, s.host))
          );
          const badge = wsSyncBadge(w, wsHostsOf(w.id));
          return (
            <div key={w.id} className="group">
              <div className="relative flex items-center hover:bg-hover transition-colors">
                <button type="button" onClick={() => toggleWs(w.id)} className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-3 pr-2 py-1.5 flex items-center gap-1 font-mono text-[11px] ${selWs === w.id ? "text-ink-primary" : "text-ink-secondary"}`}>
                  {chevron(wsOpen)}<span className="truncate">{w.label || w.id}</span><SyncBadge badge={badge} />
                </button>
                <div className={overlay}>
                  <button type="button" onClick={() => onWorkspaceSettings(w.id)} title="Workspace settings" aria-label="Workspace settings" className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><Settings2 className="w-3 h-3" /></button>
                  <button type="button" onClick={() => onDeleteWorkspace(w.id)} title="Archive workspace" aria-label="Archive workspace" className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><X className="w-3 h-3" /></button>
                </div>
              </div>
              {wsOpen && (
                <div>
                  {personas.map((p) => {
                    const pKey = `${w.id} ${p.id}`;
                    const pOpen = q ? true : openPersona.has(pKey);
                    const allSessions = sessionRowsOf(w.id, p.id);
                    const sessions = (allSessions || []).filter((s) => !q || match(q, w.label, w.id, p.name, p.id, s.label, s.session, s.branch, s.repo, s.host));
                    return (
                      <div key={p.id} className="group/persona">
                        <div className="relative flex items-center hover:bg-hover transition-colors">
                          <button type="button" onClick={() => togglePersona(w.id, p.id)} className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-6 pr-2 py-1.5 flex items-center gap-1 font-mono text-[11px] ${selPersona === p.id && selWs === w.id ? "text-ink-primary" : "text-ink-secondary"}`}>
                            {chevron(pOpen)}<span className="truncate">{p.name || p.id}</span>
                            {p.role && <span className="shrink-0 text-[9px] uppercase tracking-wider text-ink-dim">{p.role}</span>}
                          </button>
                          {(p.unread ?? 0) > 0 && <span className="shrink-0 min-w-4 px-1 text-center rounded-full bg-accent text-accent-ink text-[9px] font-mono" title="open/running handoffs">{p.unread}</span>}
                          <div className={overlay.replace("group-hover", "group-hover/persona").replace("group-focus-within", "group-focus-within/persona")}>
                            {onEditPersona && <button type="button" onClick={() => onEditPersona(w.id, p.id)} title="Edit persona" aria-label={`Edit persona ${p.name || p.id}`} className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><Pencil className="w-3 h-3" /></button>}
                            <button type="button" onClick={() => onDeletePersona(w.id, p.id)} title="Archive persona" aria-label="Archive persona" className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><X className="w-3 h-3" /></button>
                          </div>
                        </div>
                        {pOpen && (
                          <div>
                            <button type="button" onClick={() => onNewChat(w.id, p.id)} className="min-h-11 md:min-h-8 w-full text-left pl-9 pr-2 py-1.5 font-mono text-[11px] text-ink-muted hover:bg-hover hover:text-ink-primary">new chat</button>
                            {sessions.map((s) => {
                              const chatSelected = openChatId === s.chatId;
                              const rowKey = `${w.id}:${p.id}:${s.chatId}`;
                              return (
                                <div key={s.chatId} className={`group/session relative flex items-center ${chatSelected ? "bg-elevated" : "hover:bg-hover"}`}>
                                  {renaming === rowKey ? (
                                    <form className="flex flex-1 items-center gap-1 py-1 pl-9 pr-1" onSubmit={(e) => { e.preventDefault(); onRenameChat?.(w.id, p.id, s, renameText.trim()); setRenaming(""); }}>
                                      <input autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)} aria-label="Rename chat" className="min-w-0 flex-1 rounded border border-subtle hover:border-strong focus:border-strong bg-elevated px-1 py-0.5 font-mono text-[11px] text-ink-primary outline-none" />
                                      <button type="submit" aria-label="Save chat title" className="text-ink-dim hover:text-ink-primary"><Check className="h-3 w-3" /></button>
                                    </form>
                                  ) : (
                                    <button type="button" onClick={() => onSelectChat(w.id, p.id, s.chatId)} title={s.session} className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-9 pr-1 py-1.5 font-mono text-[11px] flex flex-col justify-center gap-0.5 ${chatSelected ? "text-ink-primary" : "text-ink-secondary"}`}>
                                      <span className="flex min-w-0 items-center gap-1">
                                        <span className="truncate">{s.label}</span>
                                        {s.host && <span className="shrink-0 max-w-[72px] truncate px-1 py-0.5 rounded-full border border-subtle text-[8px] uppercase tracking-wider text-ink-muted" title={`bound host: ${s.host}`}>@{s.host}</span>}
                                        {s.wip_unpushed && <span className="shrink-0 rounded-full bg-accent px-1 text-[8px] uppercase text-accent-ink" title="unpushed work">wip</span>}
                                      </span>
                                      {(s.branch || s.repo) && <span className="flex min-w-0 items-center gap-1 text-[9px] text-ink-dim"><GitBranch className="h-2.5 w-2.5 shrink-0" /><span className="truncate">{s.branch || "no branch"}{s.repo ? ` · ${s.repo.split("/").pop()}` : ""}</span></span>}
                                    </button>
                                  )}
                                  <div className={overlay.replace("group-hover", "group-hover/session").replace("group-focus-within", "group-focus-within/session")}>
                                    {onRenameChat && <button type="button" onClick={() => { setRenaming(rowKey); setRenameText(s.label); }} title="Rename chat" aria-label="Rename chat" className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><Pencil className="w-3 h-3" /></button>}
                                    {onForkChat && <button type="button" onClick={() => onForkChat(w.id, p.id, s)} title="Fork chat" aria-label="Fork chat" className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><CopyPlus className="w-3 h-3" /></button>}
                                    <button type="button" onClick={() => onDeleteChat(w.id, p.id, s)} title="Delete session" aria-label="Delete session" className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><X className="w-3 h-3" /></button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {allPersonas === undefined && <div className="pl-6 py-0.5 font-mono text-[11px] text-ink-dim">…</div>}
                  {!q && <button type="button" onClick={() => onNewPersona(w.id)} className="flex min-h-11 md:min-h-8 w-full items-center gap-1 text-left pl-6 pr-2 py-1.5 font-mono text-[11px] text-ink-muted hover:bg-hover hover:text-ink-primary"><Plus className="w-3 h-3" /> persona</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
};
