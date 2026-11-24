import { useState, useRef, useCallback, useEffect } from "react";
import { Header } from "./components/Header";
import { KlankerList } from "./components/KlankerList";
import { ChatConsole, type ChatPick } from "./components/ChatConsole";
import { InstanceSheet } from "./components/InstanceSheet";
import { NewKlankerModal } from "./components/NewKlankerModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { ManagePanel } from "./components/ManagePanel";
import {
  DesktopSettings,
  KlankerInstance,
  ChatMessage,
  ModelPick,
  ProviderRow,
} from "./types/klanker";
import { api, caps, notify } from "./services/api";
import { dialogs } from "./services/dialogs";
import { DialogHost } from "./components/DialogHost";
import { createDeltaQueue } from "./chatPersist";
import type { SessionRow } from "./components/KlankerList";
import {
  ChatBucket,
  TurnBusy,
  EMPTY_BUCKET,
  STANDALONE,
  loadBucket,
  mapChat,
  mintSessionId,
  normBucket,
  selStoreKey,
} from "./chatBuckets";
import { reconcileChat } from "./chatSync";
import { Kicker, runResumableTurn } from "./turnStream";
import { MIN_RELAY } from "./relayCompat";
import { AuthGate } from "./components/AuthGate";
import { PairModal } from "./components/PairModal";
import { WorkspacePane } from "./components/WorkspacePane";
import { WorkspaceSettingsModal } from "./components/WorkspaceSettingsModal";
import { useKeyboardViewport } from "./hooks/useKeyboardViewport";
import { useInstances } from "./hooks/useInstances";
import { usePersistChats } from "./hooks/usePersistChats";
import { useRelayEvents } from "./hooks/useRelayEvents";
import { useSidebarTree } from "./hooks/useSidebarTree";
import { useChatSync } from "./hooks/useChatSync";
import { useApprovals } from "./hooks/useApprovals";
import { useRelayCompat } from "./hooks/useRelayCompat";

const DEFAULT_SETTINGS: DesktopSettings = { workspace: "", autostart: false, hub_mode: false };

function loadedSettings(loaded: DesktopSettings): DesktopSettings {
  return { ...DEFAULT_SETTINGS, ...loaded };
}

