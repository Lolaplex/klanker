import { useState, useEffect, useRef, useCallback } from "react";
import { Header } from "./components/Header";
import { KlankerList } from "./components/KlankerList";
import { ChatConsole } from "./components/ChatConsole";
import { ConfigPanel } from "./components/ConfigPanel";
import { NewKlankerModal } from "./components/NewKlankerModal";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  DesktopSettings,
  DiscoveredPeer,
  KlankerInstance,
  ProcessStatus,
  ChatMessage,
  PendingApproval,
} from "./types/klanker";
import { api } from "./services/api";
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
  const [rankedIds, setRankedIds] = useState<string[]>([]);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; label?: string }[]>([]);
  const [personas, setPersonas] = useState<{ id: string; name?: string }[]>([]);
  const [wsNote, setWsNote] = useState<string | null>(null);
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
  const bucket = activeInstance ? chats[activeInstance.id] : undefined;
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
    setChats((prev) => {
      if (prev[inst.id]) return prev;
      return { ...prev, [inst.id]: seedBucket(inst.session ?? "") };
    });
    setUnread((prev) => {
      if (!prev.has(inst.id)) return prev;
      const next = new Set(prev);
      next.delete(inst.id);
      return next;
    });
  }, []);

  const selectChat = (chatId: string) => {
    if (!activeInstance) return;
    const instanceId = activeInstance.id;
    setChats((prev) => {
      const current = prev[instanceId];
      if (!current || current.openId === chatId || !current.items.some((item) => item.id === chatId)) return prev;
      return { ...prev, [instanceId]: { ...current, openId: chatId } };
    });
  };

  const newChat = () => {
    if (!activeInstance) return;
    const instanceId = activeInstance.id;
    const chatId = crypto.randomUUID();
    setChats((prev) => {
      const current = prev[instanceId] ?? seedBucket(activeInstance.session ?? "");
      return {
        ...prev,
        [instanceId]: { openId: chatId, items: [...current.items, { id: chatId, session: mintSessionId(), messages: [] }] },
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

  // Boot: instances + settings
  useEffect(() => {
    void (async () => {
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

  // Workspace + persona lists for the active instance
  useEffect(() => {
    setPending(null);
    setDecideError(null);
    setDeciding(false);
    setWorkspaces([]);
    setPersonas([]);
    setWsNote(null);
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    let stop = false;
    void (async () => {
      try {
        const rows = await api.listWorkspaces(inst);
        if (stop) return;
        setWorkspaces(rows);
      } catch (e) {
        if (!stop) setWsNote(`workspaces: ${e instanceof Error ? e.message : e}`);
      }
      try {
        const ws = inst.workspace.trim();
        const rows = await api.listPersonas(inst, ws);
        if (stop) return;
        setPersonas(rows);
      } catch (e) {
        if (!stop) setWsNote(`personas: ${e instanceof Error ? e.message : e}`);
      }
    })();
    return () => {
      stop = true;
    };
  }, [activeInstance?.id, activeInstance?.workspace, status?.state]);

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

  const handleAddDiscovered = (peer: DiscoveredPeer) => {
    const now = new Date().toISOString();
    void handleSaveInstance({
      id: crypto.randomUUID(),
      name: peer.hostname,
      slug: peer.hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      role: "remote",
      provider: "",
      model: "",
      workspace: "",
      lock_workspace: false,
      port: 0,
      system_prompt: "",
      kind: "remote",
      endpoint: { base_url: peer.endpoint },
      tailscale: { node: peer.hostname, fqdn: peer.fqdn },
      created_at: now,
      updated_at: now,
    });
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
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
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

  const handleSendMessage = async (text: string) => {
    const inst = activeInstance;
    if (!inst) return;
    const id = inst.id;
    if (turnBusyRef.current?.instanceId === id) return;
    const current = chatsRef.current[id];
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
      mapChat(prev, id, chatId, (item) => ({ ...item, messages: [...item.messages, userMessage, assistantMessage] }))
    );
    const busy: TurnBusy = { instanceId: id, chatId, run: crypto.randomUUID().replace(/-/g, "") };
    turnBusyRef.current = busy;
    setTurnBusy(busy);
    const started = Date.now();

    const appendStatus = (line: string) => {
      setChats((prev) =>
        mapChat(prev, id, chatId, (item) => ({
          ...item,
          messages: [
            ...item.messages,
            { id: crypto.randomUUID(), role: "system", content: line, timestamp: new Date().toISOString() },
          ],
        }))
      );
    };

    try {
      const provider = choiceOf(inst) === "inherit" ? "" : inst.provider.trim();
      const stream = api.streamChat(inst, {
        text,
        run: busy.run,
        session: session || undefined,
        workspace: inst.workspace.trim() || undefined,
        persona: (inst.persona || "").trim() || undefined,
        provider: provider || undefined,
      });
      for await (const ev of stream) {
        if (ev.type === "delta" && ev.text) {
          const piece = ev.text;
          setChats((prev) =>
            mapChat(prev, id, chatId, (item) => ({
              ...item,
              messages: item.messages.map((m) => (m.id === assistantId ? { ...m, content: m.content + piece } : m)),
            }))
          );
        } else if (ev.type === "status" && ev.text) {
          appendStatus(ev.text);
        } else if (ev.type === "error") {
          throw new Error(ev.text || "turn failed");
        } else if (ev.type === "trailer") {
          setChats((prev) =>
            mapChat(prev, id, chatId, (item) => ({
              ...item,
              session: ev.session || item.session,
              messages: item.messages.map((m) =>
                m.id === assistantId ? { ...m, elapsed_ms: Date.now() - started } : m
              ),
            }))
          );
          if (ev.returncode && ev.returncode !== 0) {
            appendStatus(`turn exited ${ev.returncode}`);
          }
        }
      }
      setChats((prev) =>
        mapChat(prev, id, chatId, (item) => ({
          ...item,
          messages: item.messages.map((m) =>
            m.id === assistantId && !m.content ? { ...m, content: "(no reply)", elapsed_ms: Date.now() - started } : m
          ),
        }))
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setChats((prev) =>
        mapChat(prev, id, chatId, (item) => ({
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

  return (
    <div className="h-dvh w-screen flex bg-[#000000] text-white overflow-hidden select-none font-sans">
      <KlankerList
        instances={instances}
        activeId={activeInstance?.id ?? null}
        unread={unread}
        statuses={herd}
        onSelect={selectInstance}
        onNew={() => setIsNewModalOpen(true)}
        onAddDiscovered={handleAddDiscovered}
        chats={bucket?.items ?? []}
        openChatId={openChat?.id ?? null}
        onSelectChat={selectChat}
        onNewChat={newChat}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header activeInstance={activeInstance} onOpenSettings={openSettings} />

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {activeInstance ? (
            <>
              <ChatConsole
                key={`${activeInstance.id}:${openChat?.id ?? ""}`}
                instance={activeInstance}
                messages={messages}
                onSendMessage={handleSendMessage}
                onClearMessages={() => {
                  if (!openChat) return;
                  const instanceId = activeInstance.id;
                  const chatId = openChat.id;
                  setChats((prev) => mapChat(prev, instanceId, chatId, (item) => ({ ...item, messages: [] })));
                }}
                onStop={handleStop}
                isLoading={isLoadingTurn}
                sendHold={sendHold}
                pending={pending}
                deciding={deciding}
                decideError={decideError}
                onDecide={(allow) => void handleDecide(allow)}
              />
              <ConfigPanel
                instance={activeInstance}
                status={status}
                settings={settings}
                rankedIds={rankedIds}
                modelNote={modelNote}
                loadingModels={loadingModels}
                onNeedModels={ensureModels}
                onSave={handleSaveInstance}
                onStar={(provider, id) => {
                  void updateSettings((current) => toggleFavorite(current, provider, id));
                }}
                onDelete={handleDeleteInstance}
                workspaces={workspaces}
                personas={personas}
                wsNote={wsNote}
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
