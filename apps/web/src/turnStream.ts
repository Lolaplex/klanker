/**
 * Resumable chat turn stream (mobile-safe).
 *
 * A phone that backgrounds the PWA, locks the screen or switches network
 * kills the SSE fetch ("Load failed", "network error") or silently
 * suspends it, while the relay keeps running the turn (agents-relay#64).
 * Instead of turning a transport failure into an "Error executing turn"
 * bubble, the client re-attaches to the same run via `/v1/runs/stream`
 * (which replays the buffered events from the start) and keeps
 * streaming. Only real turn failures (a server `error` event, a non-
 * transport HTTP status on the initial POST) surface as errors.
 */

export type TurnEvent = {
  type: string;
  text?: string;
  run?: string;
  session?: string;
  user_id?: string;
  returncode?: number;
  id?: string;
  tool?: string;
  args_preview?: string;
  ok?: boolean;
  duration_ms?: number;
  result_preview?: string;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
  est_cost_usd?: number;
  model?: string;
};

export const TURN_EVENT_NAME = "klanker:turn-event";

export type SteerTurnEvent = TurnEvent & { type: "steer"; text: string };

/** Narrow the relay's typed mid-turn steer frame. Unknown/malformed frames
 *  stay invisible instead of painting empty confirmation chrome. */
export function asSteerEvent(ev: TurnEvent): SteerTurnEvent | null {
  return ev.type === "steer" && typeof ev.text === "string" && ev.text.trim()
    ? (ev as SteerTurnEvent)
    : null;
}

/** Side-channel for UI-only trace affordances. App.tsx stays backward
 * compatible while ChatConsole can observe the typed U13 frames passing
 * through the resumable transport. */
export function publishTurnEvent(ev: TurnEvent): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TurnEvent>(TURN_EVENT_NAME, { detail: ev }));
}

/** The server reported the turn itself failed (SSE `error` event). */
export class TurnError extends Error {}

/** The client lost the stream (stall, background resume, early EOF). */
export class StreamLost extends Error {}

const STATUS_RE = /^(\d{3})(?::|$)/;

/** HTTP status carried by api.ts stream errors ("502: ..."), else null. */
export function httpStatusOf(e: unknown): number | null {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const m = STATUS_RE.exec(msg.trim());
  return m ? Number(m[1]) : null;
}

/** Transport-level failure: the turn may well still be running. */
export function isTransportError(e: unknown, reattaching = false): boolean {
  if (e instanceof TurnError) return false;
  if (e instanceof StreamLost) return true;
  const status = httpStatusOf(e);
  if (status === null) return true; // TypeError "Load failed" / "Failed to fetch" / abort
  // A gateway hiccup while re-attaching is retryable; on the initial POST
  // a status means the turn was rejected (or never started).
  return reattaching && status >= 500;
}

/** Lets the UI force a re-attach (e.g. on visibility regain). */
export class Kicker {
  private reject: ((e: Error) => void) | null = null;

  arm(): Promise<never> {
    return new Promise<never>((_, reject) => {
      this.reject = reject;
    });
  }

  kick(reason = "stream resumed after background"): void {
    const r = this.reject;
    this.reject = null;
    r?.(new StreamLost(reason));
  }

  disarm(): void {
    this.reject = null;
  }
}

export type ResumableOpts = {
  open: () => AsyncIterable<TurnEvent>;
  reattach: () => AsyncIterable<TurnEvent>;
  /** delta/status/trailer events (attach/start are swallowed). */
  onEvent: (ev: TurnEvent) => void;
  /** Called before a re-attach replay: drop the partial reply. */
  onReset: () => void;
  onStatus: (s: string | null) => void;
  idleMs: number;
  maxReattach: number;
  kicker?: Kicker;
  waitVisible?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

/** "done" = trailer seen; "detached" = run no longer attachable (or
 *  retries exhausted): the caller reconciles from session history. */
export type ResumableResult = "done" | "detached";

async function consume(source: AsyncIterable<TurnEvent>, o: ResumableOpts): Promise<void> {
  const it = source[Symbol.asyncIterator]();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      const racers: Promise<IteratorResult<TurnEvent>>[] = [
        it.next(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new StreamLost(`stream stalled (no events for ${Math.round(o.idleMs / 1000)}s)`)),
            o.idleMs
          );
        }),
      ];
      if (o.kicker) racers.push(o.kicker.arm());
      const next = await Promise.race(racers);
      clearTimeout(idleTimer);
      if (next.done) throw new StreamLost("stream ended before the turn finished");
      const ev = next.value;
      if (!ev || ev.type === "attach" || ev.type === "start") continue;
      if (ev.type === "error") throw new TurnError(ev.text || "turn failed");
      publishTurnEvent(ev);
      o.onEvent(ev);
      if (ev.type === "trailer") return;
    }
  } finally {
    clearTimeout(idleTimer);
    o.kicker?.disarm();
    // Best effort: release the dead reader; never await a hung fetch.
    try {
      void it.return?.();
    } catch {
      /* ignore */
    }
  }
}

export async function runResumableTurn(o: ResumableOpts): Promise<ResumableResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let source = o.open();
  let attempts = 0;
  for (;;) {
    try {
      await consume(source, o);
      if (attempts > 0) o.onStatus(null);
      return "done";
    } catch (e) {
      const reattaching = attempts > 0;
      if (reattaching && httpStatusOf(e) === 404) return "detached"; // run ended / reaped
      if (!isTransportError(e, reattaching)) throw e;
      if (attempts >= o.maxReattach) return "detached";
      attempts += 1;
      o.onStatus("connection lost — reattaching…");
      if (o.waitVisible) await o.waitVisible();
      await sleep(Math.min(8_000, 1_000 * 2 ** (attempts - 1)));
      o.onReset();
      source = o.reattach();
    }
  }
}
