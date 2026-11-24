import React, { useEffect, useMemo, useState } from "react";
import { Plus, QrCode, X } from "lucide-react";
import type { HubDevice, KlankerInstance, WorkspaceHosts, WorkspaceRow } from "../types/klanker";
import { api } from "../services/api";
import { buildPolicyPatch, mergeDeviceRows, type RepoEditRow } from "../wsShare";
import { WsInviteCard } from "./WsInviteCard";

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";
const labelClass = "text-[10px] uppercase tracking-wider text-[#525252]";

interface Props {
  instance: KlankerInstance;
  workspace: WorkspaceRow;
  onSaved: (row: WorkspaceRow) => void;
  onClose: () => void;
}

/** Host-local checkout paths (host_paths.json) — the synced repos[] patch
 *  must never carry them, so they live in localStorage per ws+slug. */
function repoPathKey(ws: string): string {
  return `klanker.repopath.${ws}`;
}
function loadRepoPaths(ws: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(repoPathKey(ws));
    const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === "string" && v) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
function saveRepoPaths(ws: string, rows: RepoEditRow[]): void {
  try {
    const out: Record<string, string> = {};
    for (const r of rows) if (r.slug.trim() && r.path.trim()) out[r.slug.trim()] = r.path.trim();
    localStorage.setItem(repoPathKey(ws), JSON.stringify(out));
  } catch {}
}

const blankRepo = (): RepoEditRow => ({ slug: "", url: "", checkout_mode: "worktree", path: "" });

/** Workspace config + share policy editor — PATCH /v1/workspaces/<id>.
 *  Secrets never belong here: provider keys live in the host vault only.
 *  Sharing keys go through the LOCAL relay's admin surface (hub links /
 *  devices / ws invites all deny ws_member tokens), so the section only
 *  renders for the local instance — a remote relay's workspace is edited
 *  on that host. */
