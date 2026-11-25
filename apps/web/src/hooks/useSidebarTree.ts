import { useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  KlankerInstance,
  ProcessStatus,
  WorkspaceHosts,
  WorkspaceRow,
  WsInboxPersona,
} from "../types/klanker";
import { api } from "../services/api";
import type { PersonaRow, SessionRow } from "../components/KlankerList";
import { ChatBucket, LS_TITLES, clipTitle } from "../chatBuckets";
import { eventsToMessages } from "../chatSync";
import { dedupeWorkspaces, sessionHostPill } from "../wsTree";

/** Cached title key — `${ws} ${persona} ${session}` (klanker#150). */
const titleKey = (ws: string, persona: string, session: string) => `${ws} ${persona} ${session}`;

/**
 * Sidebar workspace/persona/session tree for the primary endpoint (local
 * `klanker serve` / browser origin — it fronts every local+synced+shared
 * workspace, so there is no per-instance split). Lazy persona + session +
 * hosts + inbox loaders, prefetch of session titles, and the row mappers
 * KlankerList renders.
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
  workspaces: WorkspaceRow[];
  setWorkspaces: (rows: WorkspaceRow[]) => void;
  wsHosts: Record<string, WorkspaceHosts>;
  setWsHosts: React.Dispatch<React.SetStateAction<Record<string, WorkspaceHosts>>>;
  treePersonas: Record<string, PersonaRow[]>;
  setTreePersonas: React.Dispatch<React.SetStateAction<Record<string, PersonaRow[]>>>;
  serverSessions: Record<string, { id: string; goal?: string; title?: string; host?: string }[]>;
  setServerSessions: React.Dispatch<
    React.SetStateAction<Record<string, { id: string; goal?: string; title?: string; host?: string }[]>>
  >;
  sessionTitles: Record<string, string>;
  setSessionTitles: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  expandWs: (ws: string) => void;
  expandPersona: (ws: string, persona: string) => void;
  refreshWorkspaces: () => void;
  refreshPersonas: (ws?: string) => void;
  refreshSessions: (ws?: string, persona?: string) => void;
  wsHostsOf: (ws: string) => WorkspaceHosts | undefined;
  personasOf: (ws: string) => PersonaRow[] | undefined;
  sessionRowsOf: (ws: string, persona: string) => SessionRow[] | undefined;
} {
  const { activeInstance, status, chats, setSelWs, setWsNote, evCache, onResetApprovals } = args;
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [wsHosts, setWsHosts] = useState<Record<string, WorkspaceHosts>>({});
  const [treePersonas, setTreePersonas] = useState<Record<string, PersonaRow[]>>({});
  const [personaCounts, setPersonaCounts] = useState<Record<string, Record<string, WsInboxPersona>>>({});
  const [serverSessions, setServerSessions] = useState<
    Record<string, { id: string; goal?: string; title?: string; host?: string }[]>
  >({});
  // Session titles keyed "ws persona session": prefetched eagerly, cached in localStorage.
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_TITLES) || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const titleFetches = useRef(new Set<string>());
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const wsHostsRef = useRef(wsHosts);
  wsHostsRef.current = wsHosts;
  const personaCountsRef = useRef(personaCounts);
  personaCountsRef.current = personaCounts;
  const instId = activeInstance?.id;

  const expandWs = (ws: string) => {
    const inst = activeInstance;
    if (!inst) return;
    if (!treePersonas[ws]) {
      void api
        .listPersonas(inst, ws)
        .then((rows) => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: rows })))
        .catch(() => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: [] })));
    }
    // Member devices + presence (sync badge, bound-host pills) and per-persona
    // handoff counts — the local relay's operator surface fronts them for
    // every workspace it serves. Older relays 404 cleanly to "absent".
    if (!wsHosts[ws]) {
      void api
        .fetchWorkspaceHosts(ws)
        .then((h) => setWsHosts((prev) => (prev[ws] ? prev : { ...prev, [ws]: h })))
        .catch(() => {});
    }
    if (!personaCounts[ws]) {
      void api
        .wsInbox(inst, ws)
        .then((r) => {
          if (r) setPersonaCounts((prev) => ({ ...prev, [ws]: r.personas }));
        })
        .catch(() => {});
    }
  };
  const expandWsRef = useRef(expandWs);
  expandWsRef.current = expandWs;

  // Workspace list for the primary endpoint — dedupe keeps a shared/synced
  // ws to exactly one top-level row however many devices serve it.
  useEffect(() => {
    onResetApprovals();
    setWorkspaces([]);
    setWsNote(null);
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    let stop = false;
    void (async () => {
      try {
        const rows = dedupeWorkspaces(await api.listWorkspaces(inst));
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

  // Persona rows are not a permanent cache: remote edits (routines,
  // other clients) must surface. Re-pull on tab visibility, window focus,
  // and every 30s while visible — hosts/inbox refresh once loaded.
  useEffect(() => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    const refresh = () => {
      for (const ws of workspacesRef.current) {
        void api
          .listPersonas(inst, ws.id)
          .then((rows) => setTreePersonas((prev) => ({ ...prev, [ws.id]: rows })))
          .catch(() => {});
        if (wsHostsRef.current[ws.id]) {
          void api
            .fetchWorkspaceHosts(ws.id)
            .then((h) => setWsHosts((prev) => ({ ...prev, [ws.id]: h })))
            .catch(() => {});
        }
        if (personaCountsRef.current[ws.id]) {
          void api
            .wsInbox(inst, ws.id)
            .then((r) => {
              if (r) setPersonaCounts((prev) => ({ ...prev, [ws.id]: r.personas }));
            })
            .catch(() => {});
        }
      }
    };
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
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
              const ck = titleKey(ws, persona, s.id);
              if (!next[ck]) next[ck] = clipTitle(s.title!);
            }
            return next;
          });
        }
        for (const s of list) {
          const ck = titleKey(ws, persona, s.id);
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

  const wsHostsOf = (ws: string): WorkspaceHosts | undefined => wsHosts[ws];

  const personasOf = (ws: string): PersonaRow[] | undefined => {
    const rows = treePersonas[ws];
    if (!rows) return undefined;
    const counts = personaCounts[ws];
    if (!counts) return rows;
    return rows.map((p) => {
      const c = counts[p.id];
      // Unread = open handoffs plus running ones (the contacts badge).
      const unread = (c?.unread ?? c?.open ?? 0) + (c?.running ?? 0);
      return unread ? { ...p, unread } : p;
    });
  };

  const sessionRowsOf = (ws: string, persona: string): SessionRow[] | undefined => {
    const key = `${ws} ${persona}`;
    const b = chats[key];
    const server = serverSessions[key];
    const hosts = wsHosts[ws];
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
            : sessionTitles[titleKey(ws, persona, i.session)] || remote?.title || remote?.goal || "new chat",
          pending: !remote,
          host: sessionHostPill(remote?.host, i.session, hosts) || undefined,
        };
      });
    const covered = new Set(localRows.map((r) => r.session));
    const remoteRows: SessionRow[] = (server ?? [])
      .filter((s) => !covered.has(s.id))
      .map((s) => ({
        chatId: s.id,
        session: s.id,
        label: sessionTitles[titleKey(ws, persona, s.id)] || s.title || s.goal || "…",
        pending: false,
        host: sessionHostPill(s.host, s.id, hosts) || undefined,
      }));
    return [...localRows, ...remoteRows];
  };

  const refreshWorkspaces = () => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    void api
      .listWorkspaces(inst)
      .then((raw) => {
        const rows = dedupeWorkspaces(raw);
        setWorkspaces(rows);
        setSelWs((cur) => cur || rows[0]?.id || "");
        rows.forEach((w) => expandWsRef.current(w.id));
      })
      .catch(() => {});
  };

  const refreshPersonas = (wsId?: string) => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    const targets = wsId ? [{ id: wsId }] : workspacesRef.current;
    for (const w of targets) {
      void api
        .listPersonas(inst, w.id)
        .then((rows) => setTreePersonas((prev) => ({ ...prev, [w.id]: rows })))
        .catch(() => {});
      void api
        .wsInbox(inst, w.id)
        .then((r) => {
          if (r) setPersonaCounts((prev) => ({ ...prev, [w.id]: r.personas }));
        })
        .catch(() => {});
    }
  };

  const refreshSessions = (wsId?: string, personaId?: string) => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    if (wsId && personaId) {
      expandPersona(wsId, personaId);
      return;
    }
    for (const k of Object.keys(serverSessions)) {
      const [ws, persona] = k.split(" ");
      if (!ws || !persona) continue;
      if (wsId && ws !== wsId) continue;
      expandPersona(ws, persona);
    }
  };

  return {
    workspaces,
    setWorkspaces,
    wsHosts,
    setWsHosts,
    treePersonas,
    setTreePersonas,
    serverSessions,
    setServerSessions,
    sessionTitles,
    setSessionTitles,
    expandWs,
    expandPersona,
    refreshWorkspaces,
    refreshPersonas,
    refreshSessions,
    wsHostsOf,
    personasOf,
    sessionRowsOf,
  };
}
