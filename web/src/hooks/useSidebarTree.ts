import { useEffect, useRef, useState } from "react";
import type { ChatMessage, KlankerInstance, ProcessStatus } from "../types/klanker";
import { api } from "../services/api";
import type { PersonaRow, SessionRow } from "../components/KlankerList";
import { ChatBucket, clipTitle } from "../chatBuckets";
import { eventsToMessages } from "../chatSync";

/**
 * Sidebar workspace/persona/session tree: workspace list for the active
 * instance, lazy persona + session loaders, prefetch of session titles, and
 * the row mappers KlankerList renders.
 */
export function useSidebarTree(args: {
  activeInstance: KlankerInstance | null;
  status: ProcessStatus | null;
  chats: Record<string, ChatBucket>;
  setSelWs: React.Dispatch<React.SetStateAction<string>>;
  setWsNote: (note: string | null) => void;
  evCache: React.MutableRefObject<Map<string, ChatMessage[]>>;
  onResetApprovals: () => void;
}): {
  workspaces: { id: string; label?: string }[];
  setWorkspaces: (rows: { id: string; label?: string }[]) => void;
  treePersonas: Record<string, PersonaRow[]>;
  setTreePersonas: React.Dispatch<React.SetStateAction<Record<string, PersonaRow[]>>>;
  serverSessions: Record<string, { id: string; goal?: string; title?: string }[]>;
  setServerSessions: React.Dispatch<React.SetStateAction<Record<string, { id: string; goal?: string; title?: string }[]>>>;
  sessionTitles: Record<string, string>;
  setSessionTitles: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  expandWs: (ws: string) => void;
  expandPersona: (ws: string, persona: string) => void;
  personasOf: (ws: string) => PersonaRow[] | undefined;
  sessionRowsOf: (ws: string, persona: string) => SessionRow[] | undefined;
} {
  const { activeInstance, status, chats, setSelWs, setWsNote, evCache, onResetApprovals } = args;
  const [workspaces, setWorkspaces] = useState<{ id: string; label?: string }[]>([]);
  const [treePersonas, setTreePersonas] = useState<Record<string, PersonaRow[]>>({});
  const [serverSessions, setServerSessions] = useState<Record<string, { id: string; goal?: string; title?: string }[]>>({});
  // Session titles keyed "inst ws persona session": prefetched eagerly, cached in localStorage.
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("klanker.titles") || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const titleFetches = useRef(new Set<string>());
  const instId = activeInstance?.id;

  const expandWs = (ws: string) => {
    const inst = activeInstance;
    if (!inst || treePersonas[ws]) return;
    void api
      .listPersonas(inst, ws)
      .then((rows) => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: rows })))
      .catch(() => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: [] })));
  };
  const expandWsRef = useRef(expandWs);
  expandWsRef.current = expandWs;

  // Workspace list for the active instance
  useEffect(() => {
    onResetApprovals();
    setWorkspaces([]);
    setWsNote(null);
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    let stop = false;
    void (async () => {
      try {
        const rows = await api.listWorkspaces(inst);
        if (stop) return;
        setWorkspaces(rows);
        setSelWs((cur) => cur || rows[0]?.id || "");
        rows.forEach((w) => expandWsRef.current(w.id));
      } catch (e) {
        if (!stop) setWsNote(`workspaces: ${e instanceof Error ? e.message : e}`);
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId, status?.state]);

  const expandPersona = (ws: string, persona: string) => {
    const inst = activeInstance;
    if (!inst) return;
    const key = `${ws} ${persona}`;
    void api
      .listSessions(inst, ws, persona)
      .then((rows) => {
        const list = rows.filter((s) => s.id);
        setServerSessions((prev) => ({ ...prev, [key]: list }));
        // Seed titles delivered by the relay (list endpoint computes the
        // first-user-message title server-side); only rows without one get
        // the per-session events prefetch.
        const seeded = list.filter((s) => s.title);
        if (seeded.length) {
          setSessionTitles((prev) => {
            const next = { ...prev };
            for (const s of seeded) {
              const ck = `${inst.id} ${ws} ${persona} ${s.id}`;
              if (!next[ck]) next[ck] = clipTitle(s.title!);
            }
            return next;
          });
        }
        for (const s of list) {
          const ck = `${inst.id} ${ws} ${persona} ${s.id}`;
          if (s.title || sessionTitles[ck] || evCache.current.has(ck) || titleFetches.current.has(ck)) continue;
          titleFetches.current.add(ck);
          void api
            .sessionEvents(inst, ws, persona, s.id)
            .then((events) => {
              if (!events) return;
              const msgs = eventsToMessages(events);
              evCache.current.set(ck, msgs);
              const first = msgs.find((m) => m.role === "user")?.content;
              if (first) setSessionTitles((prev) => (prev[ck] ? prev : { ...prev, [ck]: clipTitle(first) }));
            })
            .finally(() => titleFetches.current.delete(ck));
        }
      })
      .catch(() => setServerSessions((prev) => (prev[key] ? prev : { ...prev, [key]: [] })));
  };

  const personasOf = (ws: string): PersonaRow[] | undefined => treePersonas[ws];

  const sessionRowsOf = (ws: string, persona: string): SessionRow[] | undefined => {
    const key = `${instId} ${ws} ${persona}`;
    const b = chats[key];
    const server = serverSessions[`${ws} ${persona}`];
    if (!b && server === undefined) return undefined;
    const localRows: SessionRow[] = (b?.items ?? [])
      // Hide drafts (the "new chat" button owns them) and legacy zombies:
      // minted sessions that were never sent and never reached the server.
      .filter((i) => !i.draft && (i.messages.length > 0 || Boolean(server?.some((s) => s.id === i.session))))
      .map((i) => {
        const first = i.messages.find((m) => m.role === "user")?.content?.trim();
        const remote = server?.find((s) => s.id === i.session);
        return {
          chatId: i.id,
          session: i.session,
          label: first
            ? clipTitle(first)
            : sessionTitles[`${instId} ${ws} ${persona} ${i.session}`] || remote?.title || remote?.goal || "new chat",
          pending: !remote,
        };
      });
    const covered = new Set(localRows.map((r) => r.session));
    const remoteRows: SessionRow[] = (server ?? [])
      .filter((s) => !covered.has(s.id))
      .map((s) => ({
        chatId: s.id,
        session: s.id,
        label: sessionTitles[`${instId} ${ws} ${persona} ${s.id}`] || s.title || s.goal || "…",
        pending: false,
      }));
    return [...localRows, ...remoteRows];
  };

  return {
    workspaces, setWorkspaces, treePersonas, setTreePersonas,
    serverSessions, setServerSessions, sessionTitles, setSessionTitles,
    expandWs, expandPersona, personasOf, sessionRowsOf,
  };
}
