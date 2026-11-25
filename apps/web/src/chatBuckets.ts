import type { ChatMessage } from "./types/klanker";

export interface DeskChat {
  id: string;
  session: string;
  messages: ChatMessage[];
  /** Unsent "new chat": no session, no sidebar row, at most one per bucket. */
  draft?: boolean;
  /** Persisted composer text (survives chat switches and reloads). */
  input?: string;
}

export interface ChatBucket {
  openId: string;
  items: DeskChat[];
}

/** One live turn per (workspace, session): parallel sessions in the same
 *  bucket never lock each other — the busy map is keyed `ws::session`
 *  (klanker#150). `persona` rides along for unread badges. */
export interface TurnBusy {
  /** Relay instance owning the run (stop target — the primary endpoint). */
  instanceId: string;
  wsId: string;
  persona: string;
  session: string;
  chatId: string;
  run: string;
}

export const busyKey = (wsId: string, session: string): string => `${wsId}::${session}`;

/** The busy entry owned by a given chat row, across any session key. */
export function busyForChat(busy: Record<string, TurnBusy>, chatId: string): TurnBusy | null {
  for (const b of Object.values(busy)) if (b.chatId === chatId) return b;
  return null;
}

/** Composer hold for the open chat: only a foreign row on the SAME session
 *  blocks sending — a busy `ws::ses1` never holds `ws::ses2`. Drafts (no
 *  session yet) are never held. */
export function sendHeld(
  busy: Record<string, TurnBusy>,
  wsId: string,
  session: string,
  chatId: string
): boolean {
  if (!session) return false;
  const b = busy[busyKey(wsId, session)];
  return !!b && b.chatId !== chatId;
}

