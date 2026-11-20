import { useState, useEffect, useRef, useCallback } from "react";
import { Header } from "./components/Header";
import { KlankerList } from "./components/KlankerList";
import { ChatConsole } from "./components/ChatConsole";
import { InstanceSheet } from "./components/InstanceSheet";
import { NewKlankerModal } from "./components/NewKlankerModal";
import { SettingsPanel } from "./components/SettingsPanel";
import { ManagePanel } from "./components/ManagePanel";
import {
  DesktopSettings,
  KlankerInstance,
  ProcessStatus,
  ChatMessage,
  PendingApproval,
} from "./types/klanker";
import { api, caps, localInstance, notify, rememberSecret, secretAccount } from "./services/api";
import { dialogs } from "./services/dialogs";
import { DialogHost } from "./components/DialogHost";
import { focusWithoutScroll } from "./chatUi";
import { createDeltaQueue, diffChatBuckets } from "./chatPersist";
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
  /** Unsent "new chat": no session, no sidebar row, at most one per bucket. */
  draft?: boolean;
  /** Persisted composer text (survives chat switches and reloads). */
  input?: string;
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

function clipTitle(text: string): string {
  const t = text.trim();
  return t.length > 22 ? `${t.slice(0, 22)}…` : t;
}

const EMPTY_BUCKET: ChatBucket = { openId: "", items: [] };

// Installed iOS PWA: the layout viewport stops 47px above the screen bottom
// (see index.css). The idle shell then lives in document flow at 100vh.
const STANDALONE =
  typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;

/** Merge legacy/dup drafts into one, drop draft flags off real chats. */
function normBucket(b: ChatBucket): ChatBucket {
  const items: DeskChat[] = [];
  let draft: DeskChat | null = null;
  for (const i of b.items) {
    if (!i.draft && i.session) {
      items.push({ ...i, draft: false });
      continue;
    }
    const d: DeskChat = { ...i, session: "", draft: true };
    draft = draft === null ? d : { ...(draft as DeskChat), input: draft.input || d.input };
  }
  const all = draft ? [...items, draft] : items;
  const openId = all.some((i) => i.id === b.openId) ? b.openId : (all[all.length - 1]?.id ?? "");
  return { openId, items: all };
}

const chatsKey = (sel: string) => `klanker.chats.${sel}`;
const selStoreKey = (instId: string) => `klanker.sel.${instId}`;
const LS_TITLES = "klanker.titles";

