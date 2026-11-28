import React, { useEffect, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  CopyPlus,
  Download,
  FileJson,
  GitBranch,
  Globe,
  Lock,
  Pencil,
  Plus,
  Search,
  Settings2,
  Share2,
  WifiOff,
  X,
} from "lucide-react";
import { WorkspaceHosts, WorkspaceRow } from "../types/klanker";
import { KlankerMark } from "./KlankerMark";
import { wsSyncBadge, type WsBadge, type WsBadgeKind } from "../wsTree";
import { inputClass } from "./ui/inputClass";
import { useContextMenu, type ContextMenuItem } from "./ui/ContextMenu";

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

export interface SessionFocusTarget {
  nonce: number;
  ws: string;
  persona: string;
  id: string;
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
  onPrefetchSession?: (ws: string, persona: string, session: string) => void;
  onForkChat?: (ws: string, persona: string, row: SessionRow) => void;
  onExportChat?: (ws: string, persona: string, row: SessionRow, format: "md" | "json") => void;
  onCopySessionId?: (ws: string, persona: string, row: SessionRow) => void;
  onNewWorkspace: () => void;
  onDeleteWorkspace: (ws: string) => void;
  onWorkspaceSettings: (ws: string) => void;
  onWorkspaceShare?: (ws: string) => void;
  onNewPersona: (ws: string) => void;
  onDeletePersona: (ws: string, persona: string) => void;
  onEditPersona?: (ws: string, persona: string) => void;
  onSelectWorkspace?: (ws: string) => void;
  onOpenPalette?: () => void;
  onOpenSettings?: () => void;
  focusSession?: SessionFocusTarget | null;
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
const iconClass = "h-3 w-3";

/** Workspace-first sidebar: searchable/resizable tree on desktop, mobile
 *  drawer, and a silky 52px monochrome icon rail when collapsed. */
export const KlankerList: React.FC<KlankerListProps> = (props) => {
  const {
    workspaces, wsHostsOf, personasOf, sessionRowsOf, selWs, selPersona, openChatId,
    width, collapsed, onResize, onToggleCollapse, onExpandWs, onExpandPersona, onSelectChat,
    onNewChat, onDeleteChat, onRenameChat, onPrefetchSession, onForkChat, onExportChat, onCopySessionId,
    onNewWorkspace, onDeleteWorkspace, onWorkspaceSettings, onWorkspaceShare, onNewPersona,
    onDeletePersona, onEditPersona, onSelectWorkspace, onOpenPalette, focusSession,
  } = props;
  const [openWs, setOpenWs] = useState<ReadonlySet<string>>(() => new Set(selWs ? [selWs] : []));
  const [openPersona, setOpenPersona] = useState<ReadonlySet<string>>(() => new Set(selWs && selPersona ? [`${selWs} ${selPersona}`] : []));
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState("");
  const [renameText, setRenameText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [highlightRow, setHighlightRow] = useState("");
  const resizing = useRef(false);
  const expandWsRef = useRef(onExpandWs);
  const expandPersonaRef = useRef(onExpandPersona);
  expandWsRef.current = onExpandWs;
  expandPersonaRef.current = onExpandPersona;
  const { openMenu } = useContextMenu();

  useEffect(() => {
    if (selWs) {
      setOpenWs((prev) => (prev.has(selWs) ? prev : new Set(prev).add(selWs)));
      expandWsRef.current(selWs);
      if (selPersona) {
        const key = `${selWs} ${selPersona}`;
        setOpenPersona((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
        expandPersonaRef.current(selWs, selPersona);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevSelection = useRef({ ws: selWs, persona: selPersona });
  useEffect(() => {
    const prev = prevSelection.current;
    if (selWs && selWs !== prev.ws) {
      setOpenWs((cur) => (cur.has(selWs) ? cur : new Set(cur).add(selWs)));
      expandWsRef.current(selWs);
    }
    if (selWs && selPersona && (selWs !== prev.ws || selPersona !== prev.persona)) {
      const key = `${selWs} ${selPersona}`;
      setOpenPersona((cur) => (cur.has(key) ? cur : new Set(cur).add(key)));
      expandPersonaRef.current(selWs, selPersona);
    }
    prevSelection.current = { ws: selWs, persona: selPersona };
  }, [selWs, selPersona]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!resizing.current) return;
      onResize(Math.max(208, Math.min(420, e.clientX)));
    };
    const up = () => {
      resizing.current = false;
      setIsDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [onResize]);

  useEffect(() => {
    if (!focusSession) return;
    setOpenWs((cur) => (cur.has(focusSession.ws) ? cur : new Set(cur).add(focusSession.ws)));
    const personaKey = `${focusSession.ws} ${focusSession.persona}`;
    setOpenPersona((cur) => (cur.has(personaKey) ? cur : new Set(cur).add(personaKey)));
    expandWsRef.current(focusSession.ws);
    expandPersonaRef.current(focusSession.ws, focusSession.persona);
    const started = Date.now();
    let clearRing = 0;
    const poll = window.setInterval(() => {
      const hit = Array.from(document.querySelectorAll<HTMLElement>("[data-session-row]")).find((el) =>
        el.dataset.ws === focusSession.ws &&
        el.dataset.persona === focusSession.persona &&
        (el.dataset.session === focusSession.id || el.dataset.chat === focusSession.id)
      );
      if (hit) {
        window.clearInterval(poll);
        if (typeof hit.scrollIntoView === "function") hit.scrollIntoView({ behavior: "smooth", block: "nearest" });
        const rowKey = hit.dataset.rowKey || "";
        setHighlightRow(rowKey);
        clearRing = window.setTimeout(() => setHighlightRow(""), 1800);
      } else if (Date.now() - started > 1800) {
        window.clearInterval(poll);
      }
    }, 80);
    return () => {
      window.clearInterval(poll);
      if (clearRing) window.clearTimeout(clearRing);
    };
  }, [focusSession]);

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

  const visibleWorkspaces = workspaces.filter((w) => {
    if (!q) return true;
    const personas = personasOf(w.id) || [];
    return match(q, w.label, w.id) || personas.some((p) =>
      match(q, p.name, p.id, p.role) || (sessionRowsOf(w.id, p.id) || []).some((s) => match(q, s.label, s.session, s.branch, s.repo, s.host))
    );
  });
  const firstWs = selWs || workspaces[0]?.id || "";
  const firstPersona = selPersona || (firstWs ? personasOf(firstWs)?.[0]?.id || "" : "");
  const personaFor = (ws: string) => (ws === selWs && selPersona ? selPersona : personasOf(ws)?.[0]?.id || "default");

  const startRename = (ws: string, persona: string, row: SessionRow) => {
    if (!onRenameChat) return;
    setRenaming(`${ws}:${persona}:${row.chatId}`);
    setRenameText(row.label);
  };

  const prefetchTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (prefetchTimer.current !== null) window.clearTimeout(prefetchTimer.current);
  }, []);
  const schedulePrefetch = (ws: string, persona: string, row: SessionRow, immediate = false) => {
    if (!onPrefetchSession || !row.session || row.chatId === openChatId) return;
    if (prefetchTimer.current !== null) window.clearTimeout(prefetchTimer.current);
    if (immediate) {
      onPrefetchSession(ws, persona, row.session);
      return;
    }
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null;
      onPrefetchSession(ws, persona, row.session);
    }, 120);
  };

  const workspaceMenuItems = (w: WorkspaceRow): ContextMenuItem[] => [
    { id: "new-chat", label: "New chat", icon: <Plus className={iconClass} />, onSelect: () => onNewChat(w.id, personaFor(w.id)) },
    { id: "new-persona", label: "New persona", icon: <Plus className={iconClass} />, onSelect: () => onNewPersona(w.id) },
    { id: "workspace-settings", label: "Workspace settings", icon: <Settings2 className={iconClass} />, onSelect: () => onWorkspaceSettings(w.id) },
    { id: "share-invite", label: "Share / Invite", icon: <Share2 className={iconClass} />, disabled: !onWorkspaceShare, onSelect: () => onWorkspaceShare?.(w.id) },
    { id: "workspace-separator", separator: true },
    { id: "archive-workspace", label: "Archive workspace", icon: <Archive className={iconClass} />, danger: true, onSelect: () => onDeleteWorkspace(w.id) },
  ];

  const personaMenuItems = (ws: string, persona: PersonaRow): ContextMenuItem[] => [
    { id: "new-chat", label: "New chat", icon: <Plus className={iconClass} />, onSelect: () => onNewChat(ws, persona.id) },
    { id: "edit-persona", label: "Edit persona", icon: <Pencil className={iconClass} />, disabled: !onEditPersona, onSelect: () => onEditPersona?.(ws, persona.id) },
    { id: "persona-separator", separator: true },
    { id: "archive-persona", label: "Archive persona", icon: <Archive className={iconClass} />, danger: true, onSelect: () => onDeletePersona(ws, persona.id) },
  ];

  const sessionMenuItems = (ws: string, persona: string, row: SessionRow): ContextMenuItem[] => [
    { id: "open-chat", label: "Open chat", icon: <ChevronRight className={iconClass} />, onSelect: () => onSelectChat(ws, persona, row.chatId) },
    { id: "rename-inline", label: "Rename inline", icon: <Pencil className={iconClass} />, disabled: !onRenameChat, onSelect: () => startRename(ws, persona, row) },
    { id: "fork-session", label: "Fork session", icon: <CopyPlus className={iconClass} />, disabled: !onForkChat, onSelect: () => onForkChat?.(ws, persona, row) },
    { id: "export-markdown", label: "Export Markdown", icon: <Download className={iconClass} />, disabled: !onExportChat, onSelect: () => onExportChat?.(ws, persona, row, "md") },
    { id: "export-json", label: "Export JSON", icon: <FileJson className={iconClass} />, disabled: !onExportChat, onSelect: () => onExportChat?.(ws, persona, row, "json") },
    { id: "copy-session-id", label: "Copy Session ID", icon: <Copy className={iconClass} />, disabled: !onCopySessionId, onSelect: () => onCopySessionId?.(ws, persona, row) },
    { id: "session-separator", separator: true },
    { id: "delete-chat", label: "Delete chat", icon: <X className={iconClass} />, danger: true, onSelect: () => onDeleteChat(ws, persona, row) },
  ];

  const widthClasses = collapsed
    ? "md:w-[52px] md:min-w-[52px] md:max-w-[52px]"
    : "md:w-[var(--sidebar-width)] md:min-w-[208px] md:max-w-[420px]";
  const railButton = "inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-hover hover:text-ink-primary";

  return (
    <aside
      data-testid={collapsed ? "sidebar-collapsed" : "klanker-sidebar"}
      data-collapsed={collapsed ? "true" : "false"}
      aria-label="Workspace navigation"
      style={{
        "--sidebar-width": `${width}px`,
        transition: isDragging ? "none" : "width 0.34s cubic-bezier(0.22, 1, 0.36, 1), min-width 0.34s cubic-bezier(0.22, 1, 0.36, 1), max-width 0.34s cubic-bezier(0.22, 1, 0.36, 1)",
      } as React.CSSProperties}
      className={`sidebar-shell-motion relative h-full w-[80vw] max-w-72 ${widthClasses} shrink-0 flex flex-col border-r border-subtle bg-main select-none overflow-hidden`}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(e) => {
          resizing.current = true;
          setIsDragging(true);
          e.preventDefault();
        }}
        className={`absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize md:block hover:bg-strong ${collapsed ? "md:hidden" : ""}`}
      />

      <div className="sidebar-expanded-choreo flex h-full min-h-0 flex-col">
        <div className="h-11 shrink-0 flex items-center px-3 border-b border-subtle font-mono text-xs font-semibold tracking-wider text-ink-primary">
          <button type="button" onClick={onToggleCollapse} title="Collapse sidebar (Ctrl/⌘ B)" aria-label="Collapse sidebar" className="flex min-w-0 items-center rounded-md px-1.5 py-1 -ml-1.5 transition-colors hover:bg-hover hover:opacity-80">
            <KlankerMark size={18} className="mr-2 shrink-0" /><span className="sidebar-label-choreo">KLANKER</span>
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
              <div key={w.id} className="group" onContextMenu={(e) => openMenu(e, workspaceMenuItems(w))}>
                <div className="relative flex items-center hover:bg-hover transition-colors">
                  <button type="button" onClick={() => toggleWs(w.id)} className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-3 pr-2 py-1.5 flex items-center gap-1 font-mono text-[11px] ${selWs === w.id ? "text-ink-primary" : "text-ink-secondary"}`}>
                    {chevron(wsOpen)}<span className="sidebar-label-choreo truncate">{w.label || w.id}</span><SyncBadge badge={badge} />
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
                        <div key={p.id} className="group/persona" onContextMenu={(e) => openMenu(e, personaMenuItems(w.id, p))}>
                          <div className="relative flex items-center hover:bg-hover transition-colors">
                            <button type="button" onClick={() => togglePersona(w.id, p.id)} className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-6 pr-2 py-1.5 flex items-center gap-1 font-mono text-[11px] ${selPersona === p.id && selWs === w.id ? "text-ink-primary" : "text-ink-secondary"}`}>
                              {chevron(pOpen)}<span className="sidebar-label-choreo truncate">{p.name || p.id}</span>
                              {p.role && <span className="sidebar-label-choreo shrink-0 text-[9px] uppercase tracking-wider text-ink-dim">{p.role}</span>}
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
                                const highlighted = highlightRow === rowKey;
                                return (
                                  <div
                                    key={s.chatId}
                                    data-session-row="true"
                                    data-row-key={rowKey}
                                    data-ws={w.id}
                                    data-persona={p.id}
                                    data-session={s.session}
                                    data-chat={s.chatId}
                                    onContextMenu={(e) => openMenu(e, sessionMenuItems(w.id, p.id, s))}
                                    onPointerEnter={() => schedulePrefetch(w.id, p.id, s)}
                                    onPointerDown={() => schedulePrefetch(w.id, p.id, s, true)}
                                    onFocus={() => schedulePrefetch(w.id, p.id, s)}
                                    className={`group/session relative flex items-center transition-shadow ${chatSelected ? "bg-elevated" : "hover:bg-hover"} ${highlighted ? "ring-1 ring-accent/60" : ""}`}
                                  >
                                    {renaming === rowKey ? (
                                      <form className="flex min-h-11 flex-1 items-center gap-1 py-1.5 pl-9 pr-1 font-mono text-[11px] leading-normal md:min-h-8" data-testid="rename-session-form" onSubmit={(e) => { e.preventDefault(); onRenameChat?.(w.id, p.id, s, renameText.trim()); setRenaming(""); }}>
                                        <input autoFocus value={renameText} onChange={(e) => setRenameText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setRenameText(s.label); setRenaming(""); } }} aria-label="Rename chat" className="min-w-0 flex-1 appearance-none border-0 border-b border-strong bg-transparent px-0 py-0 font-mono text-[11px] leading-normal text-ink-primary outline-none" />
                                        <button type="submit" aria-label="Save chat title" className="inline-flex h-5 w-5 items-center justify-center text-ink-dim hover:text-ink-primary"><Check className="h-3 w-3" /></button>
                                      </form>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => onSelectChat(w.id, p.id, s.chatId)}
                                        onDoubleClick={() => startRename(w.id, p.id, s)}
                                        title={s.session}
                                        className={`flex-1 min-w-0 min-h-11 md:min-h-8 text-left pl-9 pr-1 py-1.5 font-mono text-[11px] flex flex-col justify-center gap-0.5 ${chatSelected ? "text-ink-primary" : "text-ink-secondary"}`}
                                      >
                                        <span className="flex min-w-0 items-center gap-1">
                                          <span className="sidebar-label-choreo truncate">{s.label}</span>
                                          {s.host && <span className="shrink-0 max-w-[72px] truncate px-1 py-0.5 rounded-full border border-subtle text-[8px] uppercase tracking-wider text-ink-muted" title={`bound host: ${s.host}`}>@{s.host}</span>}
                                          {s.wip_unpushed && <span className="shrink-0 rounded-full bg-accent px-1 text-[8px] uppercase text-accent-ink" title="unpushed work">wip</span>}
                                        </span>
                                        {(s.branch || s.repo) && <span className="sidebar-label-choreo flex min-w-0 items-center gap-1 text-[9px] text-ink-dim"><GitBranch className="h-2.5 w-2.5 shrink-0" /><span className="truncate">{s.branch || "no branch"}{s.repo ? ` · ${s.repo.split("/").pop()}` : ""}</span></span>}
                                      </button>
                                    )}
                                    <div className={overlay.replace("group-hover", "group-hover/session").replace("group-focus-within", "group-focus-within/session")}>
                                      {onRenameChat && <button type="button" onClick={() => startRename(w.id, p.id, s)} title="Rename chat" aria-label="Rename chat" className="inline-flex h-8 w-8 items-center justify-center text-ink-dim hover:text-ink-primary"><Pencil className="w-3 h-3" /></button>}
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
      </div>