export const WorkspaceSettingsModal: React.FC<Props> = ({ instance, workspace, onSaved, onClose }) => {
  const [label, setLabel] = useState(workspace.label || "");
  const [workdir, setWorkdir] = useState(workspace.workdir || "");
  const [workdirLock, setWorkdirLock] = useState(!!workspace.workdir_lock);
  const [browserProfile, setBrowserProfile] = useState(workspace.browser_profile || "");
  const [approvalMode, setApprovalMode] = useState(workspace.approval_mode || "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const showSharing = instance.kind === "local" || instance.id === "local";
  const [syncPolicy, setSyncPolicy] = useState(workspace.sync_policy || "local");
  const [checkedHosts, setCheckedHosts] = useState<ReadonlySet<string>>(
    () => new Set(workspace.sync_hosts || [])
  );
  const [defaultHost, setDefaultHost] = useState(workspace.default_host || "");
  const [failover, setFailover] = useState(String(workspace.execution?.failover || "none"));
  const [repos, setRepos] = useState<RepoEditRow[]>(() => {
    const paths = loadRepoPaths(workspace.id);
    return (workspace.repos || []).map((r) => ({
      slug: String(r.slug || ""),
      url: String(r.url || ""),
      checkout_mode: r.checkout_mode === "shared" ? "shared" : "worktree",
      path: paths[String(r.slug || "")] || "",
    }));
  });
  const [wsHosts, setWsHosts] = useState<WorkspaceHosts | null>(null);
  const [hubDevices, setHubDevices] = useState<HubDevice[]>([]);
  const [hostsNote, setHostsNote] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const wasSynced = (workspace.sync_policy || "local") !== "local";
  const freezeWarning = wasSynced && syncPolicy === "local";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Member presence + the full paired-device list (members that went
  // offline stay listed; never-paired devices can be checked in).
  useEffect(() => {
    if (!showSharing) return;
    void api
      .fetchWorkspaceHosts(workspace.id)
      .then((h) => {
        setWsHosts(h);
        // Seed checks from the live member set when the ws row predates
        // sync_hosts propagation (owner/default are implied members).
        setCheckedHosts((prev) => {
          if (prev.size || !(workspace.sync_hosts || []).length) {
            const next = new Set(prev);
            for (const host of h.hosts || []) if (host.self || host.role === "owner") next.add(host.device_id);
            return next;
          }
          return prev;
        });
        if (h.sync_policy && h.sync_policy !== syncPolicy) setSyncPolicy(h.sync_policy);
        if (!defaultHost && h.default_host) setDefaultHost(h.default_host);
      })
      .catch((e) => setHostsNote(e instanceof Error ? e.message : String(e)));
    void api.fetchHubDevices().then(setHubDevices).catch(() => setHubDevices([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, showSharing]);

  const deviceRows = useMemo(() => mergeDeviceRows(wsHosts, hubDevices), [wsHosts, hubDevices]);
  const owner = wsHosts?.owner || "";

  const toggleHost = (deviceId: string) => {
    setCheckedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  const setRepo = (idx: number, patch: Partial<RepoEditRow>) => {
    setRepos((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

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
      let policyRow: WorkspaceRow | null = null;
      if (showSharing) {
        const built = buildPolicyPatch({
          sync_policy: syncPolicy,
          sync_hosts: [...checkedHosts],
          default_host: defaultHost,
          failover,
          repos,
        });
        if (!built.ok) {
          setNote(built.error);
          setBusy(false);
          return;
        }
        policyRow = await api.patchWorkspacePolicy(workspace.id, built.patch);
        saveRepoPaths(workspace.id, repos);
      }
      onSaved({
        ...(row || { ...workspace, label: label.trim() || workspace.id, workdir: workdir.trim() || undefined, workdir_lock: workdirLock, browser_profile: browserProfile.trim() || undefined, approval_mode: approvalMode || undefined }),
        ...(policyRow || {}),
      });
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#0a0a0a] border border-[#262626] rounded-lg font-mono text-xs flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#262626] shrink-0">
          <div className="text-white tracking-wider uppercase">workspace · {workspace.id}</div>
          <button type="button" onClick={onClose} className="text-[#525252] hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 flex flex-col gap-3 overflow-y-auto overscroll-y-contain">
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

          {showSharing && (
            <div className="border-t border-[#262626] pt-3 flex flex-col gap-3">
              <div className="text-[10px] uppercase tracking-wider text-[#737373]">sharing &amp; hosts</div>

              <label className="flex flex-col gap-1">
                <span className={labelClass}>sync policy</span>
                <select
                  className={inputClass}
                  value={syncPolicy}
                  onChange={(e) => setSyncPolicy(e.target.value)}
                  aria-label="sync policy"
                >
                  <option value="local">local only — never leaves this host</option>
                  <option value="synced">synced — members below receive updates</option>
                  <option value="shared">shared — synced + open member join</option>
                </select>
              </label>
              <p className="text-[10px] text-[#525252]">
                fail-closed: an unknown/missing policy reads as local and nothing is shared. Synced keeps the workspace
                flowing to the member devices checked below.
              </p>
              {freezeWarning && (
                <p className="text-[10px] text-amber-500">
                  switching to local freezes sync — member devices stop receiving updates and keep their last synced copy.
                </p>
              )}
              {wsHosts?.hub_offline && (
                <p className="text-[10px] text-amber-500">hub offline — member devices are unreachable right now.</p>
              )}

              <div className="flex flex-col gap-1">
                <span className={labelClass}>member devices (sync_hosts)</span>
                {hostsNote && <p className="text-[10px] text-red-500">{hostsNote}</p>}
                {deviceRows.length === 0 && !hostsNote && (
                  <p className="text-[10px] text-[#525252]">no paired devices — invite one below.</p>
                )}
                <div className="flex flex-col gap-1">
                  {deviceRows.map((d) => (
                    <label
                      key={d.device_id}
                      className="flex items-center gap-2 px-2 py-1.5 border border-[#1a1a1a] rounded hover:border-[#262626]"
                    >
                      <input
                        type="checkbox"
                        className="accent-white"
                        checked={checkedHosts.has(d.device_id)}
                        disabled={d.device_id === owner}
                        onChange={() => toggleHost(d.device_id)}
                        aria-label={`sync member ${d.label}`}
                      />
                      <span className="text-white truncate">{d.label}</span>
                      <span className="text-[#525252] truncate text-[10px]">{d.device_id}</span>
                      <span
                        className={`ml-auto shrink-0 px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wider ${
                          d.online ? "border-white text-white" : "border-[#262626] text-[#737373]"
                        }`}
                      >
                        {d.online ? "online" : "offline"}
                      </span>
                      <span className="shrink-0 px-1.5 py-0.5 rounded-full border border-[#262626] text-[9px] uppercase tracking-wider text-[#737373]">
                        {d.role}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex flex-col gap-1">
                <span className={labelClass}>default host — where sessions execute</span>
                <select
                  className={inputClass}
                  value={defaultHost}
                  onChange={(e) => setDefaultHost(e.target.value)}
                  aria-label="default host"
                >
                  <option value="">this host (local)</option>
                  {deviceRows
                    .filter((d) => checkedHosts.has(d.device_id) || d.member)
                    .map((d) => (
                      <option key={d.device_id} value={d.device_id}>
                        {d.label} ({d.device_id})
                      </option>
                    ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className={labelClass}>execution failover</span>
                <select
                  className={inputClass}
                  value={failover}
                  onChange={(e) => setFailover(e.target.value)}
                  aria-label="execution failover"
                >
                  <option value="none">none — refuse loudly when the bound host is offline</option>
                  <option value="standby">standby — a member may take over after failover</option>
                </select>
              </label>

              <div className="flex flex-col gap-1">
                <span className={labelClass}>repos — synced checkout map</span>
                {repos.map((r, i) => (
                  <div key={i} className="flex flex-col gap-1 border border-[#1a1a1a] rounded p-2">
                    <div className="flex gap-1">
                      <input
                        className={inputClass}
                        value={r.slug}
                        onChange={(e) => setRepo(i, { slug: e.target.value })}
                        placeholder="slug (org/app)"
                        aria-label={`repo ${i + 1} slug`}
                      />
                      <select
                        className={`${inputClass} w-28 shrink-0`}
                        value={r.checkout_mode}
                        onChange={(e) => setRepo(i, { checkout_mode: e.target.value === "shared" ? "shared" : "worktree" })}
                        aria-label={`repo ${i + 1} checkout mode`}
                      >
                        <option value="worktree">worktree</option>
                        <option value="shared">shared</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setRepos((prev) => prev.filter((_, j) => j !== i))}
                        className="shrink-0 px-2 text-[#525252] hover:text-white"
                        aria-label={`remove repo ${i + 1}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <input
                      className={inputClass}
                      value={r.url}
                      onChange={(e) => setRepo(i, { url: e.target.value })}
                      placeholder="git url (git@host:org/app.git)"
                      aria-label={`repo ${i + 1} git url`}
                    />
                    <input
                      className={inputClass}
                      value={r.path}
                      onChange={(e) => setRepo(i, { path: e.target.value })}
                      placeholder="checkout path on this device — stored locally, never synced"
                      aria-label={`repo ${i + 1} checkout path`}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setRepos((prev) => [...prev, blankRepo()])}
                  className="inline-flex items-center gap-1 self-start px-2 py-1 border border-dashed border-[#262626] rounded text-[#737373] hover:text-white hover:border-[#525252]"
                >
                  <Plus className="w-3 h-3" /> add repo
                </button>
                <p className="text-[10px] text-[#525252]">
                  slug + git url + checkout mode sync to members; the checkout path stays on this device (host-local
                  host_paths.json) and never enters the patch.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setInviteOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 self-start px-3 py-1.5 border border-[#262626] rounded bg-[#141414] text-white hover:bg-[#1f1f1f]"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  {inviteOpen ? "hide invite" : "invite device (QR / code)"}
                </button>
                {inviteOpen && <WsInviteCard ws={workspace.id} ttlSec={60} />}
              </div>
            </div>
          )}

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
