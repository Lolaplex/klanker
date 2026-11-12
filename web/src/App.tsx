import { useState, useEffect, useRef, useCallback } from "react";
import { Header } from "./components/Header";
import { KlankerList } from "./components/KlankerList";
import { ChatConsole } from "./components/ChatConsole";
import { HostSheet } from "./components/HostSheet";
import { NewKlankerModal } from "./components/NewKlankerModal";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  DesktopSettings,
  KlankerInstance,
  ProcessStatus,
  ChatMessage,
  PendingApproval,
} from "./types/klanker";
import { api, localInstance } from "./services/api";
import type { PersonaRow, SessionRow } from "./components/KlankerList";
import {
  choiceOf,
  DEFAULT_SETTINGS,
  fetchOpenRouterModels,
  ModelProvider,
  normalizeLists,
  rememberModel,
  toggleFavorite,
  windowKind,
} from "./openrouterModels";

function loadedSettings(loaded: DesktopSettings): DesktopSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...loaded,
    openrouter_api_key: "",
    openrouter_key_set: Boolean(loaded.openrouter_key_set || loaded.openrouter_api_key),
    recent_models: normalizeLists(loaded.recent_models, 8),
    favorites: normalizeLists(loaded.favorites, 0),
  };
}

interface DeskChat {
  id: string;
  session: string;
  messages: ChatMessage[];
}

interface ChatBucket {
  openId: string;
  items: DeskChat[];
}

interface TurnBusy {
  instanceId: string;
  chatId: string;
  run: string;
}

