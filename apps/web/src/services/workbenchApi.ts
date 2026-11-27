import type { KlankerInstance } from "../types/klanker";
import { caps, httpErrorMessage, hydrateSecret, localRelayBaseUrl } from "./api";

/** U14 workbench API helpers (klanker#167). Kept out of services/api.ts so
 *  chat-surface changes never fight the workbench wire contract. */

type WireRow = Record<string, unknown>;
const wstr = (v: unknown): string => (typeof v === "string" ? v : "");
const wnum = (v: unknown): number => (typeof v === "number" ? v : 0);
const wbool = (v: unknown): boolean => v === true;
const mounted = (inst: KlankerInstance) => inst.via === "relay" || inst.via === "channel";

function base(inst: KlankerInstance): string {
  if (mounted(inst)) return `${caps.spawn ? localRelayBaseUrl() : ""}/v1/remote/${encodeURIComponent(inst.id)}`;
  if (inst.kind === "local" && caps.spawn) return localRelayBaseUrl();
  return (inst.endpoint?.base_url || inst.base_url || "").replace(/\/+$/, "");
}

async function request<T = unknown>(inst: KlankerInstance, path: string, init: RequestInit = {}): Promise<T> {
  await hydrateSecret(inst);
  const headers = { ...(init.headers as Record<string, string> | undefined) };
  if (inst.secret && !headers.Authorization) headers.Authorization = `Bearer ${inst.secret}`;
  const res = await fetch(base(inst) + path, { ...init, headers });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(httpErrorMessage(res.status, text));
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const jsonInit = (method: string, body: object): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface ForkSessionResult {
  session: string;
  source_session: string;
  workspace: string;
}

export async function forkSession(
  inst: KlankerInstance,
  workspace: string,
  sourceSession: string,
  newSession = ""
): Promise<ForkSessionResult> {
  const r = await request<WireRow>(
    inst,
    `/v1/klanker/sessions/fork${qs({ workspace })}`,
    jsonInit("POST", { workspace, source_session: sourceSession, ...(newSession ? { new_session: newSession } : {}) })
  );
  return { session: wstr(r.session), source_session: wstr(r.source_session), workspace: wstr(r.workspace) };
}

export interface GitDirtyFile {
  status: string;
  path: string;
}

export interface SessionGitStatus {
  is_git: boolean;
  branch: string;
  repo: string;
  worktree: string;
  dirty_files: GitDirtyFile[];
  wip_unpushed: boolean;
  diff: string;
  diff_truncated: boolean;
}

export async function getSessionGit(
  inst: KlankerInstance,
  workspace: string,
  session: string,
  file = ""
): Promise<SessionGitStatus> {
  const r = await request<WireRow>(inst, `/v1/klanker/sessions/${encodeURIComponent(session)}/git${qs({ workspace, file })}`);
  return {
    is_git: wbool(r.is_git),
    branch: wstr(r.branch),
    repo: wstr(r.repo),
    worktree: wstr(r.worktree),
    dirty_files: Array.isArray(r.dirty_files)
      ? (r.dirty_files as WireRow[]).map((f) => ({ status: wstr(f.status), path: wstr(f.path) }))
      : [],
    wip_unpushed: wbool(r.wip_unpushed),
    diff: wstr(r.diff),
    diff_truncated: wbool(r.diff_truncated),
  };
}

export interface WorkbenchFileEntry {
  name: string;
  type: string;
  size: number;
  mtime?: string;
  target?: string;
}

export async function listWorkbenchFiles(inst: KlankerInstance, workspace: string, path = ".") {
  const r = await request<WireRow>(inst, `/v1/klanker/files${qs({ workspace, path })}`);
  return {
    path: wstr(r.path) || path,
    entries: Array.isArray(r.entries)
      ? (r.entries as WireRow[]).map((e) => ({
          name: wstr(e.name),
          type: wstr(e.type),
          size: wnum(e.size),
          mtime: typeof e.mtime === "string" ? e.mtime : undefined,
          target: typeof e.target === "string" ? e.target : undefined,
        }) as WorkbenchFileEntry)
      : [],
  };
}

export async function readWorkbenchFile(inst: KlankerInstance, workspace: string, path: string, offset = 1, limit = 2000) {
  const r = await request<WireRow>(inst, `/v1/klanker/files/read${qs({ workspace, path, offset, limit })}`);
  return { path: wstr(r.path) || path, content: wstr(r.content), truncated: wbool(r.truncated), line_count: wnum(r.line_count) };
}

export interface WorkbenchGrepMatch {
  path: string;
  line: number;
  text: string;
}

export async function grepWorkbenchFiles(inst: KlankerInstance, workspace: string, q: string, path = ".", glob = "") {
  const r = await request<WireRow>(inst, `/v1/klanker/files/grep${qs({ workspace, q, path, glob })}`);
  return {
    path: wstr(r.path) || path,
    matches: Array.isArray(r.matches)
      ? (r.matches as WireRow[]).map((m) => ({ path: wstr(m.path), line: wnum(m.line), text: wstr(m.text) }))
      : [],
    truncated: wbool(r.truncated),
  };
}

export interface UsageStats {
  sessions_count: number;
  total_events: number;
  tokens_in: number;
  tokens_out: number;
  total_tokens: number;
  est_cost_usd: number;
  tool_calls_total: number;
  tool_calls_ok: number;
  tool_calls_error: number;
  tool_success_rate: number;
  top_tools: { tool: string; count: number; errors: number; avg_duration_ms: number }[];
  file_edits_count: number;
  lines_added: number;
  lines_removed: number;
  top_errors: { error: string; count: number; context: string }[];
}

export async function getUsageStats(inst: KlankerInstance, workspace: string, session = "", days = 7): Promise<UsageStats> {
  const r = await request<WireRow>(inst, `/v1/klanker/stats${qs({ workspace, session, days })}`);
  const s = (r.stats || {}) as WireRow;
  return {
    sessions_count: wnum(s.sessions_count),
    total_events: wnum(s.total_events),
    tokens_in: wnum(s.tokens_in),
    tokens_out: wnum(s.tokens_out),
    total_tokens: wnum(s.total_tokens),
    est_cost_usd: wnum(s.est_cost_usd),
    tool_calls_total: wnum(s.tool_calls_total),
    tool_calls_ok: wnum(s.tool_calls_ok),
    tool_calls_error: wnum(s.tool_calls_error),
    tool_success_rate: wnum(s.tool_success_rate),
    top_tools: Array.isArray(s.top_tools)
      ? (s.top_tools as WireRow[]).map((t) => ({
          tool: wstr(t.tool),
          count: wnum(t.count),
          errors: wnum(t.errors),
          avg_duration_ms: wnum(t.avg_duration_ms),
        }))
      : [],
    file_edits_count: wnum(s.file_edits_count),
    lines_added: wnum(s.lines_added),
    lines_removed: wnum(s.lines_removed),
    top_errors: Array.isArray(s.top_errors)
      ? (s.top_errors as WireRow[]).map((e) => ({ error: wstr(e.error), count: wnum(e.count), context: wstr(e.context) }))
      : [],
  };
}

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail" | string;
  detail: string;
  hint: string;
}

