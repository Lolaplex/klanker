import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Plus, RefreshCw } from "lucide-react";
import type { HubLease, InboxTask, KlankerInstance, WsInbox } from "../types/klanker";
import { api } from "../services/api";
import { Select } from "./ui/Select";
import { inputClass, labelClass } from "./ui/inputClass";


const STATUS_STYLE: Record<string, string> = {
  open: "border-accent text-ink-primary",
  pending: "border-accent text-ink-primary",
  running: "border-amber-500 text-amber-500",
  done: "border-strong text-ink-muted",
  failed: "border-red-500 text-red-500",
};

export function statusPill(status: string): { text: string; cls: string } {
  const key = (status || "open").toLowerCase();
  return { text: key, cls: STATUS_STYLE[key] || "border-strong text-ink-muted" };
}

/**
 * Workspace team inbox (klanker#166 U11): the ws-wide recent feed
 * (`WsInbox.recent`) enriched with per-persona task rows — the feed
 * flattens events and drops reply_summary, so task detail is merged in
 * by task id. Lease badges come from /v1/hub/leases.
 */
export function WsInboxTab({
  instance,
  workspace,
  personas,
  onOpenChat,
}: {
  instance: KlankerInstance;
  workspace: string;
  personas: { id: string; name?: string }[];
  /** (ws, persona) — the App selects the contact and closes the modal. */
  onOpenChat?: (ws: string, persona: string) => void;
}) {
  const [feed, setFeed] = useState<WsInbox | null>(null);
  const [tasks, setTasks] = useState<Record<string, InboxTask>>({});
  const [leases, setLeases] = useState<HubLease[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [handoffPersona, setHandoffPersona] = useState("");
  const [handoffTitle, setHandoffTitle] = useState("");
  const [handoffNote, setHandoffNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Per-row wake-handoff mini-form (klanker#169 U15): task id being
  // handed off, target peer, optional note.
  const [handoffTask, setHandoffTask] = useState<string | null>(null);
  const [handoffPeer, setHandoffPeer] = useState("");
  const [handoffTaskNote, setHandoffTaskNote] = useState("");

  const personaName = useCallback(
    (id: string) => personas.find((p) => p.id === id)?.name || id,
    [personas]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setNote(null);
    try {
      const [inbox, leaseRows] = await Promise.all([
        api.wsInbox(instance, workspace),
        api.fetchHubLeases().catch(() => [] as HubLease[]),
      ]);
      setFeed(inbox || { personas: {}, recent: [] });
      setLeases(leaseRows.filter((l) => l.ws === workspace));
      // Enrich: per-persona task detail carries reply_summary + owner.
      const ids = Object.keys(inbox?.personas || {});
      const taskLists = await Promise.all(
        ids.map((p) => api.personaInboxTasks(instance, workspace, p))
      );
      const map: Record<string, InboxTask> = {};
      taskLists.flat().forEach((t) => {
        if (t.id) map[t.id] = t;
      });
      setTasks(map);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [instance, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const wsLeased = leases.length > 0;

  const createHandoff = async () => {
    const persona = handoffPersona || personas[0]?.id || "";
    const title = handoffTitle.trim();
    if (!persona || !title || busy) return;
    setBusy(true);
    setNote(null);
    try {
      await api.createInboxTask(instance, workspace, persona, { title, note: handoffNote.trim() });
      setHandoffTitle("");
      setHandoffNote("");
      setComposeOpen(false);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const wakeHandoff = async (taskId: string, fromPersona: string) => {
    const to = handoffPeer;
    if (!to || busy) return;
    setBusy(true);
    setNote(null);
    try {
      await api.handoffInboxTask(instance, workspace, fromPersona, taskId, {
        to,
        note: handoffTaskNote.trim(),
        wake: true,
      });
      setHandoffTask(null);
      setHandoffPeer("");
      setHandoffTaskNote("");
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => feed?.recent || [], [feed]);
  const totalOpen = useMemo(
    () => Object.values(feed?.personas || {}).reduce((n, c) => n + (c.open ?? 0), 0),
    [feed]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-dim">
          {totalOpen > 0 ? `${totalOpen} open handoff${totalOpen === 1 ? "" : "s"}` : "team inbox"}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh inbox"
            aria-label="Refresh inbox"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-strong text-ink-muted hover:text-ink-primary"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => setComposeOpen((v) => !v)}
            className="inline-flex h-7 items-center gap-1 px-2 rounded-md border border-strong text-[11px] text-ink-secondary hover:text-ink-primary hover:bg-elevated"
          >
            <Plus className="w-3 h-3" /> new handoff
          </button>
        </div>
      </div>

      {composeOpen && (
        <div className="flex flex-col gap-2 border border-subtle rounded-md p-2.5">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>to persona</span>
            <Select
              value={handoffPersona || personas[0]?.id || ""}
              onChange={setHandoffPersona}
              ariaLabel="handoff target persona"
              options={personas.map((p) => ({ value: p.id, label: p.name || p.id }))}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>title</span>
            <input
              className={inputClass}
              value={handoffTitle}
              onChange={(e) => setHandoffTitle(e.target.value)}
              placeholder="what needs doing"
              aria-label="handoff title"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>note (optional)</span>
            <textarea
              className={`${inputClass} resize-y min-h-16`}
              value={handoffNote}
              onChange={(e) => setHandoffNote(e.target.value)}
              aria-label="handoff note"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy || !handoffTitle.trim() || personas.length === 0}
              onClick={() => void createHandoff()}
              className="px-3 py-1.5 border border-accent rounded-md bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-50 text-[11px]"
            >
              {busy ? "sending…" : "send handoff"}
            </button>
          </div>
        </div>
      )}

      {note && <div className="text-red-500 text-[11px] break-words">{note}</div>}
      {loading && <p className="text-[10px] text-ink-dim">loading inbox…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-[11px] text-ink-dim">
          no handoffs yet — personas pass work to each other here.
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {rows.map((row, i) => {
          const task = row.task ? tasks[row.task] : undefined;
          const pill = statusPill(task?.status || row.status || "open");
          const running = pill.text === "running";
          const reply = task?.reply_summary?.trim();
          const target = row.to || task?.owner || "";
          return (
            <div key={`${row.task || "row"}-${row.at || i}`} className="border border-subtle rounded-md p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-ink-primary truncate flex-1 text-[12px]">{row.title || task?.title || "(untitled)"}</span>
                {running && wsLeased && (
                  <span
                    className="shrink-0 px-1.5 py-0.5 rounded-full border border-amber-500 text-[9px] uppercase tracking-wider text-amber-500"
                    title={`active execution lease${leases[0] ? ` — ${leases[0].holder}` : ""}`}
                  >
                    lease
                  </span>
                )}
                <span className={`shrink-0 px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wider ${pill.cls}`}>
                  {pill.text}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-ink-muted min-w-0">
                <span className="truncate">{personaName(row.from || "?")}</span>
                <ArrowRight className="w-3 h-3 shrink-0" />
                <span className="truncate">{personaName(target || "?")}</span>
                {row.at && <span className="shrink-0 text-ink-dim">· {row.at.slice(0, 16).replace("T", " ")}</span>}
              </div>
              {reply && (
                <p className="text-[11px] text-ink-secondary whitespace-pre-wrap break-words line-clamp-2">
                  {reply.slice(0, 200)}
                </p>
              )}
              <div className="flex items-center gap-1.5">
                {onOpenChat && target && (
                  <button
                    type="button"
                    onClick={() => onOpenChat(workspace, target)}
                    className="px-2 py-1 border border-strong rounded-md text-[10px] text-ink-secondary hover:text-ink-primary hover:bg-elevated"
                    aria-label={`Open chat with ${personaName(target)}`}
                  >
                    open chat
                  </button>
                )}
                {row.task && personas.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setHandoffTask(handoffTask === row.task ? null : (row.task ?? null));
                      setHandoffPeer(personas.find((p) => p.id !== target)?.id || "");
                      setHandoffTaskNote("");
                    }}
                    className="px-2 py-1 border border-strong rounded-md text-[10px] text-ink-secondary hover:text-ink-primary hover:bg-elevated"
                    aria-label={`Handoff task ${row.title || row.task} to a peer`}
                  >
                    handoff &amp; wake
                  </button>
                )}
              </div>
              {handoffTask === row.task && row.task && (
                <div className="flex items-end gap-1.5 border-t border-subtle pt-1.5">
                  <label className="flex flex-col gap-1 w-36 shrink-0">
                    <span className={labelClass}>to peer</span>
                    <Select
                      value={handoffPeer}
                      onChange={setHandoffPeer}
                      ariaLabel="handoff peer"
                      options={personas
                        .filter((p) => p.id !== target)
                        .map((p) => ({ value: p.id, label: p.name || p.id }))}
                    />
                  </label>
                  <label className="flex flex-col gap-1 flex-1 min-w-0">
                    <span className={labelClass}>note</span>
                    <input
                      className={inputClass}
                      value={handoffTaskNote}
                      onChange={(e) => setHandoffTaskNote(e.target.value)}
                      placeholder="context for the peer"
                      aria-label="handoff note"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !handoffPeer}
                    onClick={() => void wakeHandoff(row.task as string, target || row.from || "")}
                    className="shrink-0 px-2.5 py-1.5 border border-accent rounded-md bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-50 text-[10px]"
                    aria-label="Send handoff and wake the peer"
                  >
                    {busy ? "waking…" : "wake"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
