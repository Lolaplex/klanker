import React, { useCallback, useEffect, useState } from "react";
import { Play, Pause, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { KlankerInstance, RoutineRow } from "../types/klanker";
import { api } from "../services/api";
import { dialogs } from "../services/dialogs";

interface ManagePanelProps {
  instance: KlankerInstance;
  workspace: string;
  onClose: () => void;
}

type Tab = "skills" | "routines" | "memory";

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";
const btnClass =
  "inline-flex items-center gap-1 px-2 py-1 border border-[#262626] rounded text-[#a3a3a3] hover:text-white hover:bg-[#141414] transition-colors";

export const ManagePanel: React.FC<ManagePanelProps> = ({ instance, workspace, onClose }) => {
  const [tab, setTab] = useState<Tab>("skills");
  const [note, setNote] = useState("");
  const [skills, setSkills] = useState<{ name: string; files: number; bytes: number }[]>([]);
  const [routines, setRoutines] = useState<RoutineRow[]>([]);
  const [memFiles, setMemFiles] = useState<{ path: string; bytes: number }[]>([]);
  const [memQuery, setMemQuery] = useState("");
  const [memOpen, setMemOpen] = useState<{ path: string; content: string } | null>(null);
  const [form, setForm] = useState({ name: "", prompt: "", at: "", cron: "" });

  const load = useCallback(async () => {
    setNote("");
    try {
      if (tab === "skills") setSkills(await api.listSkills(instance, workspace));
      else if (tab === "routines") setRoutines(await api.listRoutines(instance));
      else setMemFiles(await api.listMemory(instance, workspace, memQuery));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }, [instance, workspace, tab, memQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const delSkill = async (name: string) => {
    if (!(await dialogs.confirm(`Delete skill "${name}"?`, { danger: true }))) return;
    await api.deleteSkill(instance, workspace, name).then(load).catch((e) => setNote(String(e)));
  };

  const routineAct = async (name: string, action: "pause" | "resume" | "run" | "remove") => {
    if (action === "remove" && !(await dialogs.confirm(`Remove routine "${name}"?`, { danger: true }))) return;
    try {
      const r = await api.routineAction(instance, name, action);
      if (action === "run") setNote(`run ${name}: ${r?.result?.status ?? "ok"} — ${String(r?.result?.reply || "").slice(0, 120)}`);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
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
      setNote(err instanceof Error ? err.message : String(err));
    }
  };

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
    await api.deleteMemory(instance, workspace, path).then(() => { setMemOpen(null); return load(); }).catch((e) => setNote(String(e)));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="modal-card flex flex-col overflow-hidden bg-[#0a0a0a] border border-[#262626] w-full max-w-lg rounded-lg shadow-2xl font-mono text-xs select-text">
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider">MANAGE{workspace ? ` · ${workspace}` : ""}</span>
          <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center text-[#737373] hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="shrink-0 px-4 pt-3 flex items-center gap-2">
          {(["skills", "routines", "memory"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setNote(""); setMemOpen(null); }}
              className={`px-2.5 py-1 border rounded capitalize ${tab === t ? "border-white text-white" : "border-[#262626] text-[#737373] hover:text-white"}`}
            >
              {t}
            </button>
          ))}
          <button onClick={() => void load()} className="ml-auto inline-flex h-7 w-7 items-center justify-center text-[#737373] hover:text-white" aria-label="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4">
          {note && <div className="mb-3 text-[11px] text-red-500 break-words">{note}</div>}

          {tab === "skills" && (
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
          )}

          {tab === "routines" && (
            <div className="space-y-3">
              <ul className="space-y-1.5">
                {routines.length === 0 && <li className="text-[#525252]">no routines</li>}
                {routines.map((r) => (
                  <li key={`${r.workspace}:${r.name}`} className="border border-[#1a1a1a] rounded px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-white truncate">{r.name}{r.paused ? " (paused)" : ""}</span>
                      <span className="shrink-0 flex items-center gap-1">
                        <button onClick={() => void routineAct(r.name, r.paused ? "resume" : "pause")} className={btnClass} aria-label={r.paused ? "resume" : "pause"}>
                          {r.paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                        </button>
                        <button onClick={() => void routineAct(r.name, "run")} className={btnClass}>run</button>
                        <button onClick={() => void routineAct(r.name, "remove")} className={btnClass} aria-label="remove">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </span>
                    </div>
                    <div className="text-[#737373] truncate mt-0.5">
                      {r.at ? `at ${r.at}` : `cron ${r.cron || "?"}`} · {r.workspace || ""}
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
                <button type="submit" className={`${btnClass} w-full justify-center`}><Plus className="w-3 h-3" /> add routine</button>
              </form>
            </div>
          )}

          {tab === "memory" && !memOpen && (
            <div className="space-y-2">
              <input className={inputClass} placeholder="filter…" value={memQuery} onChange={(e) => setMemQuery(e.target.value)} />
              <ul className="space-y-1.5">
                {memFiles.length === 0 && <li className="text-[#525252]">no memory files</li>}
                {memFiles.map((f) => (
                  <li key={f.path} className="flex items-center justify-between gap-2 border border-[#1a1a1a] rounded px-2.5 py-1.5">
                    <button onClick={() => void openMem(f.path)} className="text-white truncate text-left hover:underline">{f.path}</button>
                    <span className="shrink-0 flex items-center gap-2 text-[#737373]">
                      {(f.bytes / 1024).toFixed(1)}k
                      <button onClick={() => void delMem(f.path)} className={btnClass} aria-label={`delete ${f.path}`}>
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === "memory" && memOpen && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-white truncate">{memOpen.path}</span>
                <button onClick={() => setMemOpen(null)} className={btnClass}>back</button>
              </div>
              <pre className="whitespace-pre-wrap break-words text-[#a3a3a3] border border-[#1a1a1a] rounded p-2.5 max-h-80 overflow-y-auto">{memOpen.content}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
