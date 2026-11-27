import { useCallback, useEffect, useState } from "react";
import { FileText, Folder, GitBranch, Play, RefreshCw, Save, Search, Skull, Trash2 } from "lucide-react";
import type { KlankerInstance, StoreItem } from "../../types/klanker";
import { api } from "../../services/api";
import {
  deleteApprovalAllowlistPattern,
  deleteMemoryFile,
  deleteSkill,
  getBgLogs,
  getDoctorReport,
  getSessionGit,
  getUsageStats,
  grepWorkbenchFiles,
  killBgSession,
  listApprovalAllowlist,
  listBgSessions,
  listMemoryFiles,
  listSkills,
  listWorkbenchFiles,
  readMemoryFile,
  readSkill,
  readWorkbenchFile,
  writeMemoryFile,
  writeSkill,
  type BgSession,
  type DoctorCheck,
  type MemoryFileRow,
  type SessionGitStatus,
  type SkillRow,
  type UsageStats,
  type WorkbenchFileEntry,
} from "../../services/workbenchApi";
import { inputClass } from "../ui/inputClass";
import type { WorkbenchTabProps } from "./types";

type Props = WorkbenchTabProps & { instance: KlankerInstance; workspace: string; session: string };

const btn = "inline-flex h-7 items-center gap-1 rounded-md border border-subtle bg-elevated px-2 text-[10px] text-ink-secondary hover:border-strong hover:bg-hover hover:text-ink-primary disabled:opacity-40";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setError("");
    fn().then(setData).catch((e) => setError(errText(e))).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => reload(), [reload]);
  return { data, error, loading, reload };
}

function StateLine({ loading, error, empty }: { loading: boolean; error: string; empty?: boolean }) {
  if (error) return <div className="border-b border-subtle px-3 py-2 text-red-500">{error}</div>;
  if (loading) return <div className="p-4 text-ink-dim">loading…</div>;
  if (empty) return <div className="p-4 text-ink-dim">nothing here yet</div>;
  return null;
}

export function ChangesTab({ instance, workspace, session, openDetail, notify }: Props) {
  const load = useCallback(() => getSessionGit(instance, workspace, session), [instance, workspace, session]);
  const { data, error, loading, reload } = useAsync<SessionGitStatus>(load, [load]);
  if (!data) return <StateLine loading={loading} error={error} />;
  if (!data.is_git) return <div className="p-4 text-ink-dim">session worktree is not a git repository</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-subtle px-3 py-2">
        <GitBranch className="h-3.5 w-3.5 text-ink-dim" />
        <span className="min-w-0 flex-1 truncate text-ink-primary">{data.branch || "detached"}</span>
        {data.wip_unpushed && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] uppercase text-accent-ink">wip unpushed</span>}
        <button type="button" className={btn} onClick={reload}><RefreshCw className="h-3 w-3" />refresh</button>
      </div>
      <StateLine loading={false} error={error} empty={data.dirty_files.length === 0} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.dirty_files.map((f) => (
          <button
            key={`${f.status}:${f.path}`}
            type="button"
            onClick={() => {
              void getSessionGit(instance, workspace, session, f.path)
                .then((d) => openDetail({ title: f.path, body: d.diff, diff: d.diff, truncated: d.diff_truncated }))
                .catch((e) => notify(`diff: ${errText(e)}`, "error"));
            }}
            className="flex w-full items-center gap-2 border-b border-subtle px-3 py-2 text-left hover:bg-hover"
          >
            <span className="w-7 shrink-0 rounded border border-subtle px-1 text-center text-[9px] uppercase text-ink-muted">{f.status}</span>
            <span className="min-w-0 flex-1 truncate text-ink-primary">{f.path}</span>
          </button>
        ))}
      </div>
      {data.diff && (
        <button type="button" className="border-t border-subtle px-3 py-2 text-left text-ink-secondary hover:bg-hover" onClick={() => openDetail({ title: `${data.branch || "session"} diff`, body: data.diff, diff: data.diff, truncated: data.diff_truncated })}>
          open full patch{data.diff_truncated ? " (truncated)" : ""}
        </button>
      )}
    </div>
  );
}