      <div className="sidebar-icon-rail absolute inset-0 z-10 hidden md:flex flex-col items-center bg-main py-2" data-testid="sidebar-icon-rail" aria-label="Collapsed workspace navigation">
        <div className="flex flex-col items-center gap-2">
          <button type="button" onClick={onToggleCollapse} title="Expand sidebar (Ctrl/⌘ B)" aria-label="Expand sidebar" className={railButton}>
            <KlankerMark size={20} />
          </button>
          <button type="button" onClick={() => onOpenPalette?.()} title="Search (⌘K)" aria-label="Search" className={railButton}>
            <Search className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => firstWs && firstPersona && onNewChat(firstWs, firstPersona)} title="New chat (+)" aria-label="New chat" className={railButton}>
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="my-2.5 h-px w-6 bg-subtle" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2.5 overflow-y-auto no-scrollbar">
          {workspaces.map((w) => {
            const label = w.label || w.id;
            const active = selWs === w.id;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => onSelectWorkspace?.(w.id)}
                onContextMenu={(e) => openMenu(e, workspaceMenuItems(w))}
                title={label}
                aria-label={`Workspace ${label}`}
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border font-mono text-[11px] font-semibold transition-colors ${active ? "border-accent bg-accent text-accent-ink" : "border-subtle bg-surface text-ink-secondary hover:border-strong hover:bg-hover hover:text-ink-primary"}`}
              >
                {(label.trim()[0] || "?").toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