export function App() {
  const [activeInstance, setActiveInstance] = useState<KlankerInstance | null>(null);
  const [chats, setChats] = useState<Record<string, ChatBucket>>({});
  const [turnBusy, setTurnBusy] = useState<TurnBusy | null>(null);
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [instanceSheetInst, setInstanceSheetInst] = useState<KlankerInstance | null>(null);
  const [selWs, setSelWs] = useState("");
  // Per-chat provider+model override, keyed by "<inst> <ws> <persona>"; absent = instance default.
  const [chatPicks, setChatPicks] = useState<Record<string, ChatPick>>({});
  const [chatProviders, setChatProviders] = useState<ProviderRow[]>([]);
  const [providersStale, setProvidersStale] = useState(false);
  const [chatFavorites, setChatFavorites] = useState<ModelPick[]>([]);
  const [selPersona, setSelPersona] = useState("");
  const [wsNote, setWsNote] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [wsSettingsId, setWsSettingsId] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [storeSupported, setStoreSupported] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [storeRev, setStoreRev] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  const { kbBox, idleH } = useKeyboardViewport();

  const activeIdRef = useRef<string | null>(null);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const turnBusyRef = useRef(turnBusy);
  turnBusyRef.current = turnBusy;
  const settingsRef = useRef(settings);
  const settingsWrite = useRef(Promise.resolve());
  const saveGen = useRef(0);
  // Buffered SSE deltas: one setChats per frame instead of one per token.
  const deltaFlush = useRef<() => void>(() => undefined);
  // Restored messages per session + in-flight title fetches (no refetch spam).
  const evCache = useRef(new Map<string, ChatMessage[]>());

  const selKey = activeInstance ? `${activeInstance.id} ${selWs} ${selPersona}` : "";

  const selectInstance = useCallback((inst: KlankerInstance | null) => {
    deltaFlush.current();
    activeIdRef.current = inst?.id ?? null;
    api.saveActiveId(inst?.id ?? null);
    setActiveInstance(inst);
    if (!inst) return;
    tree.setTreePersonas({});
    tree.setServerSessions({});
    setUnread((prev) => {
      if (!prev.has(inst.id)) return prev;
      const next = new Set(prev);
      next.delete(inst.id);
      return next;
    });
    // inst.workspace is the workdir boundary, not a workspace id — the ws
    // selection only ever comes from the stored choice.
    let savedWs = "";
    let savedPersona = (inst.persona || "").trim() || "default";
    try {
      const s = JSON.parse(localStorage.getItem(selStoreKey(inst.id)) || "null");
      // Older sessions stored the workdir path here; ws ids are bare slugs.
      if (s?.ws && /^[\w.-]+$/.test(String(s.ws))) savedWs = String(s.ws);
      if (s?.persona) savedPersona = String(s.persona);
    } catch {}
    setSelWs(savedWs);
    setSelPersona(savedPersona);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSettings = useCallback(async () => {
    const run = settingsWrite.current.then(async () => {
      try {
        const loaded = await api.loadSettings();
        settingsRef.current = loadedSettings(loaded);
        setSettings(settingsRef.current);
      } catch (e) {
        console.error("Failed to load settings", e);
      }
    });
    settingsWrite.current = run.then(() => undefined, () => undefined);
  }, []);

  const inst = useInstances({
    onSelectInstance: selectInstance,
    loadSettings,
    setWsNote,
  });

  const herdStatus = activeInstance ? inst.herd[activeInstance.id] ?? null : null;

  const approvals = useApprovals({ activeInstance, status: herdStatus, workspaceId: selWs });
  const relayCompat = useRelayCompat({ activeInstance, managedId: inst.managedId, herd: inst.herd });

  // Probe optional store / voice capabilities for active running relay.
  useEffect(() => {
    const inst0 = activeInstance;
    if (!inst0 || herdStatus?.state !== "running") {
      setStoreSupported(false);
      setVoiceSupported(false);
      return;
    }
    let stop = false;
    void api.getCapabilities(inst0).then((c) => {
      if (stop) return;
      setStoreSupported(c.store);
      setVoiceSupported(c.voice);
    });
    return () => {
      stop = true;
    };
  }, [activeInstance?.id, herdStatus?.state, activeInstance]);

  // Workspace-scoped voice read-aloud preference.
  useEffect(() => {
    const key = `klanker.voice.${selWs || "default"}`;
    try {
      setVoiceEnabled(localStorage.getItem(key) === "1");
    } catch {
      setVoiceEnabled(false);
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {}
  }, [selWs]);

  const toggleVoice = useCallback(() => {
    setVoiceEnabled((prev) => {
      const next = !prev;
      const key = `klanker.voice.${selWs || "default"}`;
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {}
      if (!next) {
        try {
          window.speechSynthesis?.cancel();
        } catch {}
      }
      return next;
    });
  }, [selWs]);

  const tree = useSidebarTree({
    activeInstance,
    status: herdStatus,
    chats,
    setSelWs,
    setWsNote,
    evCache,
    onResetApprovals: approvals.reset,
  });

  const { flushPersist } = usePersistChats({
    chats,
    chatsRef,
    setChats,
    sessionTitles: tree.sessionTitles,
    activeInstance,
    selWs,
    selPersona,
    selKey,
  });

  const bucket = selKey ? chats[selKey] : undefined;
  const openChat = bucket?.items.find((item) => item.id === bucket.openId) ?? bucket?.items[0] ?? null;

  // Always keep one open draft per bucket: the composer is keyed by chat id,
  // so a draft created by the first keystroke would remount it mid-typing
  // and drop focus (mobile eats every char after the first).
  useEffect(() => {
    if (!selKey || openChat) return;
    setChats((prev) => {
      const b = normBucket(prev[selKey] ?? EMPTY_BUCKET);
      if (b.items.some((i) => i.id === b.openId)) return prev;
      const id = crypto.randomUUID();
      return {
        ...prev,
        [selKey]: { openId: id, items: [...b.items, { id, session: "", messages: [], draft: true }] },
      };
    });
  }, [selKey, openChat]);

  const messages = openChat?.messages ?? [];
  const isLoadingTurn = Boolean(
    turnBusy && openChat && turnBusy.instanceId === activeInstance?.id && turnBusy.chatId === openChat.id
  );
  const sendHold = Boolean(
    turnBusy && activeInstance && turnBusy.instanceId === activeInstance.id && turnBusy.chatId !== openChat?.id
  );

  const applyToChat = useCallback(
    (key: string, chatId: string, fn: (messages: ChatMessage[]) => ChatMessage[]) => {
      setChats((prev) =>
        mapChat(prev, key, chatId, (item) => {
          if (turnBusyRef.current?.chatId === chatId) return item;
          const next = fn(item.messages);
          return next === item.messages ? item : { ...item, messages: next };
        })
      );
    },
    []
  );

  // Model pick lives on the relay (/v1/model): a session-scoped pick
  // always wins; the workspace last-used pick only seeds chats that don't
  // have their own selection yet.
  useEffect(() => {
    const inst = activeInstance;
    if (!inst || !selKey) return;
    let stop = false;
    void api
      .getModelPick(inst, selWs, openChat?.session || "")
      .then((pick) => {
        if (stop || (!pick.provider && !pick.model)) return;
        setChatPicks((prev) =>
          pick.scope === "session" || !prev[selKey]
            ? { ...prev, [selKey]: { provider: pick.provider, model: pick.model } }
            : prev
        );
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, openChat?.session]);

  const { remoteActive } = useChatSync({
    activeInstance,
    openChat,
    selKey,
    selWs,
    selPersona,
    setChats,
    turnBusyRef,
    evCache,
    setSessionTitles: tree.setSessionTitles,
    setStreamStatus,
  });

  useRelayEvents({
    activeInstance,
    status: herdStatus,
    onEvent: (ev) => {
      if (ev.kind === "workspace.changed") {
        tree.refreshWorkspaces();
      } else if (ev.kind === "persona.changed") {
        tree.refreshPersonas(ev.workspace || undefined);
      } else if (ev.kind === "session.changed") {
        tree.refreshSessions(
          ev.workspace || undefined,
          typeof ev.payload?.persona === "string" ? ev.payload.persona : undefined
        );
      } else if (ev.kind === "remote.changed") {
        void inst.refreshInstances();
      } else if (ev.kind === "approval.changed") {
        approvals.refresh();
      } else if (ev.kind === "store.changed") {
        setStoreRev((n) => n + 1);
      }
    },
  });

  const selectChat = (ws: string, persona: string, chatId: string) => {
    if (!activeInstance) return;
    deltaFlush.current();
    const key = `${activeInstance.id} ${ws} ${persona}`;
    setSelWs(ws);
    setSelPersona(persona);
    setChats((prev) => {
      const current = normBucket(prev[key] ?? loadBucket(key) ?? EMPTY_BUCKET);
      const hit = current.items.find((i) => i.id === chatId || (i.session && i.session === chatId));
      if (hit) {
        return current.openId === hit.id ? prev : { ...prev, [key]: { ...current, openId: hit.id } };
      }
      const items = [
        ...current.items.filter((i) => i.session !== chatId),
        { id: crypto.randomUUID(), session: chatId, messages: [] },
      ];
      return { ...prev, [key]: { openId: items[items.length - 1].id, items } };
    });
  };

  const deleteChat = async (ws: string, persona: string, row: SessionRow) => {
    const inst0 = activeInstance;
    if (!inst0) return;
    if (!(await dialogs.confirm(`Delete chat "${row.label || row.session}"? This cannot be undone.`, { danger: true }))) return;
    const key = `${inst0.id} ${ws} ${persona}`;
    // Optimistic: drop the row from both stores before the server answers.
    tree.setServerSessions((prev) => ({
      ...prev,
      [`${ws} ${persona}`]: (prev[`${ws} ${persona}`] || []).filter((s) => s.id !== row.session),
    }));
    setChats((prev) => {
      const current = prev[key];
      if (!current) return prev;
      const items = current.items.filter((i) => i.id !== row.chatId && i.session !== row.session);
      if (items.length === 0) return { ...prev, [key]: { openId: "", items: [] } };
      const openId = items.some((i) => i.id === current.openId) ? current.openId : items[items.length - 1].id;
      return { ...prev, [key]: { openId, items } };
    });
    if (!row.pending) {
      void api.deleteSession(inst0, ws, persona, row.session).catch((e) => {
        setWsNote(`delete: ${e instanceof Error ? e.message : e}`);
        tree.expandPersona(ws, persona);
      });
    }
  };

  const newChat = (ws: string, persona: string) => {
    if (!activeInstance) return;
    deltaFlush.current();
    const key = `${activeInstance.id} ${ws} ${persona}`;
    setSelWs(ws);
    setSelPersona(persona);
    setChats((prev) => {
      const current = normBucket(prev[key] ?? loadBucket(key) ?? EMPTY_BUCKET);
      const draft = current.items.find((i) => i.draft);
      if (draft) {
        return current.openId === draft.id ? prev : { ...prev, [key]: { ...current, openId: draft.id } };
      }
      const id = crypto.randomUUID();
      return {
        ...prev,
        [key]: { openId: id, items: [...current.items, { id, session: "", messages: [], draft: true }] },
      };
    });
  };

  const updateSettings = useCallback((mutate: (current: DesktopSettings) => DesktopSettings) => {
    const run = settingsWrite.current.then(async () => {
      const next = mutate(settingsRef.current);
      if (next === settingsRef.current) return next;
      const saved = await api.saveSettings(next);
      settingsRef.current = loadedSettings(saved);
      setSettings(settingsRef.current);
      return settingsRef.current;
    });
    settingsWrite.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const handleSaveInstance = async (instance: KlankerInstance) => {
    const gen = ++saveGen.current;
    try {
      const prevSecret = inst.instances.find((i) => i.id === instance.id)?.secret;
      const saved = await api.saveKlanker(instance);
      if (gen !== saveGen.current) return;
      // A name edit may rename the id (folder = slug): replace by the sent id.
      inst.setInstances((prevList) => {
        const idx = prevList.findIndex((i) => i.id === instance.id || i.id === saved.id);
        if (idx >= 0) {
          const next = [...prevList];
          next[idx] = saved;
          return next;
        }
        return [...prevList, saved];
      });
      if (activeIdRef.current === instance.id || activeIdRef.current === saved.id) setActiveInstance(saved);
      // Re-probe immediately — a fresh secret should clear `unauthorized`
      // without waiting for the 8s health poll.
      void api.getGatewayStatus(saved).then((st) =>
        inst.setHerd((prev) => ({ ...prev, [saved.id]: st }))
      );
      // New secret on the managed local serve: restart it so the respawn
      // reads the fresh keyring entry — the running process still validates
      // against its spawn-time token and would 401 forever otherwise.
      const staleAuth = inst.herd[saved.id]?.detail === "unauthorized";
      if (saved.kind === "local" && caps.spawn && saved.secret && (saved.secret !== prevSecret || staleAuth)) {
        void api.serveRestart(settingsRef.current.hub_mode).then(() =>
          api.getGatewayStatus(saved).then((st) =>
            inst.setHerd((prev) => ({ ...prev, [saved.id]: st }))
          )
        );
      }
    } catch (e) {
      console.error("Failed to save instance:", e);
      throw e;
    }
  };

  const openSettings = () => {
    setSettingsOpen(true);
  };

  // Provider rows (incl. acp.* agents + models) + host-side favorites for
  // the unified picker. Stale rows keep an offline host pickable.
  const refreshProviders = useCallback(() => {
    const inst = activeInstance;
    if (!inst) return;
    void api.listProviders(inst).then((r) => {
      setChatProviders(r.rows);
      setProvidersStale(r.stale);
    });
    void api.listFavorites(inst).then(setChatFavorites);
  }, [activeInstance?.id]);

  useEffect(() => {
    setChatProviders([]);
    setChatFavorites([]);
    setProvidersStale(false);
    refreshProviders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeInstance?.id]);

  const handleSaveSettings = async (next: DesktopSettings) => {
    try {
      await updateSettings((current) => ({
        ...current,
        workspace: next.workspace.trim(),
        autostart: next.autostart,
        hub_mode: next.hub_mode,
      }));
      if (caps.spawn) {
        try {
          await api.autostartSet(next.autostart);
        } catch (e) {
          console.error("autostart toggle failed", e);
        }
        // The bind host only applies at spawn — a hub_mode flip without a
        // restart silently keeps the old 127.0.0.1/0.0.0.0 binding.
        if (next.hub_mode !== settings.hub_mode) {
          void api.serveRestart(next.hub_mode).then(() =>
            activeInstance
              ? api.getGatewayStatus(activeInstance).then((st) =>
                  inst.setHerd((prev) => ({ ...prev, [activeInstance.id]: st }))
                )
              : undefined
          );
        }
      }
      setSettingsOpen(false);
    } catch (e) {
      console.error("Failed to save settings", e);
    }
  };

  const handleCreate = (draft: KlankerInstance) =>
    handleSaveInstance({ ...draft, provider: "" });


  const handleDeleteInstance = async (id: string) => {
    try {
      await api.deleteKlanker(id);
      const remaining = inst.instances.filter((i) => i.id !== id);
      inst.setInstances(remaining);
      if (activeInstance?.id === id) {
        selectInstance(remaining[0] ?? null);
      }
      setUnread((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      inst.setHerd((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setChats((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) if (k.startsWith(`${id} `)) delete next[k];
        return next;
      });
    } catch (e) {
      console.error("Failed to delete instance:", e);
    }
  };

  const handleStop = () => {
    const busy = turnBusyRef.current;
    if (!busy) return;
    const inst0 = inst.instancesRef.current.find((i) => i.id === busy.instanceId);
    if (inst0) void api.stopRun(inst0, busy.run).catch(() => undefined);
  };

  const handleSendMessage = async (text: string, attachments?: { data: string; mime?: string; name?: string }[]) => {
    const inst0 = activeInstance;
    if (!inst0) return;
    const id = inst0.id;
    if (turnBusyRef.current?.instanceId === id) return;
    const current = chatsRef.current[selKey];
    let chat = current?.items.find((item) => item.id === current.openId);
    if (!chat) {
      // No open chat (fresh bucket or all deleted): open a draft so the
      // first send never dies silently.
      const chatId = crypto.randomUUID();
      chat = { id: chatId, session: "", messages: [], draft: true };
      setChats((prev) => {
        const b = normBucket(prev[selKey] ?? loadBucket(selKey) ?? EMPTY_BUCKET);
        if (b.items.some((i) => i.id === chatId)) return prev;
        return { ...prev, [selKey]: { openId: chatId, items: [...b.items, chat!] } };
      });
    }
    const chatId = chat.id;
    const session = chat.session || mintSessionId();

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
      attachments: attachments?.map((a) => a.name || "file"),
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "klanker",
      content: "",
      timestamp: new Date().toISOString(),
    };
    setChats((prev) =>
      mapChat(prev, selKey, chatId, (item) => ({
        ...item,
        session,
        draft: false,
        input: "",
        messages: [...item.messages, userMessage, assistantMessage],
      }))
    );
    const busy: TurnBusy = { instanceId: id, chatId, run: crypto.randomUUID().replace(/-/g, "") };
    turnBusyRef.current = busy;
    setTurnBusy(busy);
    const started = Date.now();
    let sawTrailer = false;

    setStreamStatus(null);

    // SSE deltas land per token; merge them into one setChats per frame.
    const deltas = createDeltaQueue((text) => {
      setChats((prev) =>
        mapChat(prev, selKey, chatId, (item) => ({
          ...item,
          messages: item.messages.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + text } : m
          ),
        }))
      );
    });
    deltaFlush.current = () => deltas.flush();

    try {
      // Provider = raw host manifest name (acp.devin, lmstudio.local, …);
      // "" = host default. The relay resolves session pick > ws pick > env.
      const pick = chatPicks[selKey];
      const instProvider = inst0.provider.trim();
      const provider = pick?.provider.trim() || (instProvider !== "inherit" ? instProvider : "");
      const model = (pick && (pick.provider || pick.model) ? pick.model : inst0.model).trim();
      const sendBody = {
        text,
        run: busy.run,
        session,
        workspace: selWs || undefined,
        persona: selPersona || undefined,
        provider: provider || undefined,
        model: model || undefined,
        attachments: attachments && attachments.length ? attachments : undefined,
      };
      // A dead client stream (iOS "Load failed", suspend, network switch) is
      // not a failed turn: the relay keeps running it. Re-attach to the same
      // run via /v1/runs/stream (it replays from the start) instead of
      // painting an error bubble; only real turn failures surface. A
      // visibility regain with a quiet stream forces the re-attach at once.
      // The relay pings every ~12s (surfaced as {type:"ping"}), so 45s of
      // total silence means the stream is dead, not a slow tool phase.
      const STREAM_IDLE_MS = 45_000;
      let replyBuf = "";
      let lastEventAt = Date.now();
      const kicker = new Kicker();
      const onVisible = () => {
        if (document.visibilityState === "visible" && Date.now() - lastEventAt > 15_000) {
          kicker.kick();
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      let outcome: "done" | "detached";
      try {
        outcome = await runResumableTurn({
          open: () => api.streamChat(inst0, sendBody),
          reattach: () => api.attachRun(inst0, { run: busy.run }),
          onEvent: (ev) => {
            lastEventAt = Date.now();
            if (ev.type === "delta" && ev.text) {
              replyBuf += ev.text;
              deltas.push(ev.text);
            } else if (ev.type === "status" && ev.text) {
              setStreamStatus(ev.text);
            } else if (ev.type === "trailer") {
              deltas.flush();
              sawTrailer = true;
              setChats((prev) =>
                mapChat(prev, selKey, chatId, (item) => ({
                  ...item,
                  session: ev.session || item.session,
                  messages: item.messages.map((m) =>
                    m.id === assistantId ? { ...m, elapsed_ms: Date.now() - started } : m
                  ),
                }))
              );
              if (ev.returncode && ev.returncode !== 0) {
                setStreamStatus(`turn exited ${ev.returncode}`);
              }
            }
          },
          onReset: () => {
            deltas.flush();
            replyBuf = "";
            lastEventAt = Date.now();
            setChats((prev) =>
              mapChat(prev, selKey, chatId, (item) => ({
                ...item,
                messages: item.messages.map((m) => (m.id === assistantId ? { ...m, content: "" } : m)),
              }))
            );
          },
          onStatus: (s) => setStreamStatus(s),
          idleMs: STREAM_IDLE_MS,
          maxReattach: 6,
          kicker,
          waitVisible: () =>
            document.visibilityState === "visible"
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  const h = () => {
                    if (document.visibilityState === "visible") {
                      document.removeEventListener("visibilitychange", h);
                      resolve();
                    }
                  };
                  document.addEventListener("visibilitychange", h);
                }),
        });
      } finally {
        document.removeEventListener("visibilitychange", onVisible);
      }
      deltas.flush();
      if (outcome === "detached") {
        // The run is no longer attachable (finished + reaped, relay restart,
        // or an old relay without /v1/runs/stream). The reconcile in
        // `finally` converges the bubble to the session history.
        setStreamStatus(null);
        return;
      }
      if (voiceSupported && voiceEnabled && replyBuf.trim() && typeof SpeechSynthesisUtterance !== "undefined") {
        try {
          window.speechSynthesis?.cancel();
          window.speechSynthesis?.speak(new SpeechSynthesisUtterance(replyBuf.trim()));
        } catch {}
      }
      setChats((prev) =>
        mapChat(prev, selKey, chatId, (item) => ({
          ...item,
          messages: item.messages.map((m) =>
            m.id === assistantId && !m.content ? { ...m, content: "(no reply)", elapsed_ms: Date.now() - started } : m
          ),
        }))
      );
    } catch (e: unknown) {
      deltas.flush();
      const message = e instanceof Error ? e.message : String(e);
      setChats((prev) =>
        mapChat(prev, selKey, chatId, (item) => ({
          ...item,
          messages: item.messages.map((m) =>
            m.id === assistantId ? { ...m, content: `Error executing turn: ${message}` } : m
          ),
        }))
      );
    } finally {
      deltaFlush.current = () => undefined;
      flushPersist();
      if (turnBusyRef.current?.instanceId === id && turnBusyRef.current.chatId === chatId) {
        turnBusyRef.current = null;
      }
      setTurnBusy((b) => (b?.instanceId === id && b.chatId === chatId ? null : b));
      setStreamStatus(null);
      if (document.hidden || !document.hasFocus()) {
        void notify("Klanker turn finished", inst0.name || inst0.id);
      }
      // A dead client stream (iOS "Load failed", suspend, reload) does not
      // mean the turn failed: the server may still be writing the reply into
      // the session. Reconcile so the bubbles converge to server truth.
      if (!sawTrailer && session) {
        void reconcileChat(inst0, selKey, chatId, selWs, selPersona, session, {
          evCache: evCache.current,
          applyToChat,
        }, true);
      }
      if (activeIdRef.current !== id) {
        setUnread((prev) => {
          if (prev.has(id) || activeIdRef.current === id) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }
    }
  };

  if (inst.auth !== "ok") {
    return <AuthGate auth={inst.auth} />;
  }

  return (
    <div
      data-kb={kbBox ? "open" : undefined}
      style={
        STANDALONE
          ? {
              // Constant absolute/translateZ layer inside the 100vh body so the
              // compositor layer is never recreated and both open and close
              // height transitions glide between idleH and kbBox.height.
              position: "absolute",
              height: `${kbBox ? kbBox.height : idleH}px`,
              top: 0,
              bottom: "auto",
              transform: "translateZ(0)",
            }
          : {
              height: `${kbBox ? kbBox.height : idleH}px`,
              top: `${kbBox ? kbBox.top : 0}px`,
              bottom: "auto",
            }
      }
      className="app-shell fixed left-0 right-0 flex bg-[#000000] text-white overflow-hidden font-sans"
    >
      {navOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/60"
          onClick={() => setNavOpen(false)}
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-50 transform transition-transform md:static md:z-auto md:transform-none ${
          navOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <KlankerList
          key={activeInstance?.id ?? "none"}
          instances={inst.instances}
          managedId={inst.managedId}
          activeId={activeInstance?.id ?? null}
          unread={unread}
          statuses={inst.herd}
          selWs={selWs}
          selPersona={selPersona}
          openChatId={openChat?.id ?? null}
          workspaces={tree.workspaces}
          personasOf={tree.personasOf}
          sessionRowsOf={tree.sessionRowsOf}
          onSelect={(i) => { selectInstance(i); setNavOpen(false); }}
          onExpandWs={tree.expandWs}
          onExpandPersona={tree.expandPersona}
          onSelectChat={(ws, p, id) => { selectChat(ws, p, id); setNavOpen(false); }}
          onNewChat={(ws, p) => { newChat(ws, p); setNavOpen(false); }}
          onDeleteChat={deleteChat}

          onInstanceSettings={(i) => { setInstanceSheetInst(i); setNavOpen(false); }}
          onWorkspaceSettings={(ws) => { setWsSettingsId(ws); setNavOpen(false); }}
          onDeleteWorkspace={async (ws) => {
            const inst0 = activeInstance;
            if (!inst0 || !(await dialogs.confirm(`Archive workspace "${ws}"? (restorable from trash)`, { danger: true }))) return;
            void api
              .deleteWorkspace(inst0, ws)
              .then(() => api.listWorkspaces(inst0))
              .then((rows) => {
                tree.setWorkspaces(rows);
                tree.setTreePersonas((prev) => {
                  const next = { ...prev };
                  delete next[ws];
                  return next;
                });
                if (selWs === ws) setSelWs(rows[0]?.id ?? "");
              })
              .catch((e) => setWsNote(`workspace: ${e instanceof Error ? e.message : e}`));
          }}
          onNewPersona={async (ws) => {
            const inst0 = activeInstance;
            const id = await dialogs.prompt(`new persona id in ${ws}`);
            if (!inst0 || !id?.trim()) return;
            void api
              .createPersona(inst0, ws, id.trim())
              .then(() => api.listPersonas(inst0, ws))
              .then((rows) => tree.setTreePersonas((prev) => ({ ...prev, [ws]: rows })))
              .catch((e) => setWsNote(`persona: ${e instanceof Error ? e.message : e}`));
          }}
          onDeletePersona={async (ws, persona) => {
            const inst0 = activeInstance;
            if (!inst0 || !(await dialogs.confirm(`Archive persona "${persona}"?`, { danger: true }))) return;
            void api
              .deletePersona(inst0, ws, persona)
              .then(() => api.listPersonas(inst0, ws))
              .then((rows) => tree.setTreePersonas((prev) => ({ ...prev, [ws]: rows })))
              .catch((e) => setWsNote(`persona: ${e instanceof Error ? e.message : e}`));
          }}
          onNewWorkspace={async () => {
            if (!activeInstance) return;
            const id = await dialogs.prompt("new workspace id");
            if (!id?.trim()) return;
            void api
              .createWorkspace(activeInstance, id.trim())
              .then((wsId) => {
                setSelWs(wsId);
                return api.listWorkspaces(activeInstance).then(tree.setWorkspaces);
              })
              .catch((e) => setWsNote(`workspace: ${e instanceof Error ? e.message : e}`));
          }}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header
          activeInstance={activeInstance}
          selWs={selWs}
          onOpenSettings={openSettings}
          onOpenManage={() => setManageOpen(true)}
          onOpenNav={() => setNavOpen(true)}
          onOpenPair={() => setPairOpen(true)}
          showStoreToggle={storeSupported}
          storeOpen={storeOpen}
          onToggleStore={() => setStoreOpen((o) => !o)}
          showVoiceToggle={voiceSupported}
          voiceEnabled={voiceEnabled}
          onToggleVoice={toggleVoice}
        />

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {activeInstance ? (
            <>
              {wsNote && (
                <div className="shrink-0 px-3 py-1 border-b border-[#262626] bg-[#0a0a0a] font-mono text-[11px] text-red-500 truncate">
                  {wsNote}
                </div>
              )}
              {relayCompat.note && (
                <div className="shrink-0 px-3 py-1 border-b border-[#262626] bg-[#0a0a0a] font-mono text-[11px] text-amber-500 truncate">
                  {relayCompat.note.compat.kind === "stale-local" && (
                    <>
                      relay {relayCompat.note.compat.version} &lt; required {MIN_RELAY} —{" "}
                      <button
                        onClick={() => void relayCompat.upgrade()}
                        disabled={relayCompat.upgrading}
                        className="underline hover:text-amber-300 disabled:opacity-50"
                      >
                        {relayCompat.upgrading ? "upgrading…" : "upgrade klanker"}
                      </button>{" "}
                      (restart relay to apply)
                    </>
                  )}
                  {relayCompat.note.compat.kind === "stale-remote" && (
                    <>relay {relayCompat.note.compat.version} &lt; required {MIN_RELAY} — upgrade on that host</>
                  )}
                  {relayCompat.note.compat.kind === "unknown" && (
                    <>relay version unknown — some features need a newer relay</>
                  )}
                </div>
              )}
              <div className="flex-1 flex min-h-0 overflow-hidden">
                <div className="flex-1 flex flex-col min-w-0 min-h-0">
                  <ChatConsole
                    key={`${activeInstance.id}:${openChat?.id ?? ""}`}
                    instance={activeInstance}
                    speakerName={tree.personasOf(selWs)?.find((p) => p.id === selPersona)?.name || selPersona || activeInstance.name}
                    messages={messages}
                    input={openChat?.input ?? ""}
                    onInput={(v) => {
                      if (!selKey) return;
                      setChats((prev) => {
                        const b = normBucket(prev[selKey] ?? EMPTY_BUCKET);
                        const open = b.items.find((i) => i.id === b.openId);
                        if (open) {
                          return {
                            ...prev,
                            [selKey]: { ...b, items: b.items.map((i) => (i.id === open.id ? { ...i, input: v } : i)) },
                          };
                        }
                        const id = crypto.randomUUID();
                        return {
                          ...prev,
                          [selKey]: { openId: id, items: [...b.items, { id, session: "", messages: [], draft: true, input: v }] },
                        };
                      });
                    }}
                    onSendMessage={handleSendMessage}
                    onClearMessages={() => {
                      if (!openChat) return;
                      const chatId = openChat.id;
                      setChats((prev) => mapChat(prev, selKey, chatId, (item) => ({ ...item, messages: [] })));
                    }}
                    onStop={handleStop}
                    isLoading={isLoadingTurn}
                    remoteActive={remoteActive}
                    streamStatus={streamStatus}
                    sessionLabel={`${selWs || "default"} · ${selPersona || "default"} · ${openChat?.session || "new"}`}
                    sendHold={sendHold}
                    providers={chatProviders}
                    pick={chatPicks[selKey]}
                    favorites={chatFavorites}
                    providersStale={providersStale}
                    onStar={(p, star) => {
                      if (activeInstance) {
                        void api
                          .starFavorite(activeInstance, p.provider, p.model, star)
                          .then(setChatFavorites)
                          .catch(() => {});
                      }
                    }}
                    onPick={(p) => {
                      setChatPicks((prev) => {
                        const next = { ...prev };
                        if (p.provider || p.model) next[selKey] = p;
                        else delete next[selKey];
                        return next;
                      });
                      // Session pick wins server-side; the ws pick stays the
                      // last-used seed for new chats.
                      if (activeInstance) {
                        void api
                          .setModelPick(activeInstance, selWs, p.provider || "", p.model || "", openChat?.session || "")
                          .catch(() => {});
                      }
                    }}
                    pending={approvals.pending}
                    deciding={approvals.deciding}
                    decideError={approvals.decideError}
                    onDecide={(allow) => void approvals.handleDecide(allow)}
                  />
                </div>
                {storeOpen && storeSupported && (
                  <WorkspacePane
                    instance={activeInstance}
                    workspaceId={selWs}
                    revision={storeRev}
                    onUnsupported={() => {
                      setStoreSupported(false);
                      setStoreOpen(false);
                    }}
                    onClose={() => setStoreOpen(false)}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[#525252] font-mono text-xs">
              Add a relay to get started.
            </div>
          )}
        </div>
      </div>

      <NewKlankerModal isOpen={isNewModalOpen} onClose={() => setIsNewModalOpen(false)} onSave={handleCreate} />
      {instanceSheetInst && (
        <InstanceSheet
          instance={inst.instances.find((i) => i.id === instanceSheetInst.id) ?? instanceSheetInst}
          status={inst.herd[instanceSheetInst.id] ?? null}
          onSave={handleSaveInstance}
          onDelete={(id) => {
            handleDeleteInstance(id);
            setInstanceSheetInst(null);
          }}
          onProvidersChanged={refreshProviders}
          activeWorkspace={selWs}
          onOpenSession={(ws, persona, session) => {
            setInstanceSheetInst(null);
            selectChat(ws, persona, session);
          }}
          onClose={() => setInstanceSheetInst(null)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          instance={activeInstance}
          workspace={selWs}
          persona={selPersona}
          instances={inst.instances}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
          onAddInstance={() => setIsNewModalOpen(true)}
          onEditInstance={(i) => setInstanceSheetInst(i)}
          onInstancesChanged={() => void inst.refreshInstances()}
        />
      )}
      {manageOpen && activeInstance && (
        <ManagePanel
          instance={activeInstance}
          workspace={selWs}
          onClose={() => setManageOpen(false)}
        />
      )}
      {wsSettingsId && activeInstance && (
        <WorkspaceSettingsModal
          instance={activeInstance}
          workspace={tree.workspaces.find((w) => w.id === wsSettingsId) ?? { id: wsSettingsId }}
          onSaved={(row) => {
            tree.setWorkspaces((tree.workspaces || []).map((w) => (w.id === row.id ? { ...w, ...row } : w)));
          }}
          onClose={() => setWsSettingsId(null)}
        />
      )}
      {pairOpen && activeInstance && (
        <PairModal instance={activeInstance} onClose={() => setPairOpen(false)} />
      )}
      <DialogHost />
    </div>
  );
}
export default App;