export function FilesTab({ instance, workspace, openDetail, notify }: Props) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<WorkbenchFileEntry[]>([]);
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback((p = path) => {
    setError("");
    void listWorkbenchFiles(instance, workspace, p)
      .then((r) => { setPath(r.path); setEntries(r.entries); setMatches(null); })
      .catch((e) => setError(errText(e)));
  }, [instance, workspace, path]);
  useEffect(() => load("."), []); // eslint-disable-line react-hooks/exhaustive-deps
  const openFile = (name: string) => {
    const p = path === "." ? name : `${path.replace(/\/+$/, "")}/${name}`;
    void readWorkbenchFile(instance, workspace, p)
      .then((r) => openDetail({ title: r.path, body: r.content, truncated: r.truncated }))
      .catch((e) => notify(`read: ${errText(e)}`, "error"));
  };
  const parent = path.includes("/") ? path.split("/").slice(0, -1).join("/") || "." : ".";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form className="flex gap-1 border-b border-subtle p-2" onSubmit={(e) => {
        e.preventDefault();
        if (!q.trim()) return;
        void grepWorkbenchFiles(instance, workspace, q.trim(), path)
          .then((r) => setMatches(r.matches))
          .catch((e2) => setError(errText(e2)));
      }}>
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-dim" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`grep ${path}`} className={`${inputClass} pl-7 text-[11px]`} aria-label="Search files" />
        </div>
        <button className={btn} type="submit">grep</button>
      </form>
      <div className="flex items-center gap-1 border-b border-subtle px-3 py-1.5 text-[10px] text-ink-dim">
        <button type="button" onClick={() => load(".")} className="hover:text-ink-primary">root</button>
        <span>/</span><span className="truncate">{path}</span>
        <button type="button" className={`${btn} ml-auto`} onClick={() => load(path)}><RefreshCw className="h-3 w-3" /></button>
      </div>
      {error && <div className="border-b border-subtle px-3 py-2 text-red-500">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {matches ? (
          matches.map((m) => (
            <button key={`${m.path}:${m.line}`} type="button" className="block w-full border-b border-subtle px-3 py-2 text-left hover:bg-hover" onClick={() => {
              const file = m.path;
              void readWorkbenchFile(instance, workspace, file).then((r) => openDetail({ title: `${file}:${m.line}`, body: r.content, truncated: r.truncated })).catch((e) => notify(`read: ${errText(e)}`, "error"));
            }}>
              <span className="text-ink-primary">{m.path}:{m.line}</span>
              <span className="block truncate text-[10px] text-ink-dim">{m.text}</span>
            </button>
          ))
        ) : (
          <>
            {path !== "." && <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-secondary hover:bg-hover" onClick={() => load(parent)}><Folder className="h-3.5 w-3.5" />..</button>}
            {entries.map((e) => (
              <button key={e.name} type="button" className="flex w-full items-center gap-2 border-b border-subtle px-3 py-2 text-left hover:bg-hover" onClick={() => e.type === "dir" ? load(path === "." ? e.name : `${path}/${e.name}`) : openFile(e.name)}>
                {e.type === "dir" ? <Folder className="h-3.5 w-3.5 text-ink-dim" /> : <FileText className="h-3.5 w-3.5 text-ink-dim" />}
                <span className="min-w-0 flex-1 truncate text-ink-primary">{e.name}</span>
                <span className="text-[9px] text-ink-dim">{e.type === "dir" ? "dir" : `${e.size}b`}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export function TracesTab({ instance, workspace, session }: Props) {
  const load = useCallback(async () => {
    const [stats, doctor] = await Promise.all([getUsageStats(instance, workspace, session, 7), getDoctorReport(instance)]);
    return { stats, doctor };
  }, [instance, workspace, session]);
  const { data, error, loading, reload } = useAsync<{ stats: UsageStats; doctor: { checks: DoctorCheck[]; failed: number; warned: number } }>(load, [load]);
  if (!data) return <StateLine loading={loading} error={error} />;
  const s = data.stats;
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-2 flex justify-end"><button type="button" className={btn} onClick={reload}><RefreshCw className="h-3 w-3" />refresh</button></div>
      <div className="grid grid-cols-2 gap-2">
        <Metric label="tokens" value={String(s.total_tokens)} detail={`in ${s.tokens_in} · out ${s.tokens_out}`} />
        <Metric label="cost" value={`$${s.est_cost_usd.toFixed(4)}`} detail={`${s.sessions_count} sessions`} />
        <Metric label="tools" value={String(s.tool_calls_total)} detail={`${Math.round(s.tool_success_rate)}% ok`} />
        <Metric label="edits" value={String(s.file_edits_count)} detail={`+${s.lines_added} −${s.lines_removed}`} />
      </div>
      <Section title="top tools">
        {s.top_tools.slice(0, 8).map((t) => <div key={t.tool} className="flex justify-between border-b border-subtle py-1"><span className="truncate text-ink-primary">{t.tool}</span><span className="text-ink-dim">{t.count} · {t.errors} err</span></div>)}
        {s.top_tools.length === 0 && <div className="text-ink-dim">no tool calls</div>}
      </Section>
      <Section title={`doctor · ${data.doctor.failed} fail · ${data.doctor.warned} warn`}>
        {data.doctor.checks.map((c) => (
          <div key={c.name} className="border-b border-subtle py-1.5">
            <div className="flex items-center justify-between"><span className="text-ink-primary">{c.name}</span><span className={c.status === "fail" ? "text-red-500" : c.status === "warn" ? "text-amber-500" : "text-ink-dim"}>{c.status}</span></div>
            {c.detail && <div className="text-[10px] text-ink-dim">{c.detail}</div>}
            {c.hint && c.status !== "pass" && <div className="text-[10px] text-ink-muted">hint: {c.hint}</div>}
          </div>
        ))}
      </Section>
      <Section title="top errors">
        {s.top_errors.slice(0, 5).map((e) => <div key={e.error} className="border-b border-subtle py-1 text-[10px]"><span className="text-red-500">{e.count}×</span> <span className="text-ink-secondary">{e.error}</span></div>)}
        {s.top_errors.length === 0 && <div className="text-ink-dim">no errors in window</div>}
      </Section>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-md border border-subtle bg-main p-2"><div className="text-[9px] uppercase tracking-wider text-ink-dim">{label}</div><div className="mt-1 text-sm font-semibold text-ink-primary">{value}</div><div className="truncate text-[9px] text-ink-dim">{detail}</div></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-3 rounded-md border border-subtle bg-main p-2"><h3 className="mb-1 text-[10px] uppercase tracking-wider text-ink-dim">{title}</h3>{children}</section>;
}

export function BgTab({ instance, workspace, openDetail, notify }: Props) {
  const load = useCallback(() => listBgSessions(instance, workspace), [instance, workspace]);
  const { data, error, loading, reload } = useAsync<BgSession[]>(load, [load]);
  if (!data) return <StateLine loading={loading} error={error} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-end border-b border-subtle px-3 py-2"><button type="button" className={btn} onClick={reload}><RefreshCw className="h-3 w-3" />refresh</button></div>
      <StateLine loading={false} error={error} empty={data.length === 0} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.map((b) => (
          <div key={b.id} className="border-b border-subtle px-3 py-2">
            <div className="flex items-center gap-2">
              <button type="button" className="min-w-0 flex-1 text-left hover:text-ink-primary" onClick={() => void getBgLogs(instance, b.id).then((r) => openDetail({ title: `${b.id} · ${r.status}`, body: r.logs })).catch((e) => notify(`logs: ${errText(e)}`, "error"))}>
                <div className="truncate text-ink-primary">{b.task || b.id}</div>
                <div className="truncate text-[10px] text-ink-dim">{b.id} · {b.status} · pid {b.pid}</div>
              </button>
              <button type="button" className={btn} onClick={() => void getBgLogs(instance, b.id).then((r) => openDetail({ title: `${b.id} · ${r.status}`, body: r.logs }))}><Play className="h-3 w-3" />logs</button>
              {(b.status === "running" || b.status === "started") && <button type="button" className={btn} onClick={() => void killBgSession(instance, b.id).then(() => { notify(`killed ${b.id}`, "success"); reload(); }).catch((e) => notify(`kill: ${errText(e)}`, "error"))}><Skull className="h-3 w-3" />kill</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DataTab({ instance, workspace, openDetail, notify }: Props) {
  const [memory, setMemory] = useState<MemoryFileRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [storeKind, setStoreKind] = useState<"event" | "task" | "note" | "decision">("task");
  const [storeItems, setStoreItems] = useState<StoreItem[]>([]);
  const [storeTitle, setStoreTitle] = useState("");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<{ kind: "memory" | "skill"; path: string; content: string } | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    setError("");
    void Promise.all([
      listMemoryFiles(instance, workspace, q).then(setMemory),
      listSkills(instance, workspace).then(setSkills),
      listApprovalAllowlist(instance, workspace).then(setAllowlist),
      api.listStoreItems(instance, workspace, storeKind).then((r) => setStoreItems(r.supported ? r.items : [])),
    ]).catch((e) => setError(errText(e)));
  }, [instance, workspace, q, storeKind]);
  useEffect(() => {
    const t = window.setTimeout(reload, q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [reload, q]);
  const saveEdit = () => {
    if (!edit) return;
    const run = edit.kind === "memory" ? writeMemoryFile(instance, workspace, edit.path, edit.content) : writeSkill(instance, workspace, edit.path, edit.content);
    void run.then(() => { notify(`${edit.kind} saved`, "success"); setEdit(null); reload(); }).catch((e) => notify(`save: ${errText(e)}`, "error"));
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-subtle p-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter memory" aria-label="Filter memory" className={`${inputClass} text-[11px]`} />
        <button type="button" className={btn} onClick={reload}><RefreshCw className="h-3 w-3" /></button>
      </div>
      {error && <div className="border-b border-subtle px-3 py-2 text-red-500">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {edit && (
          <div className="mb-3 rounded-md border border-subtle bg-main p-2">
            <div className="mb-1 flex items-center justify-between"><span className="truncate text-ink-primary">{edit.kind}: {edit.path}</span><button type="button" className={btn} onClick={saveEdit}><Save className="h-3 w-3" />save</button></div>
            <input value={edit.path} onChange={(e) => setEdit({ ...edit, path: e.target.value })} aria-label={`${edit.kind} path`} className="mb-1 w-full rounded-md border border-subtle hover:border-strong focus:border-strong bg-elevated px-2 py-1 font-mono text-[11px] text-ink-primary outline-none" />
            <textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} aria-label={`Edit ${edit.kind}`} className="h-48 w-full resize-y rounded-md border border-subtle hover:border-strong focus:border-strong bg-elevated p-2 font-mono text-[11px] text-ink-primary outline-none" />
          </div>
        )}
        <Section title={`workspace data · ${storeKind}`}>
          <div className="mb-1 flex flex-wrap gap-1">
            {(["event", "task", "note", "decision"] as const).map((k) => (
              <button key={k} type="button" className={`${btn} ${storeKind === k ? "bg-accent text-accent-ink" : ""}`} onClick={() => setStoreKind(k)}>{k}</button>
            ))}
          </div>
          {storeKind !== "decision" && (
            <form className="mb-1 flex gap-1" onSubmit={(e) => {
              e.preventDefault();
              const title = storeTitle.trim();
              if (!title) return;
              const payload: Record<string, unknown> = { kind: storeKind, title };
              if (storeKind === "event") payload.when = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
              if (storeKind === "task") payload.status = "open";
              if (storeKind === "note") payload.body = title;
              void api.appendStoreItem(instance, workspace, "records", payload)
                .then(() => { setStoreTitle(""); reload(); })
                .catch((err) => notify(`store: ${errText(err)}`, "error"));
            }}>
              <input value={storeTitle} onChange={(e) => setStoreTitle(e.target.value)} placeholder={`new ${storeKind}`} aria-label={`New ${storeKind}`} className="min-w-0 flex-1 rounded-md border border-subtle hover:border-strong focus:border-strong bg-elevated px-2 py-1 text-[11px] text-ink-primary outline-none" />
              <button type="submit" className={btn}>add</button>
            </form>
          )}
          {storeItems.slice(0, 12).map((item) => {
            const label = String(item.attrs?.title || item.attrs?.name || item.attrs?.body || item.id);
            return (
              <button key={item.id} type="button" className="block w-full border-b border-subtle py-1 text-left hover:bg-hover" onClick={() => void api.renderStorePane(instance, workspace, item.id, storeKind === "event" || storeKind === "task" ? "ical" : "markdown").then((r) => openDetail({ title: label, body: r.content })).catch((err) => notify(`store preview: ${errText(err)}`, "error"))}>
                <span className="block truncate text-ink-primary">{label}</span>
                <span className="block truncate text-[9px] text-ink-dim">{String(item.attrs?.when || item.attrs?.status || item.ts || "")}</span>
              </button>
            );
          })}
          {storeItems.length === 0 && <div className="text-ink-dim">no {storeKind} records or store unsupported</div>}
        </Section>
        <Section title="memory">
          <div className="mb-1 flex justify-end"><button type="button" className={btn} onClick={() => setEdit({ kind: "memory", path: `notes/${new Date().toISOString().slice(0, 10)}.md`, content: "" })}>new memory</button></div>
          {memory.map((m) => (
            <div key={m.path} className="flex items-center gap-1 border-b border-subtle py-1">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-ink-primary hover:underline" onClick={() => void readMemoryFile(instance, workspace, m.path).then((content) => setEdit({ kind: "memory", path: m.path, content })).catch((e) => notify(`memory: ${errText(e)}`, "error"))}>{m.path}</button>
              <button type="button" aria-label={`Preview ${m.path}`} className={btn} onClick={() => void readMemoryFile(instance, workspace, m.path).then((content) => openDetail({ title: m.path, body: content }))}>view</button>
              <button type="button" aria-label={`Delete ${m.path}`} className={btn} onClick={() => void deleteMemoryFile(instance, workspace, m.path).then(reload).catch((e) => notify(`delete: ${errText(e)}`, "error"))}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
          {memory.length === 0 && <div className="text-ink-dim">no memory files</div>}
        </Section>
        <Section title="skills">
          <div className="mb-1 flex justify-end"><button type="button" className={btn} onClick={() => setEdit({ kind: "skill", path: "new-skill", content: "# Skill" + String.fromCharCode(10, 10) })}>new skill</button></div>
          {skills.map((s) => (
            <div key={s.name} className="flex items-center gap-1 border-b border-subtle py-1">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-ink-primary hover:underline" onClick={() => void readSkill(instance, workspace, s.name).then((content) => setEdit({ kind: "skill", path: s.name, content })).catch((e) => notify(`skill: ${errText(e)}`, "error"))}>{s.name}</button>
              <span className="text-[9px] text-ink-dim">{s.files} files</span>
              <button type="button" aria-label={`Delete skill ${s.name}`} className={btn} onClick={() => void deleteSkill(instance, workspace, s.name).then(reload).catch((e) => notify(`delete skill: ${errText(e)}`, "error"))}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
          {skills.length === 0 && <div className="text-ink-dim">no workspace skills</div>}
        </Section>
        <Section title="approval allowlist">
          {allowlist.map((p) => (
            <div key={p} className="flex items-center gap-1 border-b border-subtle py-1">
              <code className="min-w-0 flex-1 truncate text-ink-primary">{p}</code>
              <button type="button" className={btn} onClick={() => void deleteApprovalAllowlistPattern(instance, workspace, p).then(setAllowlist).catch((e) => notify(`allowlist: ${errText(e)}`, "error"))}>remove</button>
            </div>
          ))}
          {allowlist.length === 0 && <div className="text-ink-dim">no remembered approvals</div>}
        </Section>
      </div>
    </div>
  );
}
