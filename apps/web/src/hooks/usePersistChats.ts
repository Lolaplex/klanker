import { useCallback, useEffect, useRef } from "react";
import { diffChatBuckets } from "../chatPersist";
import {
  ChatBucket,
  EMPTY_BUCKET,
  LS_SEL,
  LS_TITLES,
  chatsKey,
  loadBucket,
  normBucket,
  saveBucket,
} from "../chatBuckets";

/**
 * localStorage persistence: dirty-scoped debounced bucket writes (identity
 * diff against the last snapshot — serializing every bucket per token froze
 * iOS mid-stream), synchronous flushes on pagehide/hidden, title cache,
 * workspace-first ws/persona selection memory (`klanker.ws.sel`), and bucket
 * hydration on selKey.
 */
export function usePersistChats(args: {
  chats: Record<string, ChatBucket>;
  chatsRef: React.MutableRefObject<Record<string, ChatBucket>>;
  setChats: React.Dispatch<React.SetStateAction<Record<string, ChatBucket>>>;
  sessionTitles: Record<string, string>;
  selWs: string;
  selPersona: string;
  selKey: string;
}): { flushPersist: () => void } {
  const { chats, chatsRef, setChats, sessionTitles, selWs, selPersona, selKey } = args;
  const savedBuckets = useRef<Record<string, ChatBucket>>({});
  const persistTimer = useRef(0);

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
  }, [chatsRef]);

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

  // Remember the last ws/persona selection — workspace-first: one global
  // pointer, never partitioned per instance (klanker#150).
  useEffect(() => {
    if (!selWs) return;
    try {
      localStorage.setItem(LS_SEL, JSON.stringify({ ws: selWs, persona: selPersona }));
    } catch {}
  }, [selWs, selPersona]);

  // Hydrate the active bucket from localStorage so the last open chat
  // (and the open draft with its composer text) is restored on reload.
  useEffect(() => {
    if (!selKey) return;
    setChats((prev) =>
      prev[selKey] ? prev : { ...prev, [selKey]: normBucket(loadBucket(selKey) ?? EMPTY_BUCKET) }
    );
  }, [selKey, setChats]);

  return { flushPersist };
}
