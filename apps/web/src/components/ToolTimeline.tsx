import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleDashed, FileDiff, Hammer, X } from "lucide-react";
import type { SessionEvent } from "../types/klanker";
import type { TurnEvent } from "../turnStream";

export type TimelineStep = {
  id: string;
  kind: "tool" | "file" | "llm" | "error";
  title: string;
  status: "running" | "ok" | "error";
  ts?: string;
  args?: string;
  result?: string;
  error?: string;
  durationMs?: number;
};

export type UsageStats = { tokensIn: number; tokensOut: number; costUsd: number; model?: string };

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Historical U13 trace projection. Ordered by the trace order/timestamp and
 * keeps tool_call, file_edit, llm_call and error rows instead of discarding
 * them as plain chat history does. */
export function stepsFromSessionEvents(events: SessionEvent[]): TimelineStep[] {
  const out: TimelineStep[] = [];
  events.forEach((e, i) => {
    const type = String(e.type || "");
    if (!["tool_call", "file_edit", "llm_call", "error"].includes(type)) return;
    const status = str(e.status);
    const error = str(e.error);
    const common = {
      id: `${type}:${e.ts || i}:${i}`,
      ts: typeof e.ts === "string" ? e.ts : undefined,
      args: str(e.args),
      result: str(e.result),
      error,
      durationMs: num(e.duration_ms),
    };
    if (type === "tool_call") {
      out.push({ ...common, kind: "tool", title: str(e.tool) || "tool", status: error || status === "error" ? "error" : "ok" });
    } else if (type === "file_edit") {
      const plus = num(e.lines_added) ?? 0;
      const minus = num(e.lines_removed) ?? 0;
      out.push({ ...common, kind: "file", title: str(e.file) || "file edit", status: "ok", result: `+${plus} −${minus}${str(e.diff) ? `\n${str(e.diff)}` : ""}` });
    } else if (type === "llm_call") {
      out.push({ ...common, kind: "llm", title: str(e.model) || "model", status: "ok", result: `${num(e.tokens_in) ?? 0} in / ${num(e.tokens_out) ?? 0} out${num(e.cost_usd) ? ` · $${num(e.cost_usd)?.toFixed(6)}` : ""}` });
    } else {
      out.push({ ...common, kind: "error", title: str(e.tool) || "error", status: "error", error: error || str(e.message) });
    }
  });
  return out.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
}

/** rAF-batch friendly live reducer for U13 SSE frames. */
export function applyLiveTurnEvent(steps: TimelineStep[], ev: TurnEvent): TimelineStep[] {
  if (ev.type === "tool_start") {
    const id = ev.id || `live:${steps.length}`;
    if (steps.some((s) => s.id === id)) return steps;
    return [...steps, { id, kind: "tool", title: ev.tool || "tool", status: "running", args: ev.args_preview || "" }];
  }
  if (ev.type === "tool_end") {
    const id = ev.id || "";
    const idx = steps.findIndex((s) => s.id === id);
    const nextStep: TimelineStep = {
      id: id || `live-end:${steps.length}`,
      kind: "tool",
      title: ev.tool || steps[idx]?.title || "tool",
      status: ev.ok === false || ev.error ? "error" : "ok",
      args: steps[idx]?.args,
      result: ev.result_preview || steps[idx]?.result,
      error: ev.error,
      durationMs: ev.duration_ms,
    };
    if (idx < 0) return [...steps, nextStep];
    const copy = [...steps];
    copy[idx] = { ...copy[idx], ...nextStep };
    return copy;
  }
  if (ev.type === "error") {
    return [...steps, { id: `live-error:${steps.length}`, kind: "error", title: "stream error", status: "error", error: ev.text || "error" }];
  }
  return steps;
}

export function usageFromTurnEvent(cur: UsageStats, ev: TurnEvent): UsageStats {
  if (ev.type !== "usage") return cur;
  return {
    tokensIn: cur.tokensIn + (ev.tokens_in || 0),
    tokensOut: cur.tokensOut + (ev.tokens_out || 0),
    costUsd: cur.costUsd + (ev.est_cost_usd || 0),
    model: ev.model || cur.model,
  };
}

function icon(step: TimelineStep) {
  if (step.status === "running") return <CircleDashed className="h-3.5 w-3.5 animate-spin text-ink-muted" />;
  if (step.status === "error" || step.kind === "error") return <X className="h-3.5 w-3.5 text-ink-primary" />;
  if (step.kind === "file") return <FileDiff className="h-3.5 w-3.5 text-ink-secondary" />;
  return <Check className="h-3.5 w-3.5 text-ink-secondary" />;
}

export function ToolTimeline({ steps, usage, defaultOpen = false, scopeLabel = "latest turn" }: { steps: TimelineStep[]; usage?: UsageStats; defaultOpen?: boolean; scopeLabel?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const rows = useMemo(() => steps.slice(-80), [steps]);
  if (!rows.length) return null;
  return (
    <section className="mb-3 rounded-md border border-subtle bg-surface text-[11px]" data-testid="tool-timeline">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-ink-secondary hover:bg-hover">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Hammer className="h-3.5 w-3.5" />
        <span className="font-semibold text-ink-primary">Tool timeline</span>
        <span className="text-ink-muted">{scopeLabel} · {rows.length} step{rows.length === 1 ? "" : "s"}</span>
        {usage && (usage.tokensIn || usage.tokensOut) ? (
          <span className="ml-auto text-ink-muted" data-testid="usage-meter">
            {usage.tokensIn + usage.tokensOut} tok{usage.costUsd ? ` · $${usage.costUsd.toFixed(6)}` : ""}{usage.model ? ` · ${usage.model}` : ""}
          </span>
        ) : null}
      </button>
      {open ? (
        <ol className="max-h-72 overflow-y-auto border-t border-subtle px-2 py-1.5">
          {rows.map((s) => (
            <li key={s.id} className="border-l border-strong pl-2 py-1 ml-1.5">
              <details>
                <summary className="flex cursor-pointer list-none items-center gap-2 text-ink-secondary">
                  {icon(s)}
                  <span className="font-semibold text-ink-primary">{s.title}</span>
                  <span className="text-ink-muted">{s.status}</span>
                  {typeof s.durationMs === "number" ? <span className="text-ink-muted">{Math.round(s.durationMs)}ms</span> : null}
                </summary>
                {s.args ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-main p-2 text-ink-secondary">args: {s.args}</pre> : null}
                {s.result ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-main p-2 text-ink-secondary">{s.result}</pre> : null}
                {s.error ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-main p-2 text-ink-primary">{s.error}</pre> : null}
              </details>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
