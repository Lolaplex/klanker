import type { ChatMessage, KlankerInstance, SessionEvent } from "./types/klanker";
import { api } from "./services/api";

export function eventsToMessages(events: SessionEvent[]): ChatMessage[] {
  return events
    .filter((e) => e?.type === "message" && e?.metadata?.content)
    .map((e) => ({
      id: crypto.randomUUID(),
      role: e.metadata?.role === "user" ? "user" : "klanker",
      content: String(e.metadata?.content ?? ""),
      timestamp: e.ts || new Date().toISOString(),
    }));
}

/**
 * Merge server-restored messages over the local copy. localStorage is
 * per-device: a dead stream (iOS suspends the SSE fetch) leaves stranded
 * empty bubbles or "Error executing turn" text while the server completed
 * the turn. Server messages win; local messages only survive when they are
 * newer than the last server event (unsent/failed) or an error annotation
 * the server genuinely never answered.
 */
export function mergeMessages(local: ChatMessage[], server: ChatMessage[]): ChatMessage[] {
  if (!server.length) return local;
  const lastTs = server[server.length - 1].timestamp;
  const seen = new Set(server.map((m) => `${m.role}\n${m.content}`));
  const lastUserTs = server.reduce((acc, m) => (m.role === "user" ? m.timestamp : acc), "");
  const serverReplied = !lastUserTs || server.some((m) => m.role === "klanker" && m.timestamp >= lastUserTs);
  const extra = local.filter((m) => {
    if (!m.content) return false;
    if (seen.has(`${m.role}\n${m.content}`)) return false;
    if (m.timestamp > lastTs) return true;
    return m.role === "klanker" && (m.content.startsWith("Error") || m.content.startsWith("Turn failed:")) && !serverReplied;
  });
  return [...server, ...extra];
}

/** Pull session events and merge them into a chat. With `awaitReply` it
 *  retries briefly: after a client-side stream death the server turn may
 *  still be running, so the reply lands in the next poll. */
export async function reconcileChat(
  inst: KlankerInstance,
  key: string,
  chatId: string,
  ws: string,
  persona: string,
  session: string,
  ctx: {
    evCache: Map<string, ChatMessage[]>;
    applyToChat: (key: string, chatId: string, fn: (messages: ChatMessage[]) => ChatMessage[]) => void;
  },
  awaitReply = false
) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const events = await api.sessionEvents(inst, ws, persona, session);
    if (events) {
      const serverMsgs = eventsToMessages(events);
      ctx.evCache.set(`${ws} ${persona} ${session}`, serverMsgs);
      ctx.applyToChat(key, chatId, (messages) => mergeMessages(messages, serverMsgs));
      const lastUser = serverMsgs.reduce((acc, m, i) => (m.role === "user" ? i : acc), -1);
      const replied = lastUser < 0 || serverMsgs.some((m, i) => i > lastUser && m.role === "klanker");
      if (replied || !awaitReply || Date.now() > deadline) return;
    } else if (!awaitReply || Date.now() > deadline) {
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}
