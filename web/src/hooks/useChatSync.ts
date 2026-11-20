import { useEffect, useRef, useState } from "react";
import type { ChatMessage, KlankerInstance } from "../types/klanker";
import { api } from "../services/api";
import { ChatBucket, DeskChat, TurnBusy, clipTitle, mapChat } from "../chatBuckets";
import { eventsToMessages, mergeMessages } from "../chatSync";

/**
 * Session history sync for the open chat: reconcile against server trace
 * events on open + visibility regain, attach the relay SSE fan-out while a
 * foreign turn runs (klanker#92), and a cheap tail-ts poll (12s, 2s while
 * remote-active) that only pulls events when the tail actually moved.
 */
export function useChatSync(args: {
  activeInstance: KlankerInstance | null;
  openChat: DeskChat | null;
  selKey: string;
  selWs: string;
  selPersona: string;
  setChats: React.Dispatch<React.SetStateAction<Record<string, ChatBucket>>>;
  turnBusyRef: React.MutableRefObject<TurnBusy | null>;
  evCache: React.MutableRefObject<Map<string, ChatMessage[]>>;
  setSessionTitles: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setStreamStatus: (s: string | null) => void;
}): { remoteActive: boolean; remoteActiveRef: React.MutableRefObject<boolean> } {
  const {
    activeInstance, openChat, selKey, selWs, selPersona,
    setChats, turnBusyRef, evCache, setSessionTitles, setStreamStatus,
  } = args;
  const [remoteActive, setRemoteActive] = useState(false);
  const remoteActiveRef = useRef(false);

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
      maybeAttach();
      const restored = eventsToMessages(events);
      evCache.current.set(ck, restored);
      apply(restored);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    // klanker#92: while a foreign turn runs on this relay, attach its SSE fan-out
    // and stream deltas into a transient bubble; the trailer drops it and the
    // trace reconcile converges to server truth. A 404 (old relay, or the run
    // belongs to another channel's turn store) just falls back to the poll.
    let attachLive = false;
    const remoteBubbleId = `remote_${chatId}`;
    const dropRemoteBubble = () => {
      setChats((prev) =>
        mapChat(prev, key, chatId, (item) => ({
          ...item,
          messages: item.messages.filter((m) => m.id !== remoteBubbleId),
        }))
      );
    };
    const maybeAttach = () => {
      if (!remoteActiveRef.current || attachLive) return;
      attachLive = true;
      let ended = false;
      (async () => {
        try {
          for await (const ev of api.attachRun(inst, { workspace: ws, persona, session })) {
            if (!remoteActiveRef.current) break;
            if (ev.type === "delta" && ev.text) {
              const text = ev.text;
              setChats((prev) =>
                mapChat(prev, key, chatId, (item) => {
                  const idx = item.messages.findIndex((m) => m.id === remoteBubbleId);
                  if (idx >= 0) {
                    const ms = [...item.messages];
                    ms[idx] = { ...ms[idx], content: ms[idx].content + text };
                    return { ...item, messages: ms };
                  }
                  return {
                    ...item,
                    messages: [
                      ...item.messages,
                      {
                        id: remoteBubbleId,
                        role: "klanker",
                        content: text,
                        timestamp: new Date().toISOString(),
                      },
                    ],
                  };
                })
              );
            } else if (ev.type === "status" && ev.text) {
              setStreamStatus(ev.text);
            } else if (ev.type === "trailer" || ev.type === "error") {
              ended = true;
              break;
            }
          }
        } catch {
          // old relay without /v1/runs/stream, or run ended between poll + attach
        }
        dropRemoteBubble();
        setStreamStatus(null);
        if (ended || remoteActiveRef.current) void run();
      })();
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

  return { remoteActive, remoteActiveRef };
}