export function mintSessionId(): string {
  return `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function clipTitle(text: string): string {
  const t = text.trim();
  return t.length > 22 ? `${t.slice(0, 22)}…` : t;
}

export const EMPTY_BUCKET: ChatBucket = { openId: "", items: [] };

// Installed iOS PWA: the layout viewport stops 47px above the screen bottom
// (see index.css). The idle shell then lives in document flow at 100vh.
export const STANDALONE =
  typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;

/** Dedupe drafts by chat id (the same unsent chat re-listed keeps its
 *  richer input), drop draft flags off real chats. Drafts with distinct
 *  ids are different unsent chats — merging two instances' buckets must
 *  not silently fold one user's composer text into the other's. */
export function normBucket(b: ChatBucket): ChatBucket {
  const items: DeskChat[] = [];
  const drafts = new Map<string, DeskChat>();
  for (const i of b.items) {
    if (!i.draft && i.session) {
      items.push({ ...i, draft: false });
      continue;
    }
    const d: DeskChat = { ...i, session: "", draft: true };
    const prev = drafts.get(d.id);
    drafts.set(d.id, prev ? { ...prev, input: prev.input || d.input } : d);
  }
  const all = [...items, ...drafts.values()];
  const openId = all.some((i) => i.id === b.openId) ? b.openId : (all[all.length - 1]?.id ?? "");
  return { openId, items: all };
}

// Workspace-first keyspace (klanker#150): buckets, selection and titles key
// on `${ws} ${persona}` — the serving relay fronts every local/synced/shared
// workspace, so the instance id must not partition chat state.
export const chatsKey = (sel: string) => `klanker.ws.chats.${sel}`;
export const LS_SEL = "klanker.ws.sel";
export const LS_TITLES = "klanker.ws.titles";
const LS_LEGACY_CHATS = "klanker.chats.";
const LS_LEGACY_SEL = "klanker.sel.";
const LS_LEGACY_TITLES = "klanker.titles";
const LS_WS_MIGRATED = "klanker.ws.migrated";

export function loadBucket(sel: string, storage: Storage = localStorage): ChatBucket | null {
  try {
    const raw = storage.getItem(chatsKey(sel));
    if (!raw) return null;
    const b = JSON.parse(raw) as ChatBucket;
    if (!Array.isArray(b?.items) || b.items.length === 0) return null;
    return normBucket(b);
  } catch {
    return null;
  }
}

export function saveBucket(sel: string, bucket: ChatBucket, storage: Storage = localStorage): void {
  try {
    const items = bucket.items.slice(-30).map((i) => ({ ...i, messages: i.messages.slice(-300) }));
    storage.setItem(chatsKey(sel), JSON.stringify({ ...bucket, items }));
  } catch {}
}

/**
 * Union two buckets without losing a single chat: real chats index on their
 * session id (the richer history wins a collision, the loser's composer text
 * survives on the winner), drafts/sessionless rows collapse via normBucket,
 * and the open pointer prefers `a` and falls back when its item was folded.
 */
export function mergeBuckets(a: ChatBucket, b: ChatBucket): ChatBucket {
  const bySession = new Map<string, DeskChat>();
  const loose: DeskChat[] = [];
  for (const item of [...a.items, ...b.items]) {
    if (item.draft || !item.session) {
      loose.push(item);
      continue;
    }
    const prev = bySession.get(item.session);
    if (!prev || item.messages.length > prev.messages.length) {
      bySession.set(item.session, { ...item, input: item.input || prev?.input });
    } else if (!prev.input && item.input) {
      bySession.set(item.session, { ...prev, input: item.input });
    }
  }
  return normBucket({ openId: a.openId || b.openId, items: [...bySession.values(), ...loose] });
}

/**
 * One-time boot migration into the workspace-first keyspace (klanker#150):
 * - `klanker.chats.<inst> <ws> <persona>` merges into `klanker.ws.chats.<ws>
 *   <persona>` — every instance's copy of the same ws/persona unions into one
 *   bucket, richer history wins collisions, nothing parseable is dropped.
 * - `klanker.sel.<inst>` becomes the single `klanker.ws.sel` (the remembered
 *   active instance wins when several exist).
 * - `klanker.titles` keys `<inst> <ws> <persona> <sid>` re-key to
 *   `klanker.ws.titles["<ws> <persona> <sid>"]`.
 * A legacy key is only removed after its content landed; an unparseable or
 * malformed entry keeps its key so nothing is silently lost.
 */
export function migrateLegacyStorage(storage: Storage = localStorage): { buckets: number; titles: number } {
  const none = { buckets: 0, titles: 0 };
  try {
    if (storage.getItem(LS_WS_MIGRATED)) return none;
  } catch {
    return none;
  }
  const legacyChats: [string, string][] = [];
  const legacySels: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k) continue;
      if (k.startsWith(LS_LEGACY_CHATS)) legacyChats.push([k, k.slice(LS_LEGACY_CHATS.length)]);
      else if (k.startsWith(LS_LEGACY_SEL)) legacySels.push(k);
    }
  } catch {
    return none;
  }

  let buckets = 0;
  for (const [key, rest] of legacyChats) {
    const parts = rest.split(" ");
    // Legacy sel is exactly `<inst> <ws> <persona>` — ids never carry spaces.
    if (parts.length !== 3) continue;
    const sel = `${parts[1]} ${parts[2]}`;
    let legacy: ChatBucket;
    try {
      const raw = storage.getItem(key);
      legacy = raw ? (JSON.parse(raw) as ChatBucket) : (null as unknown as ChatBucket);
      if (!legacy || !Array.isArray(legacy.items)) continue;
    } catch {
      continue; // keep the key — unparsed data is never silently dropped
    }
    const existing = loadBucket(sel, storage);
    saveBucket(sel, existing ? mergeBuckets(existing, legacy) : normBucket(legacy), storage);
    try {
      storage.removeItem(key);
    } catch {}
    buckets++;
  }

  // Selection: prefer the remembered active instance's row, then any valid one.
  try {
    if (!storage.getItem(LS_SEL) && legacySels.length) {
      const active = (storage.getItem("klanker.active") || "").trim();
      const ordered = [...legacySels].sort(
        (a, b) => Number(b === `${LS_LEGACY_SEL}${active}`) - Number(a === `${LS_LEGACY_SEL}${active}`)
      );
      for (const key of ordered) {
        try {
          const s = JSON.parse(storage.getItem(key) || "null");
          if (s?.ws && /^[\w.-]+$/.test(String(s.ws))) {
            storage.setItem(LS_SEL, JSON.stringify({ ws: String(s.ws), persona: s.persona ? String(s.persona) : "default" }));
            break;
          }
        } catch {}
      }
    }
    for (const key of legacySels) storage.removeItem(key);
  } catch {}

  // Titles: drop the leading instance token; existing new-style keys win.
  let titles = 0;
  try {
    const raw = storage.getItem(LS_LEGACY_TITLES);
    if (raw) {
      const legacy = JSON.parse(raw) as Record<string, unknown>;
      const next = JSON.parse(storage.getItem(LS_TITLES) || "{}") as Record<string, string>;
      for (const [k, v] of Object.entries(legacy)) {
        if (typeof v !== "string" || !v) continue;
        const nk = k.split(" ").length >= 4 ? k.split(" ").slice(1).join(" ") : k;
        if (!next[nk]) {
          next[nk] = v;
          titles++;
        }
      }
      storage.setItem(LS_TITLES, JSON.stringify(next));
      storage.removeItem(LS_LEGACY_TITLES);
    }
  } catch {}
  try {
    storage.setItem(LS_WS_MIGRATED, "1");
  } catch {}
  return { buckets, titles };
}

export function mapChat(
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
