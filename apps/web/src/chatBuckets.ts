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

export interface TurnBusy {
  instanceId: string;
  chatId: string;
  run: string;
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

/** Merge legacy/dup drafts into one, drop draft flags off real chats. */
export function normBucket(b: ChatBucket): ChatBucket {
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

export const chatsKey = (sel: string) => `klanker.chats.${sel}`;
export const selStoreKey = (instId: string) => `klanker.sel.${instId}`;
export const LS_TITLES = "klanker.titles";

export function loadBucket(sel: string): ChatBucket | null {
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

export function saveBucket(sel: string, bucket: ChatBucket): void {
  try {
    const items = bucket.items.slice(-30).map((i) => ({ ...i, messages: i.messages.slice(-300) }));
    localStorage.setItem(chatsKey(sel), JSON.stringify({ ...bucket, items }));
  } catch {}
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
