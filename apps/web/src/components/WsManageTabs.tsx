import React, { useCallback, useEffect, useState } from "react";
import { Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { JobRow, KlankerInstance, RoutineRow } from "../types/klanker";
import { api } from "../services/api";
import { dialogs } from "../services/dialogs";
import { TracesPanel } from "./TracesPanel";

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";
const btnClass =
  "inline-flex items-center gap-1 px-2 py-1 border border-[#262626] rounded text-[#a3a3a3] hover:text-white hover:bg-[#141414] transition-colors";

/** Default scope filter: the active workspace only — routines bound
 *  elsewhere hide behind the explicit show-all toggle (klanker#160 U05).
 *  Unscoped routines (no workspace key) count as everywhere-visible. */
export function filterRoutinesForWorkspace(
  routines: RoutineRow[],
  workspace: string,
  showAll: boolean
): RoutineRow[] {
  if (showAll) return routines;
  return routines.filter((r) => !r.workspace || r.workspace === workspace);
}

/** Note split (klanker#160 U05): failures render red, run output is a
 *  status and renders emerald — a routine reply must never look like an
 *  error. */
export const WsManageNotes: React.FC<{ error: string; status: string }> = ({ error, status }) => (
  <>
    {error && <div className="text-[11px] text-red-400 break-words">{error}</div>}
    {status && <div className="text-[11px] text-emerald-400 break-words">{status}</div>}
  </>
);

/** Skills & Routines tab of the unified workspace modal (klanker#160 U05).
 *  Absorbed from ManagePanel with two fixes: routines filter to the active
 *  workspace by default (optional show-all toggle), and run output is a
 *  status note (emerald) never rendered in the red error note. */
export const WsSkillsRoutinesTab: React.FC<{ instance: KlankerInstance; workspace: string }> = ({
  instance,
  workspace,
}) => {
  const [skills, setSkills] = useState<{ name: string; files: number; bytes: number }[]>([]);
  const [routines, setRoutines] = useState<RoutineRow[]>([]);
  const [showAllWs, setShowAllWs] = useState(false);
  const [errorNote, setErrorNote] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [form, setForm] = useState({ name: "", prompt: "", at: "", cron: "" });

  const load = useCallback(async () => {
    setErrorNote("");
    try {
      const [sk, ro] = await Promise.all([
        api.listSkills(instance, workspace).catch(() => []),
        api.listRoutines(instance).catch(() => []),
      ]);
      setSkills(sk);
      setRoutines(ro);
    } catch (e) {
      setErrorNote(e instanceof Error ? e.message : String(e));
    }
  }, [instance, workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const delSkill = async (name: string) => {
    if (!(await dialogs.confirm(`Delete skill "${name}"?`, { danger: true }))) return;
    await api.deleteSkill(instance, workspace, name).then(load).catch((e) => setErrorNote(String(e)));
  };

  const routineAct = async (name: string, action: "pause" | "resume" | "run" | "remove") => {
    if (action === "remove" && !(await dialogs.confirm(`Remove routine "${name}"?`, { danger: true }))) return;
    try {
      const r = await api.routineAction(instance, name, action);
      // Run output is a STATUS, never an error — the red error note is
      // reserved for actual failures (klanker#160 U05).
      if (action === "run") {
        setStatusNote(`run ${name}: ${r?.result?.status ?? "ok"} — ${String(r?.result?.reply || "").slice(0, 120)}`);
        setErrorNote("");
      }
      await load();
    } catch (e) {
      setErrorNote(e instanceof Error ? e.message : String(e));
      setStatusNote("");
    }
  };

  const addRoutine = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createRoutine(instance, {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        at: form.at.trim() || undefined,
        cron: form.cron.trim() || undefined,
        workspace: workspace || undefined,
      });
      setForm({ name: "", prompt: "", at: "", cron: "" });
      await load();
    } catch (err) {
      setErrorNote(err instanceof Error ? err.message : String(err));
    }
  };

  const shownRoutines = filterRoutinesForWorkspace(routines, workspace, showAllWs);

  return (
    <div className="flex flex-col gap-3">
      <WsManageNotes error={errorNote} status={statusNote} />

      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-[#525252]">skills</span>
        <ul className="space-y-1.5">
          {skills.length === 0 && <li className="text-[#525252]">no skills in this workspace</li>}
          {skills.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-2 border border-[#1a1a1a] rounded px-2.5 py-1.5">
              <span className="text-white truncate">{s.name}</span>
              <span className="shrink-0 flex items-center gap-2 text-[#737373]">
                {s.files}f · {(s.bytes / 1024).toFixed(1)}k
                <button onClick={() => void delSkill(s.name)} className={btnClass} aria-label={`delete ${s.name}`}>
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1 border-t border-[#1a1a1a] pt-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[#525252]">routines</span>
          <label className="flex items-center gap-1.5 text-[10px] text-[#737373]">
            <input
              type="checkbox"
              className="accent-white"
              checked={showAllWs}
              onChange={(e) => setShowAllWs(e.target.checked)}
            />
            Show all workspaces
          </label>
        </div>
        <ul className="space-y-1.5">
          {shownRoutines.length === 0 && (
            <li className="text-[#525252]">
              {routines.length === 0 ? "no routines" : "no routines in this workspace — toggle 'Show all workspaces' to see others"}
            </li>
          )}
          {shownRoutines.map((r) => (
            <li key={`${r.workspace}:${r.name}`} className="border border-[#1a1a1a] rounded px-2.5 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-white truncate">
                  {r.name}
                  {r.paused ? " (paused)" : ""}
                </span>
                <span className="shrink-0 flex items-center gap-1">
                  <button onClick={() => void routineAct(r.name, r.paused ? "resume" : "pause")} className={btnClass} aria-label={r.paused ? "resume" : "pause"}>
                    {r.paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                  </button>
                  <button onClick={() => void routineAct(r.name, "run")} className={btnClass}>
                    run
                  </button>
                  <button onClick={() => void routineAct(r.name, "remove")} className={btnClass} aria-label="remove">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              </div>
              <div className="text-[#737373] truncate mt-0.5">
                {r.at ? `at ${r.at}` : `cron ${r.cron || "?"}`}
                {showAllWs && r.workspace ? ` · ${r.workspace}` : ""}
              </div>
              <div className="text-[#525252] truncate">{r.prompt}</div>
            </li>
          ))}
        </ul>
        <form onSubmit={addRoutine} className="space-y-2 border-t border-[#1a1a1a] pt-3">
          <input className={inputClass} placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className={inputClass} placeholder="prompt" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} required />
          <div className="flex gap-2">
            <input className={inputClass} placeholder="at (ISO or +10m)" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
            <input className={inputClass} placeholder="or cron" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
          </div>
          <button type="submit" className={`${btnClass} w-full justify-center`}>
            <Plus className="w-3 h-3" /> add routine
          </button>
        </form>
      </div>
    </div>
  );
};

/** Memory tab — list/filter/read/delete workspace memory files
 *  (absorbed from ManagePanel, klanker#160 U05). */
export const WsMemoryTab: React.FC<{ instance: KlankerInstance; workspace: string }> = ({ instance, workspace }) => {
  const [memFiles, setMemFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [memQuery, setMemQuery] = useState("");
  const [memOpen, setMemOpen] = useState<{ path: string; content: string } | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      setMemFiles(await api.listMemory(instance, workspace, memQuery));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, [instance, workspace, memQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const openMem = async (path: string) => {
    try {
      const content = await api.readMemory(instance, workspace, path);
      setMemOpen({ path, content });
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const delMem = async (path: string) => {
    if (!(await dialogs.confirm(`Delete memory file "${path}"?`, { danger: true }))) return;
    await api
      .deleteMemory(instance, workspace, path)
      .then(() => {
        setMemOpen(null);
        return load();
      })
      .catch((e) => setNote(String(e)));
  };

  return (
    <div className="flex flex-col gap-2">
      {note && <div className="text-[11px] text-red-400 break-words">{note}</div>}
      {!memOpen ? (
        <>
          <input className={inputClass} placeholder="filter…" value={memQuery} onChange={(e) => setMemQuery(e.target.value)} />
          <ul className="space-y-1.5">
            {memFiles.length === 0 && <li className="text-[#525252]">no memory files</li>}
            {memFiles.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-2 border border-[#1a1a1a] rounded px-2.5 py-1.5">
                <button onClick={() => void openMem(f.path)} className="text-white truncate text-left hover:underline">
                  {f.path}
                </button>
                <span className="shrink-0 flex items-center gap-2 text-[#737373]">
                  {(f.bytes / 1024).toFixed(1)}k
                  <button onClick={() => void delMem(f.path)} className={btnClass} aria-label={`delete ${f.path}`}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-white truncate">{memOpen.path}</span>
            <button onClick={() => setMemOpen(null)} className={btnClass}>
              back
            </button>
          </div>
          <pre className="whitespace-pre-wrap break-words text-[#a3a3a3] border border-[#1a1a1a] rounded p-2.5 max-h-80 overflow-y-auto">
            {memOpen.content}
          </pre>
        </>
      )}
    </div>
  );
};

/** Jobs & Traces tab — job runner scoped to this workspace plus the relay
 *  traces viewer (moved out of the legacy InstanceSheet, klanker#160 U05). */
export const WsJobsTracesTab: React.FC<{
  instance: KlankerInstance;
  workspace: string;
  onOpenSession?: (ws: string, persona: string, session: string) => void;
}> = ({ instance, workspace, onOpenSession }) => {
  const [jobPersona, setJobPersona] = useState("");
  const [jobGoal, setJobGoal] = useState("");
  const [jobList, setJobList] = useState<JobRow[]>([]);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobNote, setJobNote] = useState<string | null>(null);
  const [personas, setPersonas] = useState<{ id: string; name?: string }[]>([]);
  const [newPersona, setNewPersona] = useState("");
  const [tracesOpen, setTracesOpen] = useState(false);

  const jobPersonaEff = jobPersona || personas[0]?.id || "";

  useEffect(() => {
    if (!workspace) {
      setPersonas([]);
      return;
    }
    void api.listPersonas(instance, workspace).then(setPersonas).catch(() => setPersonas([]));
  }, [instance.id, workspace]);

  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    const load = () =>
      api
        .listJobs(instance, workspace, jobPersonaEff)
        .then((rows) => alive && setJobList(rows))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [instance.id, workspace, jobPersonaEff]);

  const submitJob = async () => {
    const goal = jobGoal.trim();
    if (!goal || !workspace || !jobPersonaEff) return;
    setJobBusy(true);
    setJobNote(null);
    try {
      const job = await api.createJob(instance, {
        workspace,
        persona: jobPersonaEff,
        goal,
      });
      setJobNote(`job ${job.id || ""} queued`);
      setJobGoal("");
      setJobList(await api.listJobs(instance, workspace, jobPersonaEff));
    } catch (e) {
      setJobNote(e instanceof Error ? e.message : String(e));
    } finally {
      setJobBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Persona</label>
          <select
            value={jobPersonaEff}
            onChange={(e) => setJobPersona(e.target.value)}
            style={{ colorScheme: "dark" }}
            className={inputClass}
          >
            {!jobPersonaEff && <option value="">(pick)</option>}
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
        </div>
        {personas.length === 0 && workspace && (
          <div className="flex gap-2 items-end">
            <input
              value={newPersona}
              onChange={(e) => setNewPersona(e.target.value)}
              placeholder="new persona id"
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => {
                const id = newPersona.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
                if (!id) return;
                void api
                  .createPersona(instance, workspace, id)
                  .then(() => {
                    setNewPersona("");
                    setJobPersona(id);
                    return api.listPersonas(instance, workspace).then(setPersonas);
                  })
                  .catch((e) => setJobNote(e instanceof Error ? e.message : String(e)));
              }}
              className="px-3 py-1.5 bg-white text-black rounded text-[11px] shrink-0"
            >
              create
            </button>
          </div>
        )}
      </div>
      <div>
        <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Goal</label>
        <textarea
          rows={3}
          value={jobGoal}
          onChange={(e) => setJobGoal(e.target.value)}
          placeholder="e.g. fix klanker#44: add delete buttons to the tree"
          className={`${inputClass} resize-none`}
        />
        <button
          type="button"
          onClick={() => void submitJob()}
          disabled={jobBusy || !jobGoal.trim() || !workspace || !jobPersonaEff}
          className="mt-2 px-4 py-1.5 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded text-[11px] transition-colors"
        >
          {jobBusy ? "queueing…" : "Run job"}
        </button>
        {jobNote && <p className="mt-1 text-[11px] text-[#737373]">{jobNote}</p>}
      </div>
      <div className="border-t border-[#1a1a1a] pt-3 space-y-2">
        {jobList.length === 0 ? (
          <p className="text-[#525252]">no jobs in this workspace</p>
        ) : (
          jobList.map((j) => (
            <button
              key={j.id}
              type="button"
              onClick={() => onOpenSession?.(workspace, jobPersonaEff, j.id)}
              title={onOpenSession ? "Open the job's chat" : undefined}
              className={`w-full text-left border border-[#262626] bg-[#101010] rounded-xl p-3 ${
                onOpenSession ? "hover:border-[#525252] cursor-pointer" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-white text-[11px] leading-snug break-words min-w-0">{j.goal || j.id}</span>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] ${
                    j.status === "done"
                      ? "border-white text-white"
                      : j.status === "failed" || j.status === "stopped"
                        ? "border-[#525252] text-[#a3a3a3] line-through"
                        : "border-[#262626] text-[#a3a3a3] animate-pulse"
                  }`}
                >
                  {j.status || "?"}
                </span>
              </div>
              {j.result && <div className="mt-1.5 text-[11px] text-[#737373] line-clamp-3">{j.result}</div>}
              <div className="mt-1.5 text-[10px] text-[#3f3f3f] truncate">{j.id}</div>
            </button>
          ))
        )}
      </div>

      <div className="border-t border-[#1a1a1a] pt-3">
        <button
          type="button"
          onClick={() => setTracesOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[#525252] hover:text-[#a3a3a3]"
        >
          <RefreshCw className="w-3 h-3" />
          {tracesOpen ? "− hide traces" : "+ traces"}
        </button>
        {tracesOpen && (
          <div className="mt-2 h-64 overflow-y-auto border border-[#1a1a1a] rounded">
            <TracesPanel instance={instance} workspace={workspace} />
          </div>
        )}
      </div>
    </div>
  );
};
