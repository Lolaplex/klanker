import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { KlankerInstance, PendingApproval, ProcessStatus } from "../types/klanker";
import { api, notifyWhenUnfocused } from "../services/api";

/**
 * Pending-approval poll (3s) for the active instance + the decide path.
 * A newly pending approval fires a desktop notification only while the
 * window is unfocused (klanker#59).
 */
export function useApprovals(args: {
  activeInstance: KlankerInstance | null;
  status: ProcessStatus | null;
  workspaceId?: string;
  /** Owning session + deciding device of the open chat — approvals that
   *  name a different session/device are skipped (never decide a foreign
   *  session's ask under this banner). Refs: the caller's chat/binding
   *  state is declared after this hook. */
  sessionRef?: MutableRefObject<string>;
  deviceRef?: MutableRefObject<string>;
}): {
  pending: PendingApproval | null;
  deciding: boolean;
  decideError: string | null;
  handleDecide: (allow: boolean, remember?: boolean) => Promise<void>;
  refresh: () => void;
  reset: () => void;
} {
  const { activeInstance, status, workspaceId = "", sessionRef, deviceRef } = args;
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const pollSeq = useRef(0);
  const lastNotifiedApprovalRef = useRef<string>("");
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeInstance?.id ?? null;
  const instId = activeInstance?.id;

  const refresh = () => {
    setRefreshTick((n) => n + 1);
  };

  const reset = () => {
    setPending(null);
    setDecideError(null);
    setDeciding(false);
  };

  // Approvals poll + SSE nudge
  useEffect(() => {
    const inst = activeInstance;
    if (!inst || status?.state !== "running") return;
    let stop = false;
    const tick = async () => {
      const mine = ++pollSeq.current;
      try {
        const next = await api.pendingApproval(inst, workspaceId, {
          session: sessionRef?.current || "",
          device: deviceRef?.current || "",
        });
        if (!stop && mine === pollSeq.current) {
          if (next && next.id !== lastNotifiedApprovalRef.current) {
            lastNotifiedApprovalRef.current = next.id;
            const tool = next.summary || next.tool || "Pending tool approval";
            void notifyWhenUnfocused("Klanker needs approval", `${workspaceId ? `${workspaceId} — ` : ""}${tool}`);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId, workspaceId, status?.state, refreshTick]);

  const handleDecide = async (allow: boolean, remember = false) => {
    const inst = activeInstance;
    if (!inst || !pending || deciding) return;
    const approvalId = pending.id;
    setDeciding(true);
    setDecideError(null);
    try {
      await api.resolveApproval(inst, approvalId, allow, remember);
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

  return { pending, deciding, decideError, handleDecide, refresh, reset };
}
