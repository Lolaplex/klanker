import { useCallback, useEffect, useState } from "react";
import { AtSign, Copy, ExternalLink, FileText, Folder, GitBranch, Play, RefreshCw, Save, Search, Skull, Trash2 } from "lucide-react";
import type { KlankerInstance } from "../../types/klanker";
import { api } from "../../services/api";
import { fetchSWR, prefetchSWR, swrKey, useSWR } from "../../services/swrCache";
import {
  deleteApprovalAllowlistPattern,
  deleteMemoryFile,
  deleteSkill,
  getBgLogs,
  getDoctorReport,
  getSessionGit,
  getUsageStats,
  getWorkspaceGit,
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
import { useContextMenu, type ContextMenuItem } from "../ui/ContextMenu";

type Props = WorkbenchTabProps & { instance: KlankerInstance; workspace: string; session: string; active?: boolean };

const btn = "inline-flex h-7 items-center gap-1 rounded-md border border-subtle bg-elevated px-2 text-[10px] text-ink-secondary hover:border-strong hover:bg-hover hover:text-ink-primary disabled:opacity-40";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function workbenchRowItems(path: string, open: () => void, notify: (message: string, kind?: "info" | "success" | "error") => void): ContextMenuItem[] {
  return [
    { id: "open-detail", label: "Open in Detail", icon: <ExternalLink className="h-3 w-3" />, onSelect: open },
    { id: "copy-path", label: "Copy path", icon: <Copy className="h-3 w-3" />, onSelect: () => {
      void navigator.clipboard?.writeText(path).then(() => notify("path copied", "success"), () => notify("copy failed", "error"));
    } },
    { id: "mention-path", label: "Mention @path in Composer", icon: <AtSign className="h-3 w-3" />, onSelect: () => {
      window.dispatchEvent(new CustomEvent("klanker:insert-mention", { detail: { mention: `@${path}`, path } }));
    } },
  ];
}

function RevalidatingPulse({ show }: { show: boolean }) {
  if (!show) return null;
  return <span data-testid="swr-revalidating" className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim" aria-label="refreshing" />;
}

function StateLine({ loading, error, empty }: { loading: boolean; error: string; empty?: boolean }) {
  if (error) return <div className="border-b border-subtle px-3 py-2 text-red-500">{error}</div>;
  if (loading) return <div className="p-4 text-ink-dim">loading…</div>;
  if (empty) return <div className="p-4 text-ink-dim">nothing here yet</div>;
  return null;
}

export function ChangesTab({ instance, workspace, session, openDetail, notify, active = true }: Props) {
  const { openMenu } = useContextMenu();
  const gitStatus = useCallback(
    (file = "") => session ? getSessionGit(instance, workspace, session, file) : getWorkspaceGit(instance, workspace, file),
    [instance, workspace, session]
  );
  const cacheKey = swrKey(instance.id, workspace, `git:${session || "workspace"}`);
  const load = useCallback(() => gitStatus(), [gitStatus]);
  const swr = useSWR<SessionGitStatus>(cacheKey, load, {
    ttlMs: 5_000,
    persist: "session",
    enabled: active,
    revalidateOnFocus: true,
    refreshIntervalMs: 5_000,
  });
  const data = swr.data;
  const error = swr.error;
  const reload = swr.refresh;
  const diffKey = useCallback((file: string) => swrKey(instance.id, workspace, `git:diff:${session || "workspace"}:${file}`), [instance.id, workspace, session]);
  const openFileDiff = useCallback((file: string) => {
    void fetchSWR(diffKey(file), () => gitStatus(file), { ttlMs: 5_000, persist: "session" })
      .then((d) => openDetail({ title: file, body: d.diff, diff: d.diff, truncated: d.diff_truncated }))
      .catch((e) => notify(`diff: ${errText(e)}`, "error"));
  }, [diffKey, gitStatus, notify, openDetail]);
  const warmFileDiff = useCallback((file: string) => {
    prefetchSWR(diffKey(file), () => gitStatus(file), { ttlMs: 5_000, persist: "session" });
  }, [diffKey, gitStatus]);
  if (!data) return <StateLine loading={swr.isLoading} error={error} />;
  if (!data.is_git) return <div className="p-4 text-ink-dim">{session ? "session worktree" : "workspace"} is not a git repository</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-subtle px-3 py-2">
        <GitBranch className="h-3.5 w-3.5 text-ink-dim" />
        <span className="min-w-0 flex-1 truncate text-ink-primary">{data.branch || "detached"}</span>
        {data.wip_unpushed && <span className="rounded-full bg-accent px-1.5 py-0.5 text-[9px] uppercase text-accent-ink">wip unpushed</span>}
        <RevalidatingPulse show={swr.isRevalidating} />
        <button type="button" className={btn} onClick={() => void reload()}><RefreshCw className="h-3 w-3" />refresh</button>
      </div>
      <StateLine loading={false} error={error} empty={data.dirty_files.length === 0} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.dirty_files.map((f) => (
          <button
            key={`${f.status}:${f.path}`}
            type="button"
            onClick={() => openFileDiff(f.path)}
            onPointerEnter={() => warmFileDiff(f.path)}
            onFocus={() => warmFileDiff(f.path)}
            onContextMenu={(e) => openMenu(e, workbenchRowItems(f.path, () => openFileDiff(f.path), notify))}
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

export function FilesTab({ instance, workspace, openDetail, notify, active = true }: Props) {
  const { openMenu } = useContextMenu();
  const [path, setPath] = useState(".");
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<{ path: string; line: number; text: string }[] | null>(null);
  const [grepError, setGrepError] = useState("");
  const treeKey = swrKey(instance.id, workspace, `files:tree:${path}`);
  const tree = useSWR(treeKey, () => listWorkbenchFiles(instance, workspace, path), {
    ttlMs: 15_000,
    persist: "session",
    enabled: active,
    revalidateOnFocus: true,
  });
  const entries: WorkbenchFileEntry[] = tree.data?.entries ?? [];
  const shownPath = tree.data?.path || path;
  const error = grepError || tree.error;
  const navigate = useCallback((next: string) => {
    setGrepError("");
    setMatches(null);
    setPath(next || ".");
  }, []);
  const entryPath = useCallback((name: string) => shownPath === "." ? name : `${shownPath.replace(/\/+$/, "")}/${name}`, [shownPath]);
  const fileKey = useCallback((file: string) => swrKey(instance.id, workspace, `files:content:${file}`), [instance.id, workspace]);
  const readFile = useCallback((file: string) => fetchSWR(fileKey(file), () => readWorkbenchFile(instance, workspace, file), { ttlMs: 15_000, persist: "session" }), [fileKey, instance, workspace]);
  const openFile = useCallback((name: string) => {
    const p = entryPath(name);
    void readFile(p)
      .then((r) => openDetail({ title: r.path, body: r.content, truncated: r.truncated }))
      .catch((e) => notify(`read: ${errText(e)}`, "error"));
  }, [entryPath, notify, openDetail, readFile]);
  const warmEntry = useCallback((entry: WorkbenchFileEntry) => {
    const p = entryPath(entry.name);
    if (entry.type === "dir") prefetchSWR(swrKey(instance.id, workspace, `files:tree:${p}`), () => listWorkbenchFiles(instance, workspace, p), { ttlMs: 15_000, persist: "session" });
    else prefetchSWR(fileKey(p), () => readWorkbenchFile(instance, workspace, p), { ttlMs: 15_000, persist: "session" });
  }, [entryPath, fileKey, instance, workspace]);
  const openMatch = useCallback((m: { path: string; line: number; text: string }) => {
    void readFile(m.path)
      .then((r) => openDetail({ title: `${m.path}:${m.line}`, body: r.content, truncated: r.truncated }))
      .catch((e) => notify(`read: ${errText(e)}`, "error"));
  }, [notify, openDetail, readFile]);
  const parent = shownPath.includes("/") ? shownPath.split("/").slice(0, -1).join("/") || "." : ".";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form className="flex gap-1 border-b border-subtle p-2" onSubmit={(e) => {
        e.preventDefault();
        if (!q.trim()) return;
        void grepWorkbenchFiles(instance, workspace, q.trim(), shownPath)
          .then((r) => setMatches(r.matches))
          .catch((e2) => setGrepError(errText(e2)));
      }}>
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-dim" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`grep ${shownPath}`} className={`${inputClass} pl-7 text-[11px]`} aria-label="Search files" />
        </div>
        <button className={btn} type="submit">grep</button>
      </form>
      <div className="flex items-center gap-1 border-b border-subtle px-3 py-1.5 text-[10px] text-ink-dim">
        <button type="button" onClick={() => navigate(".")} className="hover:text-ink-primary">root</button>
        <span>/</span><span className="truncate">{shownPath}</span>
        <RevalidatingPulse show={tree.isRevalidating} />
        <button type="button" className={`${btn} ml-auto`} onClick={() => void tree.refresh()}><RefreshCw className="h-3 w-3" /></button>
      </div>
      {error && <div className="border-b border-subtle px-3 py-2 text-red-500">{error}</div>}
      {!tree.data && <StateLine loading={tree.isLoading} error="" />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {matches ? (
          matches.map((m) => (
            <button key={`${m.path}:${m.line}`} type="button" className="block w-full border-b border-subtle px-3 py-2 text-left hover:bg-hover" onClick={() => openMatch(m)} onPointerEnter={() => prefetchSWR(fileKey(m.path), () => readWorkbenchFile(instance, workspace, m.path), { ttlMs: 15_000, persist: "session" })} onContextMenu={(e) => openMenu(e, workbenchRowItems(m.path, () => openMatch(m), notify))}>
              <span className="text-ink-primary">{m.path}:{m.line}</span>
              <span className="block truncate text-[10px] text-ink-dim">{m.text}</span>
            </button>
          ))
        ) : (
          <>
            {shownPath !== "." && <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-secondary hover:bg-hover" onClick={() => navigate(parent)}><Folder className="h-3.5 w-3.5" />..</button>}
            {entries.map((e) => (
              <button key={e.name} type="button" className="flex w-full items-center gap-2 border-b border-subtle px-3 py-2 text-left hover:bg-hover" onClick={() => e.type === "dir" ? navigate(entryPath(e.name)) : openFile(e.name)} onPointerEnter={() => warmEntry(e)} onFocus={() => warmEntry(e)} onContextMenu={(ev) => openMenu(ev, workbenchRowItems(entryPath(e.name), () => {
                if (e.type === "dir") navigate(entryPath(e.name));
                else openFile(e.name);
              }, notify))}>
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

export function TracesTab({ instance, workspace, session, active = true }: Props) {
  const statsKey = swrKey(instance.id, workspace, `traces:usage:${session || "workspace"}`);
  const doctorKey = swrKey(instance.id, workspace, "doctor");
  const statsSwr = useSWR<UsageStats>(statsKey, () => getUsageStats(instance, workspace, session, 7), {
    ttlMs: 30_000,
    persist: "session",
    enabled: active,
    revalidateOnFocus: true,
  });
  const doctorSwr = useSWR<{ checks: DoctorCheck[]; failed: number; warned: number }>(doctorKey, () => getDoctorReport(instance), {
    ttlMs: 60_000,
    persist: "session",
    enabled: active,
    revalidateOnFocus: true,
  });
  const s = statsSwr.data;
  const doctor = doctorSwr.data;
  const error = statsSwr.error || doctorSwr.error;
  const reload = () => {
    void statsSwr.refresh().catch(() => {});
    void doctorSwr.refresh().catch(() => {});
  };
  if (!s || !doctor) return <StateLine loading={statsSwr.isLoading || doctorSwr.isLoading} error={error} />;
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-2 flex items-center justify-end gap-2"><RevalidatingPulse show={statsSwr.isRevalidating || doctorSwr.isRevalidating} /><button type="button" className={btn} onClick={reload}><RefreshCw className="h-3 w-3" />refresh</button></div>
      {error && <div className="mb-2 rounded border border-subtle px-2 py-1 text-red-500">{error}</div>}
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
      <Section title={`doctor · ${doctor.failed} fail · ${doctor.warned} warn`}>
        {doctor.checks.map((c) => (
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

export function BgTab({ instance, workspace, openDetail, notify, active = true }: Props) {
  const key = swrKey(instance.id, workspace, "bg");
  const swr = useSWR<BgSession[]>(key, () => listBgSessions(instance, workspace), {
    ttlMs: 5_000,
    persist: "session",
    enabled: active,
    revalidateOnFocus: true,
    refreshIntervalMs: 5_000,
  });
  const data = swr.data;
  const error = swr.error;
  const reload = swr.refresh;
  const openLogs = useCallback((id: string) => {
    void fetchSWR(swrKey(instance.id, workspace, `bg:logs:${id}`), () => getBgLogs(instance, id), { ttlMs: 5_000, persist: "session" })
      .then((r) => openDetail({ title: `${id} · ${r.status}`, body: r.logs }))
      .catch((e) => notify(`logs: ${errText(e)}`, "error"));
  }, [instance, workspace, notify, openDetail]);
  if (!data) return <StateLine loading={swr.isLoading} error={error} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-end gap-2 border-b border-subtle px-3 py-2"><RevalidatingPulse show={swr.isRevalidating} /><button type="button" className={btn} onClick={() => void reload()}><RefreshCw className="h-3 w-3" />refresh</button></div>
      <StateLine loading={false} error={error} empty={data.length === 0} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.map((b) => (
          <div key={b.id} className="border-b border-subtle px-3 py-2">
            <div className="flex items-center gap-2">
              <button type="button" className="min-w-0 flex-1 text-left hover:text-ink-primary" onClick={() => openLogs(b.id)} onPointerEnter={() => prefetchSWR(swrKey(instance.id, workspace, `bg:logs:${b.id}`), () => getBgLogs(instance, b.id), { ttlMs: 5_000, persist: "session" })}>
                <div className="truncate text-ink-primary">{b.task || b.id}</div>
                <div className="truncate text-[10px] text-ink-dim">{b.id} · {b.status} · pid {b.pid}</div>
              </button>
              <button type="button" className={btn} onClick={() => openLogs(b.id)}><Play className="h-3 w-3" />logs</button>
              {(b.status === "running" || b.status === "started") && <button type="button" className={btn} onClick={() => void killBgSession(instance, b.id).then(() => { notify(`killed ${b.id}`, "success"); void reload(); }).catch((e) => notify(`kill: ${errText(e)}`, "error"))}><Skull className="h-3 w-3" />kill</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DataTab({ instance, workspace, openDetail, notify, active = true }: Props) {
  const [storeKind, setStoreKind] = useState<"event" | "task" | "note" | "decision">("task");
  const [storeTitle, setStoreTitle] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [edit, setEdit] = useState<{ kind: "memory" | "skill"; path: string; content: string } | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), q.trim() ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [q]);
  const memorySwr = useSWR<MemoryFileRow[]>(
    swrKey(instance.id, workspace, `memory:${debouncedQ}`),
    () => listMemoryFiles(instance, workspace, debouncedQ),
    { ttlMs: 30_000, persist: "session", enabled: active, revalidateOnFocus: true }
  );
  const skillsSwr = useSWR<SkillRow[]>(
    swrKey(instance.id, workspace, "skills"),
    () => listSkills(instance, workspace),
    { ttlMs: 30_000, persist: "session", enabled: active, revalidateOnFocus: true }
  );
  const allowlistSwr = useSWR<string[]>(
    swrKey(instance.id, workspace, "approval-allowlist"),
    () => listApprovalAllowlist(instance, workspace),
    { ttlMs: 30_000, persist: "session", enabled: active, revalidateOnFocus: true }
  );
  const storeSwr = useSWR(
    swrKey(instance.id, workspace, `store:${storeKind}`),
    async () => {
      const r = await api.listStoreItems(instance, workspace, storeKind);
      return r.supported ? r.items : [];
    },
    { ttlMs: 30_000, persist: "session", enabled: active, revalidateOnFocus: true }
  );
  const memory = memorySwr.data ?? [];
  const skills = skillsSwr.data ?? [];
  const allowlist = allowlistSwr.data ?? [];
  const storeItems = storeSwr.data ?? [];
  const error = memorySwr.error || skillsSwr.error || allowlistSwr.error || storeSwr.error;
  const reload = useCallback(() => {
    void memorySwr.refresh().catch(() => {});
    void skillsSwr.refresh().catch(() => {});
    void allowlistSwr.refresh().catch(() => {});
    void storeSwr.refresh().catch(() => {});
  }, [memorySwr, skillsSwr, allowlistSwr, storeSwr]);
  const memoryContentKey = useCallback((path: string) => swrKey(instance.id, workspace, `memory:content:${path}`), [instance.id, workspace]);
  const skillContentKey = useCallback((name: string) => swrKey(instance.id, workspace, `skills:content:${name}`), [instance.id, workspace]);
  const saveEdit = () => {
    if (!edit) return;
    const run = edit.kind === "memory" ? writeMemoryFile(instance, workspace, edit.path, edit.content) : writeSkill(instance, workspace, edit.path, edit.content);
    void run.then(() => { notify(`${edit.kind} saved`, "success"); setEdit(null); reload(); }).catch((e) => notify(`save: ${errText(e)}`, "error"));
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-subtle p-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter memory" aria-label="Filter memory" className={`${inputClass} text-[11px]`} />
        <RevalidatingPulse show={memorySwr.isRevalidating || skillsSwr.isRevalidating || allowlistSwr.isRevalidating || storeSwr.isRevalidating} />
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
            <div key={m.path} className="flex items-center gap-1 border-b border-subtle py-1" onPointerEnter={() => prefetchSWR(memoryContentKey(m.path), () => readMemoryFile(instance, workspace, m.path), { ttlMs: 30_000, persist: "session" })}>
              <button type="button" className="min-w-0 flex-1 truncate text-left text-ink-primary hover:underline" onClick={() => void fetchSWR(memoryContentKey(m.path), () => readMemoryFile(instance, workspace, m.path), { ttlMs: 30_000, persist: "session" }).then((content) => setEdit({ kind: "memory", path: m.path, content })).catch((e) => notify(`memory: ${errText(e)}`, "error"))}>{m.path}</button>
              <button type="button" aria-label={`Preview ${m.path}`} className={btn} onClick={() => void fetchSWR(memoryContentKey(m.path), () => readMemoryFile(instance, workspace, m.path), { ttlMs: 30_000, persist: "session" }).then((content) => openDetail({ title: m.path, body: content }))}>view</button>
              <button type="button" aria-label={`Delete ${m.path}`} className={btn} onClick={() => void deleteMemoryFile(instance, workspace, m.path).then(reload).catch((e) => notify(`delete: ${errText(e)}`, "error"))}><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
          {memory.length === 0 && <div className="text-ink-dim">no memory files</div>}
        </Section>
        <Section title="skills">
          <div className="mb-1 flex justify-end"><button type="button" className={btn} onClick={() => setEdit({ kind: "skill", path: "new-skill", content: "# Skill" + String.fromCharCode(10, 10) })}>new skill</button></div>
          {skills.map((s) => (
            <div key={s.name} className="flex items-center gap-1 border-b border-subtle py-1" onPointerEnter={() => prefetchSWR(skillContentKey(s.name), () => readSkill(instance, workspace, s.name), { ttlMs: 30_000, persist: "session" })}>
              <button type="button" className="min-w-0 flex-1 truncate text-left text-ink-primary hover:underline" onClick={() => void fetchSWR(skillContentKey(s.name), () => readSkill(instance, workspace, s.name), { ttlMs: 30_000, persist: "session" }).then((content) => setEdit({ kind: "skill", path: s.name, content })).catch((e) => notify(`skill: ${errText(e)}`, "error"))}>{s.name}</button>
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
              <button type="button" className={btn} onClick={() => void deleteApprovalAllowlistPattern(instance, workspace, p).then(() => { void allowlistSwr.refresh().catch(() => {}); }).catch((e) => notify(`allowlist: ${errText(e)}`, "error"))}>remove</button>
            </div>
          ))}
          {allowlist.length === 0 && <div className="text-ink-dim">no remembered approvals</div>}
        </Section>
      </div>
    </div>
  );
}