export async function getDoctorReport(inst: KlankerInstance) {
  const r = await request<WireRow>(inst, "/v1/klanker/doctor");
  return {
    checks: Array.isArray(r.checks)
      ? (r.checks as WireRow[]).map((c) => ({
          name: wstr(c.name),
          status: wstr(c.status),
          detail: wstr(c.detail),
          hint: wstr(c.hint),
        }) as DoctorCheck)
      : [],
    failed: wnum(r.failed),
    warned: wnum(r.warned),
  };
}

export interface BgSession {
  id: string;
  session: string;
  task: string;
  user: string;
  provider: string;
  workspace: string;
  workdir: string;
  pid: number;
  started: string;
  status: string;
  finished?: string;
}

const bgRow = (r: WireRow): BgSession => ({
  id: wstr(r.id),
  session: wstr(r.session),
  task: wstr(r.task),
  user: wstr(r.user),
  provider: wstr(r.provider),
  workspace: wstr(r.workspace),
  workdir: wstr(r.workdir),
  pid: wnum(r.pid),
  started: wstr(r.started),
  status: wstr(r.status),
  finished: typeof r.finished === "string" ? r.finished : undefined,
});

export async function listBgSessions(inst: KlankerInstance, workspace: string): Promise<BgSession[]> {
  const r = await request<WireRow>(inst, `/v1/klanker/bg${qs({ workspace })}`);
  return Array.isArray(r.sessions) ? (r.sessions as WireRow[]).map(bgRow) : [];
}