function mintSessionId(): string {
  return `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function seedBucket(session: string): ChatBucket {
  const id = crypto.randomUUID();
  return { openId: id, items: [{ id, session, messages: [] }] };
}

const chatsKey = (sel: string) => `klanker.chats.${sel}`;

function loadBucket(sel: string): ChatBucket | null {
  try {
    const raw = localStorage.getItem(chatsKey(sel));
    if (!raw) return null;
    const b = JSON.parse(raw) as ChatBucket;
    if (!Array.isArray(b?.items) || b.items.length === 0) return null;
    return { openId: b.items.some((i) => i.id === b.openId) ? b.openId : b.items[0].id, items: b.items };
  } catch {
    return null;
  }
}

function saveBucket(sel: string, bucket: ChatBucket): void {
  try {
    const items = bucket.items.slice(-30).map((i) => ({ ...i, messages: i.messages.slice(-300) }));
    localStorage.setItem(chatsKey(sel), JSON.stringify({ ...bucket, items }));
  } catch {}
}

function mapChat(
  prev: Record<string, ChatBucket>,
  instanceId: string,
  chatId: string,
  fn: (chat: DeskChat) => DeskChat
): Record<string, ChatBucket> {
  const bucket = prev[instanceId];
  if (!bucket) return prev;
  return {
    ...prev,
    [instanceId]: {
      ...bucket,
      items: bucket.items.map((item) => (item.id === chatId ? fn(item) : item)),
    },
  };
}

export function App() {
  const [instances, setInstances] = useState<KlankerInstance[]>([]);
  const [activeInstance, setActiveInstance] = useState<KlankerInstance | null>(null);
  const [herd, setHerd] = useState<Record<string, ProcessStatus>>({});
  const [chats, setChats] = useState<Record<string, ChatBucket>>({});
  const [turnBusy, setTurnBusy] = useState<TurnBusy | null>(null);
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hostSheetInst, setHostSheetInst] = useState<KlankerInstance | null>(null);
  const [rankedIds, setRankedIds] = useState<string[]>([]);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; label?: string }[]>([]);
  const [selWs, setSelWs] = useState("");
  const [selPersona, setSelPersona] = useState("");
  const [treePersonas, setTreePersonas] = useState<Record<string, PersonaRow[]>>({});
  const [serverSessions, setServerSessions] = useState<Record<string, { id: string }[]>>({});
  const [wsNote, setWsNote] = useState<string | null>(null);
  // Same-origin relay auth gate: "checking" until /v1/auth/status answers,
  // "needed" shows the token prompt, "ok" runs the dashboard.
  const [auth, setAuth] = useState<"checking" | "needed" | "ok">("checking");
  const [loginToken, setLoginToken] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  const activeIdRef = useRef<string | null>(null);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const turnBusyRef = useRef(turnBusy);
  turnBusyRef.current = turnBusy;
  const settingsRef = useRef(settings);
  const settingsWrite = useRef(Promise.resolve());
  const modelsFetched = useRef(false);
  const saveGen = useRef(0);
  const pollSeq = useRef(0);
  const herdKey = instances
    .map((inst) => `${inst.id}|${inst.updated_at}|${inst.endpoint?.base_url ?? inst.base_url ?? ""}|${inst.secret ? 1 : 0}`)
    .join("\n");
  const status = activeInstance ? herd[activeInstance.id] ?? null : null;
  const selKey = activeInstance ? `${activeInstance.id} ${selWs} ${selPersona}` : "";
  const bucket = selKey ? chats[selKey] : undefined;
  const openChat = bucket?.items.find((item) => item.id === bucket.openId) ?? bucket?.items[0] ?? null;
  const messages = openChat?.messages ?? [];
  const isLoadingTurn = Boolean(
    turnBusy && openChat && turnBusy.instanceId === activeInstance?.id && turnBusy.chatId === openChat.id
  );
  const sendHold = Boolean(
    turnBusy && activeInstance && turnBusy.instanceId === activeInstance.id && turnBusy.chatId !== openChat?.id
  );

  const selectInstance = useCallback((inst: KlankerInstance | null) => {
    activeIdRef.current = inst?.id ?? null;
    api.saveActiveId(inst?.id ?? null);
    setActiveInstance(inst);
    if (!inst) return;
    setTreePersonas({});
    setServerSessions({});
    setUnread((prev) => {
      if (!prev.has(inst.id)) return prev;
      const next = new Set(prev);
      next.delete(inst.id);
      return next;
    });
    setSelWs(inst.workspace.trim());
    setSelPersona((inst.persona || "").trim() || "default");
  }, []);

  const selectChat = (ws: string, persona: string, chatId: string) => {
    if (!activeInstance) return;
    const key = `${activeInstance.id} ${ws} ${persona}`;
    setSelWs(ws);
    setSelPersona(persona);
    setChats((prev) => {
      const current = prev[key] ?? loadBucket(key) ?? seedBucket("");
      const hit = current.items.find((i) => i.id === chatId || i.session === chatId);
      const items = hit
        ? current.items
        : [...current.items, { id: crypto.randomUUID(), session: chatId, messages: [] }];
      const openId = hit ? hit.id : items[items.length - 1].id;
      if (current.openId === openId && items === current.items) return prev;
      return { ...prev, [key]: { openId, items } };
    });
  };

  const deleteChat = (ws: string, persona: string, row: SessionRow) => {
    if (!activeInstance) return;
    const key = `${activeInstance.id} ${ws} ${persona}`;
    const inst = activeInstance;
    if (!row.pending) {
      void api
        .deleteSession(inst, ws, persona, row.session)
        .then(() => setServerSessions((prev) => ({
          ...prev,
          [`${ws} ${persona}`]: (prev[`${ws} ${persona}`] || []).filter((s) => s.id !== row.session),
        })))
        .catch((e) => setWsNote(`delete: ${e instanceof Error ? e.message : e}`));
    }
    setChats((prev) => {
      const current = prev[key];
      if (!current) return prev;
      const items = current.items.filter((i) => i.id !== row.chatId && i.session !== row.session);
      if (items.length === 0) return { ...prev, [key]: { openId: "", items: [] } };
      const openId = items.some((i) => i.id === current.openId) ? current.openId : items[items.length - 1].id;
      return { ...prev, [key]: { openId, items } };
    });
  };

  const newChat = (ws: string, persona: string) => {
    if (!activeInstance) return;
    const key = `${activeInstance.id} ${ws} ${persona}`;
    const chatId = crypto.randomUUID();
    setSelWs(ws);
    setSelPersona(persona);
    setChats((prev) => {
      const current = prev[key] ?? loadBucket(key) ?? { openId: "", items: [] };
      return {
        ...prev,
        [key]: { openId: chatId, items: [...current.items, { id: chatId, session: mintSessionId(), messages: [] }] },
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

  // Boot: same-origin auth check first, then instances + settings
  useEffect(() => {
    void (async () => {
      try {
        const st = await api.authStatus(localInstance());
        if (st.enabled && !st.authenticated) {
          setAuth("needed");
          return;
        }
      } catch {
        // Relay unreachable or older relay without /v1/auth/*: proceed anyway.
      }
      setAuth("ok");
      try {
        const list = await api.listKlankers();
        setInstances(list);
        const remembered = api.loadActiveId();
        const initial = list.find((i) => i.id === remembered) ?? list[0] ?? null;
        if (initial) selectInstance(initial);
      } catch (e) {
        console.error("Failed to load instances:", e);
      }
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
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist chats per instance (localStorage)
  useEffect(() => {
    for (const [id, bucket] of Object.entries(chats)) saveBucket(id, bucket);
  }, [chats]);

  // Health poll every 8s
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      for (const inst of instancesRef.current) {
        const st = await api.getGatewayStatus(inst);
        if (stop) return;
        setHerd((prev) => ({ ...prev, [inst.id]: st }));
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 8_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [herdKey]);

  // Workspace list for the active instance
  useEffect(() => {
    setPending(null);
    setDecideError(null);
    setDeciding(false);
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
      } catch (e) {
        if (!stop) setWsNote(`workspaces: ${e instanceof Error ? e.message : e}`);
      }
    })();
    return () => {
      stop = true;
    };
  }, [activeInstance?.id, status?.state]);

  // Tree lazy loaders
  const expandWs = (ws: string) => {
    const inst = activeInstance;
    if (!inst || treePersonas[ws]) return;
    void api
      .listPersonas(inst, ws)
      .then((rows) => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: rows })))
      .catch(() => setTreePersonas((prev) => (prev[ws] ? prev : { ...prev, [ws]: [] })));
  };

  const expandPersona = (ws: string, persona: string) => {
    const inst = activeInstance;
    if (!inst) return;
    const key = `${ws} ${persona}`;
    void api
      .listSessions(inst, ws, persona)
      .then((rows) =>
        setServerSessions((prev) => ({ ...prev, [key]: rows.filter((s) => s.id) }))
      )
      .catch(() => setServerSessions((prev) => (prev[key] ? prev : { ...prev, [key]: [] })));
  };

  const personasOf = (ws: string): PersonaRow[] | undefined => treePersonas[ws];

  const sessionRowsOf = (ws: string, persona: string): SessionRow[] | undefined => {
    const key = `${activeInstance?.id} ${ws} ${persona}`;
    const b = chats[key];
    const server = serverSessions[`${ws} ${persona}`];
    if (!b && server === undefined) return undefined;
    const localRows: SessionRow[] = (b?.items ?? []).map((i) => {
      const first = i.messages.find((m) => m.role === "user")?.content?.trim();
      return {
        chatId: i.id,
        session: i.session,
        label: first ? (first.length > 22 ? `${first.slice(0, 22)}…` : first) : i.session || "new chat",
        pending: !server?.some((s) => s.id === i.session),
      };
    });
    const covered = new Set(localRows.map((r) => r.session));
    const remoteRows: SessionRow[] = (server ?? [])
      .filter((s) => !covered.has(s.id))
      .map((s) => ({ chatId: s.id, session: s.id, label: s.id, pending: false }));
    return [...localRows, ...remoteRows];
  };

  // Session history: restore message bubbles from trace events when a chat
  // with a pinned session is opened and has no local messages yet.
  const historyTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    const inst = activeInstance;
    const chat = openChat;
    if (!inst || !chat || !chat.session || chat.messages.length > 0) return;
    if (!selWs || !selPersona) return;
    if (historyTried.current.has(chat.id)) return;
    historyTried.current.add(chat.id);
    const ws = selWs;
    const persona = selPersona;
    const key = selKey;
    const chatId = chat.id;
    void (async () => {
      const events = await api.sessionEvents(inst, ws, persona, chat.session);
      if (!events) return;
      const restored: ChatMessage[] = events
        .filter((e) => e?.type === "message" && e?.metadata?.content)
        .map((e) => ({
          id: crypto.randomUUID(),
          role: e.metadata.role === "user" ? "user" : "klanker",
          content: String(e.metadata.content),
          timestamp: e.ts || new Date().toISOString(),
        }));
      if (restored.length === 0) return;
      setChats((prev) =>
        mapChat(prev, key, chatId, (item) =>
          item.messages.length > 0 ? item : { ...item, messages: restored }
        )
      );
    })();
  }, [activeInstance, openChat?.id, openChat?.session, selWs, selPersona]);

  // Approvals poll
  useEffect(() => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    let stop = false;
    const tick = async () => {
      const mine = ++pollSeq.current;
      try {
        const next = await api.pendingApproval(inst);
        if (!stop && mine === pollSeq.current) setPending(next);
      } catch {
        if (!stop && mine === pollSeq.current) setPending(null);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [activeInstance?.id, status?.state]);

  const handleDecide = async (allow: boolean) => {
    if (!activeInstance || !pending || deciding) return;
    const inst = activeInstance;
    const approvalId = pending.id;
    setDeciding(true);
    setDecideError(null);
    try {
      await api.resolveApproval(inst, approvalId, allow);
      pollSeq.current += 1;
      if (activeIdRef.current === inst.id) setPending(null);
    } catch (e: unknown) {
      if (activeIdRef.current === inst.id) {
        setDecideError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setDeciding(false);
    }
  };

  const handleSaveInstance = async (inst: KlankerInstance) => {
    const gen = ++saveGen.current;
    try {
      const saved = await api.saveKlanker(inst);
      if (gen !== saveGen.current) return;
      setInstances((prevList) => {
        const idx = prevList.findIndex((i) => i.id === saved.id);
        if (idx >= 0) {
          const next = [...prevList];
          next[idx] = saved;
          return next;
        }
        return [...prevList, saved];
      });
      if (activeIdRef.current === saved.id) setActiveInstance(saved);
      const provider = saved.provider.trim().toLowerCase() as ModelProvider;
      const model = provider === "lmstudio" || provider === "openrouter" ? saved.model.trim() : "";
      if (model) {
        await updateSettings((current) => rememberModel(current, provider, model));
      }
    } catch (e) {
      console.error("Failed to save instance:", e);
    }
  };

  const ensureModels = useCallback(() => {
    if (modelsFetched.current) return;
    modelsFetched.current = true;
    setLoadingModels(true);
    void fetchOpenRouterModels()
      .then((result) => {
        setRankedIds(result.field ? result.ids : []);
        setModelNote(result.error);
      })
      .finally(() => setLoadingModels(false));
  }, []);

  const openSettings = () => {
    setSettingsOpen(true);
    ensureModels();
  };

  const handleSaveSettings = async (next: DesktopSettings) => {
    const provider: ModelProvider | "echo" =
      next.provider === "lmstudio" || next.provider === "openrouter" ? next.provider : "echo";
    try {
      await updateSettings((current) => {
        const merged: DesktopSettings = {
          ...current,
          provider,
          model: provider === "echo" ? "" : next.model.trim(),
          lmstudio_base_url: next.lmstudio_base_url.trim() || current.lmstudio_base_url,
          openrouter_api_key: next.openrouter_api_key.trim(),
          openrouter_key_set: Boolean(next.openrouter_api_key.trim()) || current.openrouter_key_set,
        };
        return provider === "echo" ? merged : rememberModel(merged, provider, merged.model);
      });
      setSettingsOpen(false);
    } catch (e) {
      console.error("Failed to save settings", e);
    }
  };

  const rememberTurnModel = (inst: KlankerInstance) => {
    const choice = choiceOf(inst);
    const kind = choice === "inherit" ? windowKind(settingsRef.current) : choice;
    if (kind !== "lmstudio" && kind !== "openrouter") return;
    const model = (choice === "inherit" ? inst.model.trim() || settingsRef.current.model : inst.model).trim();
    if (!model) return;
    void updateSettings((current) => rememberModel(current, kind, model));
  };

  const handleCreate = (draft: KlankerInstance) => {
    void handleSaveInstance({ ...draft, provider: "inherit" });
  };


  const handleDeleteInstance = async (id: string) => {
    try {
      await api.deleteKlanker(id);
      const remaining = instances.filter((i) => i.id !== id);
      setInstances(remaining);
      if (activeInstance?.id === id) {
        selectInstance(remaining[0] ?? null);
      }
      setUnread((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setHerd((prev) => {
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
    const inst = instancesRef.current.find((i) => i.id === busy.instanceId);
    if (inst) void api.stopRun(inst, busy.run).catch(() => undefined);
  };

  const handleSendMessage = async (text: string, attachments?: { data: string; mime?: string; name?: string }[]) => {
    const inst = activeInstance;
    if (!inst) return;
    const id = inst.id;
    if (turnBusyRef.current?.instanceId === id) return;
    const current = chatsRef.current[selKey];
    const chat = current?.items.find((item) => item.id === current.openId) ?? current?.items[0];
    if (!chat) return;
    const chatId = chat.id;
    const session = chat.session;
    rememberTurnModel(inst);

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "klanker",
      content: "",
      timestamp: new Date().toISOString(),
    };
    setChats((prev) =>
      mapChat(prev, selKey, chatId, (item) => ({ ...item, messages: [...item.messages, userMessage, assistantMessage] }))
    );
    const busy: TurnBusy = { instanceId: id, chatId, run: crypto.randomUUID().replace(/-/g, "") };
    turnBusyRef.current = busy;
    setTurnBusy(busy);
    const started = Date.now();

    setStreamStatus(null);

    try {
      const choice = choiceOf(inst);
      const provider = choice === "inherit" ? "" : inst.provider.trim();
      const model = (choice === "inherit" ? inst.model.trim() || settingsRef.current.model : inst.model).trim();
      const stream = api.streamChat(inst, {
        text,
        run: busy.run,
        session: session || undefined,
        workspace: selWs || undefined,
        persona: selPersona || undefined,
        provider: provider || undefined,
        model: model || undefined,
        attachments: attachments && attachments.length ? attachments : undefined,
      });
      for await (const ev of stream) {
        if (ev.type === "delta" && ev.text) {
          const piece = ev.text;
          setChats((prev) =>
            mapChat(prev, selKey, chatId, (item) => ({
              ...item,
              messages: item.messages.map((m) => (m.id === assistantId ? { ...m, content: m.content + piece } : m)),
            }))
          );
        } else if (ev.type === "status" && ev.text) {
          setStreamStatus(ev.text);
        } else if (ev.type === "error") {
          throw new Error(ev.text || "turn failed");
        } else if (ev.type === "trailer") {
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
      if (turnBusyRef.current?.instanceId === id && turnBusyRef.current.chatId === chatId) {
        turnBusyRef.current = null;
      }
      setTurnBusy((b) => (b?.instanceId === id && b.chatId === chatId ? null : b));
      setStreamStatus(null);
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

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginBusy || !loginToken.trim()) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await api.login(localInstance(), loginToken.trim());
      window.location.reload();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
      setLoginBusy(false);
    }
  };

  if (auth !== "ok") {
    return (
      <div className="h-dvh w-screen flex items-center justify-center bg-[#000000] text-white font-sans">
        {auth === "needed" ? (
          <form onSubmit={submitLogin} className="w-72 flex flex-col gap-3 font-mono text-xs">
            <div className="text-[#a3a3a3] tracking-widest uppercase">KLANKER</div>
            <input
              type="password"
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
              placeholder="relay web token"
              autoFocus
              className="bg-[#0a0a0a] border border-[#262626] px-3 py-2 outline-none focus:border-[#525252]"
            />
            {loginError && <div className="text-red-500">{loginError}</div>}
            <button
              type="submit"
              disabled={loginBusy}
              className="border border-[#262626] px-3 py-2 hover:bg-[#171717] disabled:opacity-50"
            >
              {loginBusy ? "..." : "unlock"}
            </button>
          </form>
        ) : (
          <div className="text-[#525252] font-mono text-xs">…</div>
        )}
      </div>
    );
  }

  return (
    <div className="h-dvh w-screen flex bg-[#000000] text-white overflow-hidden select-none font-sans">
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
          instances={instances}
          activeId={activeInstance?.id ?? null}
          unread={unread}
          statuses={herd}
          selWs={selWs}
          selPersona={selPersona}
          openChatId={openChat?.id ?? null}
          workspaces={workspaces}
          personasOf={personasOf}
          sessionRowsOf={sessionRowsOf}
          onSelect={(inst) => { selectInstance(inst); setNavOpen(false); }}
          onExpandWs={expandWs}
          onExpandPersona={expandPersona}
          onSelectChat={(ws, p, id) => { selectChat(ws, p, id); setNavOpen(false); }}
          onNewChat={(ws, p) => { newChat(ws, p); setNavOpen(false); }}
          onDeleteChat={deleteChat}
          onNewHost={() => { setIsNewModalOpen(true); setNavOpen(false); }}
          onHostSettings={(inst) => { setHostSheetInst(inst); setNavOpen(false); }}
          onDeleteWorkspace={(ws) => {
            const inst = activeInstance;
            if (!inst || !window.confirm(`Archive workspace "${ws}"? (restorable from trash)`)) return;
            void api
              .deleteWorkspace(inst, ws)
              .then(() => api.listWorkspaces(inst))
              .then((rows) => {
                setWorkspaces(rows);
                setTreePersonas((prev) => {
                  const next = { ...prev };
                  delete next[ws];
                  return next;
                });
                if (selWs === ws) setSelWs(rows[0]?.id ?? "");
              })
              .catch((e) => setWsNote(`workspace: ${e instanceof Error ? e.message : e}`));
          }}
          onNewPersona={(ws) => {
            const inst = activeInstance;
            const id = window.prompt(`new persona id in ${ws}`);
            if (!inst || !id?.trim()) return;
            void api
              .createPersona(inst, ws, id.trim())
              .then(() => api.listPersonas(inst, ws))
              .then((rows) => setTreePersonas((prev) => ({ ...prev, [ws]: rows })))
              .catch((e) => setWsNote(`persona: ${e instanceof Error ? e.message : e}`));
          }}
          onDeletePersona={(ws, persona) => {
            const inst = activeInstance;
            if (!inst || !window.confirm(`Archive persona "${persona}"?`)) return;
            void api
              .deletePersona(inst, ws, persona)
              .then(() => api.listPersonas(inst, ws))
              .then((rows) => setTreePersonas((prev) => ({ ...prev, [ws]: rows })))
              .catch((e) => setWsNote(`persona: ${e instanceof Error ? e.message : e}`));
          }}
          onNewWorkspace={() => {
            if (!activeInstance) return;
            const id = window.prompt("new workspace id");
            if (!id?.trim()) return;
            void api
              .createWorkspace(activeInstance, id.trim())
              .then((wsId) => {
                setSelWs(wsId);
                return api.listWorkspaces(activeInstance).then(setWorkspaces);
              })
              .catch((e) => setWsNote(`workspace: ${e instanceof Error ? e.message : e}`));
          }}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header activeInstance={activeInstance} onOpenSettings={openSettings} onOpenNav={() => setNavOpen(true)} />

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {activeInstance ? (
            <>
              {wsNote && (
                <div className="shrink-0 px-3 py-1 border-b border-[#262626] bg-[#0a0a0a] font-mono text-[11px] text-red-500 truncate">
                  {wsNote}
                </div>
              )}
              <ChatConsole
                key={`${activeInstance.id}:${openChat?.id ?? ""}`}
                instance={activeInstance}
                messages={messages}
                onSendMessage={handleSendMessage}
                onClearMessages={() => {
                  if (!openChat) return;
                  const chatId = openChat.id;
                  setChats((prev) => mapChat(prev, selKey, chatId, (item) => ({ ...item, messages: [] })));
                }}
                onStop={handleStop}
                isLoading={isLoadingTurn}
                streamStatus={streamStatus}
                sessionLabel={`${selWs || "default"} · ${selPersona || "default"} · ${openChat?.session || "new"}`}
                sendHold={sendHold}
                pending={pending}
                deciding={deciding}
                decideError={decideError}
                onDecide={(allow) => void handleDecide(allow)}
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[#525252] font-mono text-xs">
              Add a relay to get started.
            </div>
          )}
        </div>
      </div>

      <NewKlankerModal isOpen={isNewModalOpen} onClose={() => setIsNewModalOpen(false)} onSave={handleCreate} />
      {hostSheetInst && (
        <HostSheet
          instance={instances.find((i) => i.id === hostSheetInst.id) ?? hostSheetInst}
          status={herd[hostSheetInst.id] ?? null}
          settings={settings}
          rankedIds={rankedIds}
          modelNote={modelNote}
          loadingModels={loadingModels}
          onNeedModels={ensureModels}
          onSave={handleSaveInstance}
          onStar={(provider, id) => {
            void updateSettings((current) => toggleFavorite(current, provider, id));
          }}
          onDelete={(id) => {
            handleDeleteInstance(id);
            setHostSheetInst(null);
          }}
          onClose={() => setHostSheetInst(null)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          rankedIds={rankedIds}
          modelNote={modelNote}
          loadingModels={loadingModels}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
          onStar={(provider, id) => {
            void updateSettings((current) => toggleFavorite(current, provider, id));
          }}
        />
      )}
    </div>
  );
}
export default App;
