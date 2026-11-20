/**
 * Streaming + persistence helpers for the chat console.
 *
 * SSE deltas arrive per token; a React state update per token floods the main
 * thread (hundreds of setState calls per second, each re-serializing every
 * chat bucket into localStorage). The queue below merges deltas into one
 * flush per animation frame, and the dirty-diff keeps localStorage writes
 * scoped to the buckets that actually changed.
 */

export interface DeltaQueue {
  /** Buffer one streamed piece; schedules a frame flush on the first piece. */
  push(piece: string): void;
  /** Apply any buffered text synchronously. Safe to call with empty buffer. */
  flush(): void;
}

function defaultSchedule(cb: () => void): void {
  const hidden = typeof document !== "undefined" && document.hidden;
  if (!hidden && typeof requestAnimationFrame === "function") {
    requestAnimationFrame(cb);
    return;
  }
  // Background tabs throttle rAF to a halt; timers still run (~1s on iOS).
  setTimeout(cb, 32);
}

export function createDeltaQueue(
  onFlush: (text: string) => void,
  schedule: (cb: () => void) => void = defaultSchedule
): DeltaQueue {
  let buffer = "";
  let queued = false;
  const queue: DeltaQueue = {
    push(piece: string) {
      buffer += piece;
      if (queued) return;
      queued = true;
      schedule(() => queue.flush());
    },
    flush() {
      queued = false;
      if (!buffer) return;
      const text = buffer;
      buffer = "";
      onFlush(text);
    },
  };
  return queue;
}

/**
 * Identity diff between the last persisted snapshot and the current state:
 * `write` holds keys whose bucket object changed (mapChat only rewrites the
 * bucket it touches), `remove` keys that vanished entirely.
 */
export function diffChatBuckets<T>(
  saved: Record<string, T>,
  next: Record<string, T>
): { write: string[]; remove: string[] } {
  const write = Object.keys(next).filter((k) => next[k] !== saved[k]);
  const remove = Object.keys(saved).filter((k) => !(k in next));
  return { write, remove };
}
