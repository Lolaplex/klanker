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
import { fetchSWR, peekSWR, subscribeSWR, swrKey } from "../services/swrCache";
import { sessionEventsKey, sessionListKey, type SidebarSession } from "../services/sessionCache";

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
  /** Live SSE stream health (klanker#169 U15): while healthy, focus /
   *  visibility regains skip the personas re-pull entirely — events
   *  already drive updates, the 30s interval stays as the backstop. */
  sseHealthy?: boolean;
  /** Currently selected workspace — always refresh-scoped even when its
   *  details were never expanded. */
  selWs?: string;
}): {
  workspaces: WorkspaceRow[];
  setWorkspaces: (rows: WorkspaceRow[]) => void;
  personaCounts: Record<string, Record<string, WsInboxPersona>>;
  wsHosts: Record<string, WorkspaceHosts>;
  setWsHosts: React.Dispatch<React.SetStateAction<Record<string, WorkspaceHosts>>>;
  treePersonas: Record<string, PersonaRow[]>;
  setTreePersonas: React.Dispatch<React.SetStateAction<Record<string, PersonaRow[]>>>;
  serverSessions: Record<string, { id: string; goal?: string; title?: string; host?: string; branch?: string; repo?: string; wip_unpushed?: boolean; last_active?: string }[]>;
  setServerSessions: React.Dispatch<
    React.SetStateAction<Record<string, { id: string; goal?: string; title?: string; host?: string; branch?: string; repo?: string; wip_unpushed?: boolean; last_active?: string }[]>>
  >;
  sessionTitles: Record<string, string>;
  setSessionTitles: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  expandWs: (ws: string) => void;
  expandPersona: (ws: string, persona: string) => void;
  refreshWorkspaces: () => void;
  refreshPersonas: (ws?: string) => void;
  refreshSessions: (ws?: string, persona?: string) => void;
  refreshHosts: (ws?: string) => void;
  wsHostsOf: (ws: string) => WorkspaceHosts | undefined;
  personasOf: (ws: string) => PersonaRow[] | undefined;
  sessionRowsOf: (ws: string, persona: string) => SessionRow[] | undefined;
  prefetchSession: (ws: string, persona: string, session: string) => void;
} {
  const { activeInstance, status, chats, setSelWs, setWsNote, evCache, onResetApprovals, sseHealthy = false, selWs = "" } = args;
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [wsHosts, setWsHosts] = useState<Record<string, WorkspaceHosts>>({});
  const [treePersonas, setTreePersonas] = useState<Record<string, PersonaRow[]>>({});
  const [personaCounts, setPersonaCounts] = useState<Record<string, Record<string, WsInboxPersona>>>({});
  const [serverSessions, setServerSessions] = useState<
    Record<string, { id: string; goal?: string; title?: string; host?: string; branch?: string; repo?: string; wip_unpushed?: boolean; last_active?: string }[]>
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
  const treePersonasRef = useRef(treePersonas);
  treePersonasRef.current = treePersonas;
  const selWsRef = useRef(selWs);
  selWsRef.current = selWs;
  const sseHealthyRef = useRef(sseHealthy);
  sseHealthyRef.current = sseHealthy;
  const instId = activeInstance?.id;

  const subscribeCache = <T,>(key: string, apply: (rows: T) => void) => {
    if (!sessionSubscriptions.current.has(key)) {
      sessionSubscriptions.current.set(key, subscribeSWR(key, () => {
        const rows = peekSWR<T>(key);
        if (rows !== undefined) apply(rows);
      }));
    }
  };

  const expandWs = (ws: string) => {
    const inst = activeInstance;
    if (!inst) return;
    if (!treePersonas[ws]) {
      const personasKey = swrKey(inst.id, ws, "personas");
      const cached = peekSWR<PersonaRow[]>(personasKey);
      if (cached) setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: cached }));
      subscribeCache<PersonaRow[]>(personasKey, (rows) => setTreePersonas((prev) => ({ ...prev, [ws]: rows })));
      void fetchSWR(personasKey, () => api.listPersonas(inst, ws), { ttlMs: 30_000, persist: "session" })
        .then((rows) => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: rows })))
        .catch(() => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: [] })));
    }
    // Member devices + presence (sync badge, bound-host pills) and per-persona
    // handoff counts — the local relay's operator surface fronts them for
    // every workspace it serves. Older relays 404 cleanly to "absent".
    if (!wsHosts[ws]) {
      const hostsKey = swrKey(inst.id, ws, "hosts");
      subscribeCache<WorkspaceHosts>(hostsKey, (h) => setWsHosts((prev) => ({ ...prev, [ws]: h })));
      const cachedHosts = peekSWR<WorkspaceHosts>(hostsKey);
      if (cachedHosts) setWsHosts((prev) => (prev[ws] ? prev : { ...prev, [ws]: cachedHosts }));
      void fetchSWR(hostsKey, () => api.fetchWorkspaceHosts(ws), { ttlMs: 15_000, persist: "session" })
        .then((h) => setWsHosts((prev) => (prev[ws] ? prev : { ...prev, [ws]: h })))
        .catch(() => {});
    }
    if (!personaCounts[ws]) {
      const inboxKey = swrKey(inst.id, ws, "inbox");
      subscribeCache<Record<string, WsInboxPersona> | null>(inboxKey, (rows) => {
        if (rows) setPersonaCounts((prev) => ({ ...prev, [ws]: rows }));
      });
      void fetchSWR(inboxKey, async () => (await api.wsInbox(inst, ws))?.personas ?? null, { ttlMs: 15_000, persist: "session" })
        .then((rows) => {
          if (rows) setPersonaCounts((prev) => ({ ...prev, [ws]: rows }));
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
        const workspacesKey = swrKey(inst.id, "_root", "workspaces");
        const applyRows = (rows: WorkspaceRow[]) => {
          if (stop) return;
          setWorkspaces(rows);
          setSelWs((cur) => cur || rows[0]?.id || "");
        };
        subscribeCache<WorkspaceRow[]>(workspacesKey, applyRows);
        const cached = peekSWR<WorkspaceRow[]>(workspacesKey);
        if (cached) applyRows(cached);
        const rows = await fetchSWR(workspacesKey, async () => dedupeWorkspaces(await api.listWorkspaces(inst)), { ttlMs: 30_000, persist: "session" });
        applyRows(rows);
        // No eager expandWs for every row (klanker#169 U15): 3 requests
        // per workspace fired even for collapsed rows. Details lazy-load
        // via KlankerList expand/selection; the selected row is expanded
        // by KlankerList's mount effect.
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
    // Scope: only workspaces whose details are loaded (expanded at least
    // once) plus the selected one — collapsed rows stay lazy (klanker#169).
    const refresh = () => {
      for (const ws of workspacesRef.current) {
        const loaded = !!treePersonasRef.current[ws.id];
        if (!loaded && ws.id !== selWsRef.current) continue;
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
      if (!document.hidden && !sseHealthyRef.current) refresh();
    };
    const onFocus = () => {
      if (!sseHealthyRef.current) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId, status?.state]);

  const sessionSubscriptions = useRef(new Map<string, () => void>());
  useEffect(() => {
    const subs = sessionSubscriptions.current;
    return () => {
      for (const off of subs.values()) off();
      subs.clear();
    };
  }, [instId]);

  const applySessionList = (ws: string, persona: string, rows: SidebarSession[]) => {
    const key = `${ws} ${persona}`;
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
    const inst = activeInstance;
    if (!inst) return;
    for (const s of list) {
      const ck = titleKey(ws, persona, s.id);
      if (s.title || sessionTitles[ck] || evCache.current.has(ck) || titleFetches.current.has(ck)) continue;
      titleFetches.current.add(ck);
      void fetchSWR(sessionEventsKey(inst.id, ws, persona, s.id), () => api.sessionEvents(inst, ws, persona, s.id), { ttlMs: 15_000, persist: "session" })
        .then((events) => {
          if (!events) return;
          const msgs = eventsToMessages(events);
          evCache.current.set(ck, msgs);
          const first = msgs.find((m) => m.role === "user")?.content;
          if (first) setSessionTitles((prev) => (prev[ck] ? prev : { ...prev, [ck]: clipTitle(first) }));
        })
        .catch(() => {})
        .finally(() => titleFetches.current.delete(ck));
    }
  };

  const expandPersona = (ws: string, persona: string) => {
    const inst = activeInstance;
    if (!inst) return;
    const key = `${ws} ${persona}`;
    const cacheKey = sessionListKey(inst.id, ws, persona);
    if (!sessionSubscriptions.current.has(cacheKey)) {
      sessionSubscriptions.current.set(cacheKey, subscribeSWR(cacheKey, () => {
        const rows = peekSWR<SidebarSession[]>(cacheKey);
        if (rows) applySessionList(ws, persona, rows);
      }));
    }
    const cached = peekSWR<SidebarSession[]>(cacheKey);
    if (cached) applySessionList(ws, persona, cached);
    void fetchSWR(cacheKey, () => api.listSessions(inst, ws, persona), { ttlMs: 15_000, persist: "session" })
      .then((rows) => applySessionList(ws, persona, rows))
      .catch(() => setServerSessions((prev) => (prev[key] ? prev : { ...prev, [key]: [] })));
  };

  const prefetchSession = (ws: string, persona: string, session: string) => {
    const inst = activeInstance;
    if (!inst || !session) return;
    const ck = titleKey(ws, persona, session);
    void fetchSWR(sessionEventsKey(inst.id, ws, persona, session), () => api.sessionEvents(inst, ws, persona, session), { ttlMs: 15_000, persist: "session" })
      .then((events) => {
        if (events) evCache.current.set(ck, eventsToMessages(events));
      })
      .catch(() => {});
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
          label: sessionTitles[titleKey(ws, persona, i.session)] || (first ? clipTitle(first) : remote?.title || remote?.goal || "new chat"),
          pending: !remote,
          host: sessionHostPill(remote?.host, i.session, hosts) || undefined,
          branch: remote?.branch,
          repo: remote?.repo,
          wip_unpushed: remote?.wip_unpushed,
          last_active: remote?.last_active,
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
        branch: s.branch,
        repo: s.repo,
        wip_unpushed: s.wip_unpushed,
        last_active: s.last_active,
      }));
    return [...localRows, ...remoteRows];
  };

  const refreshWorkspaces = () => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    const workspacesKey = swrKey(inst.id, "_root", "workspaces");
    subscribeCache<WorkspaceRow[]>(workspacesKey, (rows) => {
      setWorkspaces(rows);
      setSelWs((cur) => cur || rows[0]?.id || "");
    });
    void fetchSWR(workspacesKey, async () => dedupeWorkspaces(await api.listWorkspaces(inst)), { ttlMs: 30_000, persist: "session" })
      .then((rows) => {
        setWorkspaces(rows);
        setSelWs((cur) => cur || rows[0]?.id || "");
        // No eager expandWs for every row (klanker#169 U15): 3 requests
        // per workspace fired even for collapsed rows. Details lazy-load
        // via KlankerList expand/selection; the selected row is expanded
        // by KlankerList's mount effect.
      })
      .catch(() => {});
  };

  const refreshPersonas = (wsId?: string) => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    const targets = wsId ? [{ id: wsId }] : workspacesRef.current;
    for (const w of targets) {
      const personasKey = swrKey(inst.id, w.id, "personas");
      subscribeCache<PersonaRow[]>(personasKey, (rows) => setTreePersonas((prev) => ({ ...prev, [w.id]: rows })));
      void fetchSWR(personasKey, () => api.listPersonas(inst, w.id), { ttlMs: 30_000, persist: "session" })
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

  // Live member presence + leases (klanker#152): SSE device/lease/ws
  // events re-pull the affected ws payloads — or every loaded one when
  // the event carries no workspace scope (device.connected has none).
  const refreshHosts = (wsId?: string) => {
    const targets = wsId ? [wsId] : Object.keys(wsHostsRef.current);
    for (const ws of targets) {
      const inst = activeInstance;
      if (!inst) continue;
      const hostsKey = swrKey(inst.id, ws, "hosts");
      subscribeCache<WorkspaceHosts>(hostsKey, (h) => setWsHosts((prev) => ({ ...prev, [ws]: h })));
      void fetchSWR(hostsKey, () => api.fetchWorkspaceHosts(ws), { ttlMs: 15_000, persist: "session" })
        .then((h) => setWsHosts((prev) => ({ ...prev, [ws]: h })))
        .catch(() => {});
    }
  };

  return {
    workspaces,
    setWorkspaces,
    personaCounts,
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
    refreshHosts,
    wsHostsOf,
    personasOf,
    sessionRowsOf,
    prefetchSession,
  };
}
