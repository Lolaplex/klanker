import { useEffect, useRef } from "react";
import type { KlankerInstance, ProcessStatus, RelayEvent } from "../types/klanker";
import { api } from "../services/api";

/**
 * Subscribe to the active instance's authenticated `/v1/events` SSE stream
 * over streaming fetch (so Desktop Bearer and PWA HttpOnly cookie auth work
 * identically). Reconnects with jittered exponential backoff on transient errors.
 */
export function useRelayEvents(args: {
  activeInstance: KlankerInstance | null;
  status: ProcessStatus | null;
  onEvent: (event: RelayEvent) => void;
}): void {
  const { activeInstance, status, onEvent } = args;
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;
  const instId = activeInstance?.id;

  useEffect(() => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    let stop = false;
    let attempt = 0;
    let timer = 0;
    let ctrl: AbortController | null = null;

    const connect = async () => {
      if (stop) return;
      ctrl = new AbortController();
      try {
        await api.openRelayEvents(
          inst,
          ctrl.signal,
          (ev) => {
            attempt = 0;
            cbRef.current(ev);
          },
          ""
        );
      } catch {
        // Closed by abort or transient drop; backoff below handles reconnect.
      }
      if (stop) return;
      attempt += 1;
      const baseMs = Math.min(30_000, 1_000 * Math.pow(2, Math.min(attempt, 5)));
      const jitterMs = Math.floor(Math.random() * 600);
      timer = window.setTimeout(() => void connect(), baseMs + jitterMs);
    };

    void connect();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
      ctrl?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId, status?.state, activeInstance?.secret]);
}
