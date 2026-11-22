import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { KlankerInstance, WorkspaceRow } from "../types/klanker";
import { api } from "../services/api";

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";
const labelClass = "text-[10px] uppercase tracking-wider text-[#525252]";

interface Props {
  instance: KlankerInstance;
  workspace: WorkspaceRow;
  onSaved: (row: WorkspaceRow) => void;
  onClose: () => void;
}

/** Workspace config editor — PATCH /v1/workspaces/<id>. Secrets never
 *  belong here: provider keys live in the host vault only. */
export const WorkspaceSettingsModal: React.FC<Props> = ({ instance, workspace, onSaved, onClose }) => {
  const [label, setLabel] = useState(workspace.label || "");
  const [workdir, setWorkdir] = useState(workspace.workdir || "");
  const [workdirLock, setWorkdirLock] = useState(!!workspace.workdir_lock);
  const [browserProfile, setBrowserProfile] = useState(workspace.browser_profile || "");
  const [approvalMode, setApprovalMode] = useState(workspace.approval_mode || "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const row = await api.updateWorkspace(instance, workspace.id, {
        label: label.trim() || undefined,
        workdir: workdir.trim() || null,
        workdir_lock: workdirLock,
        browser_profile: browserProfile.trim() || null,
        approval_mode: (approvalMode || null) as "off" | "ask" | "strict" | null,
      });
      onSaved(row || { ...workspace, label: label.trim() || workspace.id, workdir: workdir.trim() || undefined, workdir_lock: workdirLock, browser_profile: browserProfile.trim() || undefined, approval_mode: approvalMode || undefined });
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#0a0a0a] border border-[#262626] rounded-lg font-mono text-xs flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#262626]">
          <div className="text-white tracking-wider uppercase">workspace · {workspace.id}</div>
          <button type="button" onClick={onClose} className="text-[#525252] hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className={labelClass}>label</span>
            <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={workspace.id} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>workdir</span>
            <input className={inputClass} value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="session cwd override" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={workdirLock} onChange={(e) => setWorkdirLock(e.target.checked)} className="accent-white" />
            <span className={labelClass}>workdir lock — turns stay pinned to this directory</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>browser profile</span>
            <input className={inputClass} value={browserProfile} onChange={(e) => setBrowserProfile(e.target.value)} placeholder="e.g. automation" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>approval mode</span>
            <select className={inputClass} value={approvalMode} onChange={(e) => setApprovalMode(e.target.value)}>
              <option value="">inherit (host default)</option>
              <option value="off">off</option>
              <option value="ask">ask</option>
              <option value="strict">strict</option>
            </select>
          </label>
          {note && <div className="text-red-500">{note}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 border border-[#262626] rounded text-[#a3a3a3] hover:text-white hover:bg-[#141414]"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="px-3 py-1.5 border border-[#262626] rounded bg-[#141414] text-white hover:bg-[#1f1f1f] disabled:opacity-50"
            >
              {busy ? "saving…" : "save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