export async function getBgLogs(inst: KlankerInstance, id: string, lines = 200) {
  const r = await request<WireRow>(inst, `/v1/klanker/bg/${encodeURIComponent(id)}/logs${qs({ lines })}`);
  return { id: wstr(r.id), status: wstr(r.status), logs: wstr(r.logs) };
}

export async function killBgSession(inst: KlankerInstance, id: string): Promise<BgSession> {
  const r = await request<WireRow>(inst, `/v1/klanker/bg/${encodeURIComponent(id)}/kill`, jsonInit("POST", {}));
  return bgRow((r.session || {}) as WireRow);
}

export interface MemoryFileRow {
  path: string;
  bytes: number;
}

export async function listMemoryFiles(inst: KlankerInstance, workspace: string, q = ""): Promise<MemoryFileRow[]> {
  const r = await request<WireRow>(inst, `/v1/klanker/memory${qs({ workspace, q })}`);
  return Array.isArray(r.files) ? (r.files as WireRow[]).map((f) => ({ path: wstr(f.path), bytes: wnum(f.bytes) })) : [];
}

export async function readMemoryFile(inst: KlankerInstance, workspace: string, path: string): Promise<string> {
  const r = await request<WireRow>(inst, `/v1/klanker/memory/file${qs({ workspace, path })}`);
  return wstr(r.content);
}

export async function writeMemoryFile(inst: KlankerInstance, workspace: string, path: string, content: string): Promise<void> {
  await request(inst, `/v1/klanker/memory/file${qs({ workspace })}`, jsonInit("PUT", { workspace, path, content }));
}

export async function deleteMemoryFile(inst: KlankerInstance, workspace: string, path: string): Promise<void> {
  await request(inst, `/v1/klanker/memory/file${qs({ workspace, path })}`, { method: "DELETE" });
}

export interface SkillRow {
  name: string;
  files: number;
  bytes: number;
}

export async function listSkills(inst: KlankerInstance, workspace: string): Promise<SkillRow[]> {
  const r = await request<WireRow>(inst, `/v1/klanker/skills${qs({ workspace })}`);
  return Array.isArray(r.skills)
    ? (r.skills as WireRow[]).map((s) => ({ name: wstr(s.name), files: wnum(s.files), bytes: wnum(s.bytes) }))
    : [];
}

export async function readSkill(inst: KlankerInstance, workspace: string, name: string): Promise<string> {
  const r = await request<WireRow>(inst, `/v1/klanker/skills/${encodeURIComponent(name)}${qs({ workspace })}`);
  return wstr(r.content);
}

export async function writeSkill(inst: KlankerInstance, workspace: string, name: string, content: string): Promise<void> {
  await request(inst, `/v1/klanker/skills/${encodeURIComponent(name)}${qs({ workspace })}`, jsonInit("PUT", { workspace, content }));
}

export async function deleteSkill(inst: KlankerInstance, workspace: string, name: string): Promise<void> {
  await request(inst, `/v1/klanker/skills/${encodeURIComponent(name)}${qs({ workspace })}`, { method: "DELETE" });
}

export async function listApprovalAllowlist(inst: KlankerInstance, workspace: string): Promise<string[]> {
  const r = await request<WireRow>(inst, `/v1/approvals/allowlist${qs({ workspace })}`);
  return Array.isArray(r.patterns) ? (r.patterns as unknown[]).map(String).filter(Boolean) : [];
}

export async function deleteApprovalAllowlistPattern(inst: KlankerInstance, workspace: string, pattern: string): Promise<string[]> {
  const r = await request<WireRow>(inst, `/v1/approvals/allowlist${qs({ workspace, pattern })}`, { method: "DELETE" });
  return Array.isArray(r.patterns) ? (r.patterns as unknown[]).map(String).filter(Boolean) : [];
}