function loadBucket(sel: string): ChatBucket | null {
  try {
    const raw = localStorage.getItem(chatsKey(sel));
    if (!raw) return null;
    const b = JSON.parse(raw) as ChatBucket;
    if (!Array.isArray(b?.items) || b.items.length === 0) return null;
    return normBucket(b);
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
  // The one relay this app spawned/attached — sidebar shows it as the single
  // local instance; every other instance is a remote or a legacy local.
  const [managedId, setManagedId] = useState<string | null>(null);
  const [activeInstance, setActiveInstance] = useState<KlankerInstance | null>(null);
  const [herd, setHerd] = useState<Record<string, ProcessStatus>>({});
  const [chats, setChats] = useState<Record<string, ChatBucket>>({});
  const [turnBusy, setTurnBusy] = useState<TurnBusy | null>(null);
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [instanceSheetInst, setInstanceSheetInst] = useState<KlankerInstance | null>(null);
  const [rankedIds, setRankedIds] = useState<string[]>([]);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; label?: string }[]>([]);
  const [selWs, setSelWs] = useState("");
  // Per-chat model override, keyed by "<inst> <ws> <persona>"; absent = instance default.
  const [chatModels, setChatModels] = useState<Record<string, string>>({});
  const [selPersona, setSelPersona] = useState("");
  const [treePersonas, setTreePersonas] = useState<Record<string, PersonaRow[]>>({});
  const [serverSessions, setServerSessions] = useState<Record<string, { id: string; goal?: string }[]>>({});
  const [wsNote, setWsNote] = useState<string | null>(null);
  // Session titles keyed "inst ws persona session": prefetched eagerly, cached in localStorage.
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_TITLES) || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  // Same-origin relay auth gate: "checking" until /v1/auth/status answers,
  // "needed" shows the token prompt, "ok" runs the dashboard.
  const [auth, setAuth] = useState<"checking" | "needed" | "ok">("checking");
  const [loginToken, setLoginToken] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  const [remoteActive, setRemoteActive] = useState(false);
  const remoteActiveRef = useRef(false);
  const [kbBox, setKbBox] = useState<{ height: number; top: number } | null>(null);
  const [idleH, setIdleH] = useState<number>(() =>
    typeof window !== "undefined"
      ? STANDALONE
        ? window.screen.height || window.innerHeight
        : window.innerHeight
      : 844
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const TEXT_INPUT_TYPES = new Set([
      "text",
      "search",
      "email",
      "url",
      "tel",
      "password",
      "number",
    ]);

    const isTextEditable = (el: EventTarget | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
      if (el instanceof HTMLInputElement) {
        return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
      }
      return el.isContentEditable;
    };

    const editableFocused = () => isTextEditable(document.activeElement);

    // Installed iOS PWAs lie about heights: window.innerHeight shrinks on the
    // first keyboard open and never restores, and vv.height under-reports by
    // the safe-area insets. Probe the real full height via a hidden 100vh el.
    const probeFullHeight = () => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;top:0;left:0;height:100vh;visibility:hidden;pointer-events:none";
      document.documentElement.appendChild(probe);
      const h = probe.offsetHeight;
      probe.remove();
      return h || window.innerHeight;
    };

    let fullHeight = STANDALONE ? probeFullHeight() : window.innerHeight;
    setIdleH(fullHeight);
    let lastWidth = window.innerWidth;
    let settle = 0;
    let unlockTimer = 0;
    let focusInAt = -10000;

    const kbStoreKey = (baseH: number) =>
      `klanker.kbh.${STANDALONE ? "pwa" : "web"}.${Math.round(baseH)}`;
    const readLastKbH = (baseH: number) => {
      try {
        const raw = window.localStorage.getItem(kbStoreKey(baseH));
        const n = raw ? Number(raw) : 0;
        if (n >= 160 && n < baseH - 100) return n;
      } catch {
        /* private mode */
      }
      return Math.max(180, Math.round(baseH - (STANDALONE ? (baseH < 500 ? 200 : 376) : 290)));
    };
    const saveLastKbH = (baseH: number, h: number) => {
      try {
        window.localStorage.setItem(kbStoreKey(baseH), String(Math.round(h)));
      } catch {
        /* private mode */
      }
    };
    let lastKbH = readLastKbH(fullHeight);

    const setStandaloneLock = (lock: boolean) => {
      if (!STANDALONE) return;
      const root = document.documentElement;
      if (lock) {
        window.clearTimeout(unlockTimer);
        if (root.dataset.kbLock !== "1") root.dataset.kbLock = "1";
      } else if (root.dataset.kbLock) {
        delete root.dataset.kbLock;
      }
    };

    const clampScroll = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    const sync = () => {
      clampScroll();
      if (vv.scale > 1.01) return;
      // --vvh feeds modal/sheet max-height (dvh does not shrink for the iOS keyboard).
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        fullHeight = STANDALONE ? probeFullHeight() : window.innerHeight;
        setIdleH(fullHeight);
        lastKbH = readLastKbH(fullHeight);
      }
      const focused = editableFocused();
      const covered = fullHeight - (vv.height + vv.offsetTop);
      const vvShrunk = covered > 100 || vv.offsetTop > 100;
      if (!STANDALONE && (!focused || !vvShrunk) && Math.abs(vv.height - window.innerHeight) < 20) {
        fullHeight = window.innerHeight;
        setIdleH(fullHeight);
      }
      if (focused && vvShrunk && vv.height >= 160) {
        lastKbH = Math.round(vv.height);
        saveLastKbH(fullHeight, lastKbH);
      }
      const touchLayout =
        window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches;
      const openingWindow =
        focused &&
        touchLayout &&
        performance.now() - focusInAt < 450;
      const keyboardOpen = focused && (vvShrunk || openingWindow);
      const targetH = vvShrunk ? Math.round(vv.height) : lastKbH;
      const settledTop =
        !STANDALONE &&
        vv.offsetTop > 4 &&
        performance.now() - focusInAt >= 360
          ? Math.round(vv.offsetTop)
          : 0;
      if (focused || keyboardOpen) {
        setStandaloneLock(true);
      }
      setKbBox((prev) => {
        const next = keyboardOpen ? { height: targetH, top: settledTop } : null;
        if (prev === next) return prev;
        if (prev && next && prev.height === next.height && prev.top === next.top)
          return prev;
        return next;
      });
    };

    let tap: { el: HTMLElement; id: number; x: number; y: number } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tap = null;
        return;
      }
      const target = e.target;
      if (isTextEditable(target) && document.activeElement !== target) {
        const t = e.touches[0];
        tap = { el: target, id: t.identifier, x: t.clientX, y: t.clientY };
        if (STANDALONE) setStandaloneLock(true);
      } else {
        tap = null;
      }
    };

    const onTouchCancel = () => {
      tap = null;
    };

    // Intercept qualified first-taps on unfocused mobile inputs (react-aria /
    // futo-notes / tweb pattern): prevent native touch-focus scroll & pan, then
    // lift off-screen for focus({ preventScroll: true }) + double-rAF restore.
    const onTouchEnd = (e: TouchEvent) => {
      const cur = tap;
      tap = null;
      if (!cur || e.touches.length > 0 || !cur.el.isConnected) return;
      if (document.activeElement === cur.el) return;
      let match: Touch | null = null;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === cur.id) {
          match = t;
          break;
        }
      }
      if (!match) return;
      if (Math.hypot(match.clientX - cur.x, match.clientY - cur.y) >= 12) {
        if (STANDALONE && !editableFocused()) {
          window.clearTimeout(unlockTimer);
          unlockTimer = window.setTimeout(() => {
            if (!editableFocused()) setStandaloneLock(false);
          }, 120);
        }
        return;
      }
      e.preventDefault();
      if (STANDALONE) setStandaloneLock(true);
      focusWithoutScroll(cur.el);
    };

    const onFocusIn = (e: FocusEvent) => {
      if (isTextEditable(e.target)) {
        focusInAt = performance.now();
        if (STANDALONE) setStandaloneLock(true);
      }
      sync();
      window.clearTimeout(settle);
      settle = window.setTimeout(sync, 460);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (isTextEditable(e.relatedTarget)) return;
      // Trigger the CSS height transition back to idleH immediately at t=0ms
      // so the shell glides down in lockstep with the iOS keyboard, then
      // release kbLock once the slide finishes.
      focusInAt = -10000;
      sync();
      window.clearTimeout(settle);
      settle = window.setTimeout(sync, 460);
      window.clearTimeout(unlockTimer);
      unlockTimer = window.setTimeout(() => {
        if (!editableFocused()) {
          setStandaloneLock(false);
          sync();
        }
      }, STANDALONE ? 340 : 460);
    };

    sync();
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    document.addEventListener("touchcancel", onTouchCancel, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", clampScroll, { passive: true });
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(unlockTimer);
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("touchcancel", onTouchCancel, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", clampScroll);
    };
  }, []);
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
  const lastNotifiedApprovalRef = useRef<string>("");
  // Buffered SSE deltas: one setChats per frame instead of one per token.
  const deltaFlush = useRef<() => void>(() => undefined);
  // Last persisted bucket snapshot — dirty-scoped localStorage writes only.
  const savedBuckets = useRef<Record<string, ChatBucket>>({});
  const persistTimer = useRef(0);
  // Restored messages per session + in-flight title fetches (no refetch spam).
  const evCache = useRef(new Map<string, ChatMessage[]>());
  const titleFetches = useRef(new Set<string>());
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
    deltaFlush.current();
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
  }, []);

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
    const inst = activeInstance;
    if (!inst) return;
    if (!(await dialogs.confirm(`Delete chat "${row.label || row.session}"? This cannot be undone.`, { danger: true }))) return;
    const key = `${inst.id} ${ws} ${persona}`;
    // Optimistic: drop the row from both stores before the server answers.
    setServerSessions((prev) => ({
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
      void api.deleteSession(inst, ws, persona, row.session).catch((e) => {
        setWsNote(`delete: ${e instanceof Error ? e.message : e}`);
        expandPersona(ws, persona);
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

  // Boot: desktop spawns/attaches its local relay (token never asked); web
  // does the same-origin auth check, then instances + settings.
  useEffect(() => {
    void (async () => {
      if (caps.spawn) {
        // Desktop: never gate the UI on the local serve. The dashboard
        // renders immediately (registry/remotes still usable); the managed
        // serve spawns in the background and the health poll picks it up.
        setAuth("ok");
        void (async () => {
          try {
            const boot = await api.desktopBootstrap();
            boot.instance.secret = boot.secret;
            rememberSecret(secretAccount(boot.instance), boot.secret);
            setManagedId(boot.instance.id);
          } catch (e) {
            setWsNote(
              `local relay unavailable: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        })();
      } else {
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
      }
      try {
        const list = await api.listKlankers();
        setInstances(list);
        const remembered = api.loadActiveId();
        const initial =
          list.find((i) => i.id === remembered) ??
          list[0] ??
          null;
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

  // Persist chats per instance (localStorage). Serializing every bucket on
  // every token froze iOS mid-stream, so writes are dirty-scoped (identity
  // diff against the last snapshot) and debounced; synchronous flushes happen
  // on turn completion, pagehide, and a hidden visibilitychange.
  const flushPersist = useCallback(() => {
    window.clearTimeout(persistTimer.current);
    persistTimer.current = 0;
    const next = chatsRef.current;
    const { write, remove } = diffChatBuckets(savedBuckets.current, next);
    for (const key of write) saveBucket(key, next[key]);
    for (const key of remove) {
      try {
        localStorage.removeItem(chatsKey(key));
      } catch {}
    }
    savedBuckets.current = next;
  }, []);

  useEffect(() => {
    if (chats === savedBuckets.current) return;
    if (!persistTimer.current) {
      persistTimer.current = window.setTimeout(flushPersist, 800);
    }
  }, [chats, flushPersist]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushPersist();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flushPersist);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flushPersist);
      window.clearTimeout(persistTimer.current);
      persistTimer.current = 0;
      flushPersist();
    };
  }, [flushPersist]);

  // Persist session titles (sidebar name cache across reloads)
  useEffect(() => {
    try {
      localStorage.setItem(LS_TITLES, JSON.stringify(sessionTitles));
    } catch {}
  }, [sessionTitles]);

  // Remember last ws/persona selection per instance
  useEffect(() => {
    if (!activeInstance || !selWs) return;
    try {
      localStorage.setItem(selStoreKey(activeInstance.id), JSON.stringify({ ws: selWs, persona: selPersona }));
    } catch {}
  }, [activeInstance?.id, selWs, selPersona]);

  // Hydrate the active bucket from localStorage so the last open chat
  // (and the open draft with its composer text) is restored on reload.
  useEffect(() => {
    if (!selKey) return;
    setChats((prev) =>
      prev[selKey] ? prev : { ...prev, [selKey]: normBucket(loadBucket(selKey) ?? EMPTY_BUCKET) }
    );
  }, [selKey]);

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
        rows.forEach((w) => expandWs(w.id));
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

  const eventsToMessages = (events: any[]): ChatMessage[] =>
    events
      .filter((e) => e?.type === "message" && e?.metadata?.content)
      .map((e) => ({
        id: crypto.randomUUID(),
        role: e.metadata.role === "user" ? "user" : "klanker",
        content: String(e.metadata.content),
        timestamp: e.ts || new Date().toISOString(),
      }));

  /**
   * Merge server-restored messages over the local copy. localStorage is
   * per-device: a dead stream (iOS suspends the SSE fetch) leaves stranded
   * empty bubbles or "Error executing turn" text while the server completed
   * the turn. Server messages win; local messages only survive when they are
   * newer than the last server event (unsent/failed) or an error annotation
   * the server genuinely never answered.
   */
  const mergeMessages = (local: ChatMessage[], server: ChatMessage[]): ChatMessage[] => {
    if (!server.length) return local;
    const lastTs = server[server.length - 1].timestamp;
    const seen = new Set(server.map((m) => `${m.role}\n${m.content}`));
    const lastUserTs = server.reduce((acc, m) => (m.role === "user" ? m.timestamp : acc), "");
    const serverReplied = !lastUserTs || server.some((m) => m.role === "klanker" && m.timestamp >= lastUserTs);
    const extra = local.filter((m) => {
      if (!m.content) return false;
      if (seen.has(`${m.role}\n${m.content}`)) return false;
      if (m.timestamp > lastTs) return true;
      return m.role === "klanker" && m.content.startsWith("Error") && !serverReplied;
    });
    return [...server, ...extra];
  };

  /** Pull session events and merge them into a chat. With `awaitReply` it
   *  retries briefly: after a client-side stream death the server turn may
   *  still be running, so the reply lands in the next poll. */
  const reconcileChat = async (
    inst: KlankerInstance,
    key: string,
    chatId: string,
    ws: string,
    persona: string,
    session: string,
    awaitReply = false
  ) => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const events = await api.sessionEvents(inst, ws, persona, session);
      if (events) {
        const serverMsgs = eventsToMessages(events);
        evCache.current.set(`${inst.id} ${ws} ${persona} ${session}`, serverMsgs);
        setChats((prev) =>
          mapChat(prev, key, chatId, (item) => {
            if (turnBusyRef.current?.chatId === chatId) return item;
            const next = mergeMessages(item.messages, serverMsgs);
            return next === item.messages ? item : { ...item, messages: next };
          })
        );
        const lastUser = serverMsgs.reduce((acc, m, i) => (m.role === "user" ? i : acc), -1);
        const replied = lastUser < 0 || serverMsgs.some((m, i) => i > lastUser && m.role === "klanker");
        if (replied || !awaitReply || Date.now() > deadline) return;
      } else if (!awaitReply || Date.now() > deadline) {
        return;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  };

  const expandPersona = (ws: string, persona: string) => {
    const inst = activeInstance;
    if (!inst) return;
    const key = `${ws} ${persona}`;
    void api
      .listSessions(inst, ws, persona)
      .then((rows) => {
        const list = rows.filter((s) => s.id);
        setServerSessions((prev) => ({ ...prev, [key]: list }));
        // Prefetch each session's events once: sidebar title + open-time restore cache.
        for (const s of list) {
          const ck = `${inst.id} ${ws} ${persona} ${s.id}`;
          if (sessionTitles[ck] || evCache.current.has(ck) || titleFetches.current.has(ck)) continue;
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
    const instId = activeInstance?.id;
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
        return {
          chatId: i.id,
          session: i.session,
          label: first ? clipTitle(first) : sessionTitles[`${instId} ${ws} ${persona} ${i.session}`] || "new chat",
          pending: !server?.some((s) => s.id === i.session),
        };
      });
    const covered = new Set(localRows.map((r) => r.session));
    const remoteRows: SessionRow[] = (server ?? [])
      .filter((s) => !covered.has(s.id))
      .map((s) => ({
        chatId: s.id,
        session: s.id,
        label: sessionTitles[`${instId} ${ws} ${persona} ${s.id}`] || s.goal || "…",
        pending: false,
      }));
    return [...localRows, ...remoteRows];
  };

  // Session history: reconcile the open chat with server trace events when it
  // is opened and whenever the app regains visibility. Stranded optimistic
  // bubbles (dead mobile streams) heal here; prefetched events (sidebar
  // titles) serve as the cache; failures stay retryable.
  useEffect(() => {
    const inst = activeInstance;
    const chat = openChat;
    if (!inst || !chat || !chat.session) return;
    if (!selWs || !selPersona) return;
    const ws = selWs;
    const persona = selPersona;
    const key = selKey;
    const chatId = chat.id;
    const session = chat.session;
    const ck = `${inst.id} ${ws} ${persona} ${session}`;
    remoteActiveRef.current = false;
    setRemoteActive(false);
    const apply = (restored: ChatMessage[]) => {
      if (restored.length === 0) return;
      setChats((prev) =>
        mapChat(prev, key, chatId, (item) => {
          if (turnBusyRef.current?.chatId === chatId) return item;
          const next = mergeMessages(item.messages, restored);
          return next === item.messages ? item : { ...item, messages: next };
        })
      );
      const first = restored.find((m) => m.role === "user")?.content;
      if (first) setSessionTitles((prev) => (prev[ck] ? prev : { ...prev, [ck]: clipTitle(first) }));
    };
    const run = async () => {
      const cached = evCache.current.get(ck);
      if (cached && chat.messages.length === 0) {
        apply(cached);
      }
      const events = await api.sessionEvents(inst, ws, persona, session);
      if (!events) return;
      // A foreign turn is in flight when the newest trace event is anything
      // but an assistant message (user msg awaiting reply, tool_call, …) and
      // is recent. Stale tails don't pretend a dead turn still runs.
      const lastEv = events[events.length - 1];
      const lastTs = lastEv ? Date.parse(String(lastEv.ts || "")) : NaN;
      const settled =
        !lastEv || (lastEv.type === "message" && lastEv.metadata?.role === "assistant");
      const active = !settled && Number.isFinite(lastTs) && Date.now() - lastTs < 120_000;
      remoteActiveRef.current = active;
      setRemoteActive(active);
      const restored = eventsToMessages(events);
      evCache.current.set(ck, restored);
      apply(restored);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    void run();
    document.addEventListener("visibilitychange", onVisible);
    // Cheap sync: one raw JSONL line per tick; the heavy events pull only runs
    // when the session's newest trace ts actually moved (turns from other
    // devices/channels land without a reload). While a foreign turn is live
    // the tick tightens to 2s: tool_call + user/assistant message records are
    // appended to the trace as the turn runs, so watching devices see its
    // progress and the reply ~2s after it lands instead of up to 12s late.
    let lastTs = "";
    let pollTimer = 0;
    const tickPoll = () => {
      pollTimer = window.setTimeout(
        () => {
          const rearm = () => tickPoll();
          if (document.visibilityState !== "visible" || turnBusyRef.current?.chatId === chatId) {
            rearm();
            return;
          }
          void api
            .sessionTailTs(inst, ws, session)
            .then((ts) => {
              if (ts) {
                if (!lastTs) lastTs = ts;
                else if (ts !== lastTs) {
                  lastTs = ts;
                  void run();
                }
              }
            })
            .finally(rearm);
        },
        remoteActiveRef.current ? 2_000 : 12_000
      );
    };
    tickPoll();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(pollTimer);
      remoteActiveRef.current = false;
      setRemoteActive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (!stop && mine === pollSeq.current) {
          if (
            next &&
            next.id !== lastNotifiedApprovalRef.current &&
            (document.hidden || !document.hasFocus())
          ) {
            lastNotifiedApprovalRef.current = next.id;
            void notify("Klanker needs approval", next.summary || next.tool || "Pending tool approval");
          }
          setPending(next);
        }
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
      // A name edit may rename the id (folder = slug): replace by the sent id.
      setInstances((prevList) => {
        const idx = prevList.findIndex((i) => i.id === inst.id || i.id === saved.id);
        if (idx >= 0) {
          const next = [...prevList];
          next[idx] = saved;
          return next;
        }
        return [...prevList, saved];
      });
      if (activeIdRef.current === inst.id || activeIdRef.current === saved.id) setActiveInstance(saved);
      // Re-probe immediately — a fresh secret should clear `unauthorized`
      // without waiting for the 8s health poll.
      void api.getGatewayStatus(saved).then((st) =>
        setHerd((prev) => ({ ...prev, [saved.id]: st }))
      );
      const provider = saved.provider.trim().toLowerCase() as ModelProvider;
      const model = provider === "lmstudio" || provider === "openrouter" ? saved.model.trim() : "";
      if (model) {
        await updateSettings((current) => rememberModel(current, provider, model));
      }
    } catch (e) {
      console.error("Failed to save instance:", e);
      throw e;
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
        merged.autostart = next.autostart;
        return provider === "echo" ? merged : rememberModel(merged, provider, merged.model);
      });
      if (caps.spawn) {
        try {
          await api.autostartSet(next.autostart);
        } catch (e) {
          console.error("autostart toggle failed", e);
        }
      }
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
    void handleSaveInstance({ ...draft, provider: "inherit" }).catch(() => undefined);
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
    rememberTurnModel(inst);

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
      const choice = choiceOf(inst);
      // Provider = raw host manifest name; ""/"inherit" = host default (env).
      // Do not gate on `choice` — real manifest names (acp.cursor,
      // scripted.tool) map to "inherit" in the UI taxonomy and were silently
      // dropped before reaching the relay.
      const instProvider = inst.provider.trim();
      const provider = instProvider && instProvider !== "inherit" ? instProvider : "";
      const model = (chatModels[selKey] ?? (choice === "inherit" ? inst.model.trim() || settingsRef.current.model : inst.model)).trim();
      const stream = api.streamChat(inst, {
        text,
        run: busy.run,
        session,
        workspace: selWs || undefined,
        persona: selPersona || undefined,
        provider: provider || undefined,
        model: model || undefined,
        attachments: attachments && attachments.length ? attachments : undefined,
      });
      // iOS can suspend the SSE fetch without erroring it: no delta, no done,
      // no catch — the spinner and the busy-lock would hang forever. An idle
      // watchdog fails the turn; the reconcile in `finally` heals from server
      // truth. Generous: prefill/stall gaps are bounded by provider settings.
      const it = stream[Symbol.asyncIterator]();
      const STREAM_IDLE_MS = 5 * 60_000;
      for (;;) {
        const next = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error("stream stalled (no events for 5m)")), STREAM_IDLE_MS)
          ),
        ]);
        if (next.done) break;
        const ev = next.value;
        if (ev.type === "delta" && ev.text) {
          deltas.push(ev.text);
        } else if (ev.type === "status" && ev.text) {
          setStreamStatus(ev.text);
        } else if (ev.type === "error") {
          deltas.flush();
          throw new Error(ev.text || "turn failed");
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
      }
      deltas.flush();
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
        void notify("Klanker turn finished", inst.name || inst.id);
      }
      // A dead client stream (iOS "Load failed", suspend, reload) does not
      // mean the turn failed: the server may still be writing the reply into
      // the session. Reconcile so the bubbles converge to server truth.
      if (!sawTrailer && session) {
        void reconcileChat(inst, selKey, chatId, selWs, selPersona, session, true);
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
      <div className="fixed inset-0 flex items-center justify-center bg-[#000000] text-white font-sans">
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
          instances={instances}
          managedId={managedId}
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
          onInstanceSettings={(inst) => { setInstanceSheetInst(inst); setNavOpen(false); }}
          onDeleteWorkspace={async (ws) => {
            const inst = activeInstance;
            if (!inst || !(await dialogs.confirm(`Archive workspace "${ws}"? (restorable from trash)`, { danger: true }))) return;
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
          onNewPersona={async (ws) => {
            const inst = activeInstance;
            const id = await dialogs.prompt(`new persona id in ${ws}`);
            if (!inst || !id?.trim()) return;
            void api
              .createPersona(inst, ws, id.trim())
              .then(() => api.listPersonas(inst, ws))
              .then((rows) => setTreePersonas((prev) => ({ ...prev, [ws]: rows })))
              .catch((e) => setWsNote(`persona: ${e instanceof Error ? e.message : e}`));
          }}
          onDeletePersona={async (ws, persona) => {
            const inst = activeInstance;
            if (!inst || !(await dialogs.confirm(`Archive persona "${persona}"?`, { danger: true }))) return;
            void api
              .deletePersona(inst, ws, persona)
              .then(() => api.listPersonas(inst, ws))
              .then((rows) => setTreePersonas((prev) => ({ ...prev, [ws]: rows })))
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
                return api.listWorkspaces(activeInstance).then(setWorkspaces);
              })
              .catch((e) => setWsNote(`workspace: ${e instanceof Error ? e.message : e}`));
          }}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header activeInstance={activeInstance} selWs={selWs} onOpenSettings={openSettings} onOpenManage={() => setManageOpen(true)} onOpenNav={() => setNavOpen(true)} />

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
                speakerName={personasOf(selWs)?.find((p) => p.id === selPersona)?.name || selPersona || activeInstance.name}
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
                modelOptions={(() => {
                  const kind = choiceOf(activeInstance) === "inherit" ? windowKind(settings) : choiceOf(activeInstance);
                  return kind === "openrouter" || kind === "lmstudio"
                    ? [...new Set([...settings.favorites[kind], ...settings.recent_models[kind]])].filter(Boolean)
                    : [];
                })()}
                model={chatModels[selKey] ?? ""}
                onModel={(id) =>
                  setChatModels((prev) => {
                    const next = { ...prev };
                    if (id) next[selKey] = id;
                    else delete next[selKey];
                    return next;
                  })
                }
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
      {instanceSheetInst && (
        <InstanceSheet
          instance={instances.find((i) => i.id === instanceSheetInst.id) ?? instanceSheetInst}
          status={herd[instanceSheetInst.id] ?? null}
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
            setInstanceSheetInst(null);
          }}
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
      {manageOpen && activeInstance && (
        <ManagePanel
          instance={activeInstance}
          workspace={selWs}
          onClose={() => setManageOpen(false)}
        />
      )}
      <DialogHost />
    </div>
  );
}
export default App;
