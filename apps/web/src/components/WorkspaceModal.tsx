import React, { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Plus, QrCode, X } from "lucide-react";
import type { HubDevice, KlankerInstance, WorkspaceHosts, WorkspaceRow } from "../types/klanker";
import { api, caps } from "../services/api";
import { buildPolicyPatch, deviceRoleBadge, mergeDeviceRows, shortId, type RepoEditRow } from "../wsShare";
import { Select } from "./ui/Select";
import { WsInviteCard } from "./WsInviteCard";
import { WsSkillsRoutinesTab, WsMemoryTab, WsJobsTracesTab } from "./WsManageTabs";
import { WsInboxTab } from "./WsInboxTab";
import { inputClass, labelClass } from "./ui/inputClass";
import { Dialog } from "./ui/Dialog";
import { Tabs } from "./ui/Tabs";
import { Switch } from "./ui/Switch";


export type WorkspaceTab = "general" | "sharing" | "skills" | "memory" | "jobs" | "inbox";

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "sharing", label: "Sharing" },
  { id: "skills", label: "Skills & Routines" },
  { id: "memory", label: "Memory" },
  { id: "jobs", label: "Jobs & Traces" },
  { id: "inbox", label: "Inbox" },
];

interface Props {
  instance: KlankerInstance;
  workspace: WorkspaceRow;
  initialTab?: WorkspaceTab;
  /** Persona rows of this workspace for the inbox tab (names + targets). */
  treePersonas?: { id: string; name?: string }[];
  /** Inbox "open chat" — selects the contact in the sidebar. */
  onOpenInboxChat?: (ws: string, persona: string) => void;
  /** Open the raw datom inspector (advanced, desktop side-pane). */
  onOpenStoreInspector?: () => void;
  /** Job id is its goal-session id — open it as a chat. */
  onOpenSession?: (ws: string, persona: string, session: string) => void;
  onSaved: (row: WorkspaceRow) => void;
  onClose: () => void;
}

const blankRepo = (): RepoEditRow => ({ slug: "", url: "", checkout_mode: "worktree", path: "" });

/** Unified tabbed workspace modal (klanker#160 U05): one surface for
 *  workspace config (General), layer-2 sharing (Sharing), skills/routines,
 *  memory files and jobs/traces. Replaces the separate ManagePanel and
 *  WorkspaceSettingsModal. Secrets never belong here: provider keys live
 *  in the host vault only. */
export const WorkspaceModal: React.FC<Props> = ({
  instance,
  workspace,
  initialTab = "general",
  treePersonas = [],
  onOpenInboxChat,
  onOpenStoreInspector,
  onOpenSession,
  onSaved,
  onClose,
}) => {
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
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
  const [repos, setRepos] = useState<RepoEditRow[]>(() =>
    (workspace.repos || []).map((r) => ({
      slug: String(r.slug || ""),
      url: String(r.url || ""),
      checkout_mode: r.checkout_mode === "shared" ? "shared" : "worktree",
      path: "",
    }))
  );
  const [wsHosts, setWsHosts] = useState<WorkspaceHosts | null>(null);
  const [hubDevices, setHubDevices] = useState<HubDevice[]>([]);
  const [hostsNote, setHostsNote] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  // Auto-recall is scoped to THIS workspace (moved out of global Settings,
  // klanker#160 U05) — fetch once per open.
  const [recallOn, setRecallOn] = useState<boolean | null>(null);
  const [recallNote, setRecallNote] = useState<string | null>(null);

  const wasSynced = (workspace.sync_policy || "local") !== "local";
  const freezeWarning = wasSynced && syncPolicy === "local";
  const policyDirty = useRef(false);
  const pathsLoaded = useRef(false);

  useEffect(() => {
    api.getRecall(instance, workspace.id).then(setRecallOn).catch(() => setRecallOn(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id, workspace.id]);

  const toggleRecall = (on: boolean) => {
    setRecallOn(on);
    setRecallNote(null);
    api
      .setRecall(instance, workspace.id, on)
      .then((applied) => setRecallOn(applied))
      .catch((e) => {
        setRecallOn(!on);
        setRecallNote(`recall off: ${e instanceof Error ? e.message : e}`);
      });
  };

  // Member presence + the full paired-device list (members that went
  // offline stay listed; never-paired devices can be checked in).
  useEffect(() => {
    if (!showSharing) return;
    void api
      .fetchWorkspaceHosts(workspace.id)
      .then((h) => {
        setWsHosts(h);
        setCheckedHosts((prev) => {
          if (prev.size || !(workspace.sync_hosts || []).length) {
            const next = new Set(prev);
            for (const host of h.hosts || []) if (host.self || host.role === "owner") next.add(host.device_id);
            return next;
          }
          return prev;
        });
        if (!policyDirty.current && h.sync_policy && h.sync_policy !== syncPolicy) {
          setSyncPolicy(h.sync_policy);
        }
        if (!defaultHost && h.default_host) setDefaultHost(h.default_host);
      })
      .catch((e) => setHostsNote(e instanceof Error ? e.message : String(e)));
    void api.fetchHubDevices().then(setHubDevices).catch(() => setHubDevices([]));
    // Host-local checkout paths come from the relay (host_paths.json) —
    // merge into empty path fields only, an edited value is never
    // overwritten by the slower fetch.
    void api
      .fetchRepoPaths(workspace.id)
      .then((paths) => {
        if (pathsLoaded.current) return;
        pathsLoaded.current = true;
        setRepos((prev) => prev.map((r) => (r.path ? r : { ...r, path: paths[r.slug] || "" })));
      })
      .catch(() => {});
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

  const pickWorkdir = async () => {
    const dir = await api.pickFolder("Choose workdir");
    if (dir) setWorkdir(dir);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      // One PATCH: the general keys and the policy keys ride together so
      // a failed second call can never leave the row half-saved.
      let patch: Parameters<typeof api.updateWorkspace>[2] = {
        label: label.trim() || undefined,
        workdir: workdir.trim() || null,
        workdir_lock: workdirLock,
        browser_profile: browserProfile.trim() || null,
        approval_mode: (approvalMode || null) as "off" | "ask" | "strict" | null,
      };
      if (showSharing) {
        const built = buildPolicyPatch(
          {
            sync_policy: syncPolicy,
            sync_hosts: [...checkedHosts],
            default_host: defaultHost,
            failover,
            repos,
          },
          workspace
        );
        if (!built.ok) {
          setNote(built.error);
          setBusy(false);
          return;
        }
        patch = { ...patch, ...built.patch };
      }
      const row = await api.updateWorkspace(instance, workspace.id, patch);
      if (showSharing) {
        const paths: Record<string, string> = {};
        for (const r of repos) if (r.slug.trim() && r.path.trim()) paths[r.slug.trim()] = r.path.trim();
        await api.putRepoPaths(workspace.id, paths);
      }
      onSaved(
        row || {
          ...workspace,
          label: label.trim() || workspace.id,
          workdir: workdir.trim() || undefined,
          workdir_lock: workdirLock,
          browser_profile: browserProfile.trim() || undefined,
          approval_mode: approvalMode || undefined,
        }
      );
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const dirtyTab = tab === "general" || tab === "sharing";

  return (
    <Dialog open onClose={onClose} title={<>workspace · {workspace.label || workspace.id}</>} wide fixedHeight>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          ariaLabel="workspace sections"
          tabs={TABS.map((t) => ({ value: t.id, label: t.label }))}
        />

        <div className="flex-1 min-h-0 p-4 flex flex-col gap-3 overflow-y-auto overscroll-y-contain">
          {tab === "general" && (
            <>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>label</span>
                <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={workspace.id} />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>workdir</span>
                <span className="flex items-center gap-1">
                  <input className={inputClass} value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="session cwd override" />
                  {caps.spawn && (
                    <button
                      type="button"
                      title="Browse…"
                      aria-label="Browse for workdir"
                      onClick={() => void pickWorkdir()}
                      className="shrink-0 inline-flex h-8 w-8 items-center justify-center border border-subtle rounded-md text-ink-secondary hover:border-strong hover:text-ink-primary hover:bg-elevated"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  )}
                </span>
              </label>
              <label className="flex items-center gap-2">
<Switch checked={workdirLock} onCheckedChange={setWorkdirLock} ariaLabel="workdir lock" />
                <span className={labelClass}>workdir lock — turns stay pinned to this directory</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>browser profile</span>
                <input className={inputClass} value={browserProfile} onChange={(e) => setBrowserProfile(e.target.value)} placeholder="e.g. automation" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>approval mode</span>
                <Select
                  value={approvalMode}
                  onChange={setApprovalMode}
                  ariaLabel="approval mode"
                  options={[
                    { value: "", label: "inherit (host default)" },
                    { value: "off", label: "off" },
                    { value: "ask", label: "ask" },
                    { value: "strict", label: "strict" },
                  ]}
                />
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={!!recallOn}
                  disabled={recallOn === null}
                  onCheckedChange={toggleRecall}
                  ariaLabel="auto-recall memory"
                />
                <span className={labelClass}>Auto-recall memory + repo before each turn</span>
              </label>
              {recallNote && <p className="text-[10px] text-ink-dim">{recallNote}</p>}
              {onOpenStoreInspector && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenStoreInspector();
                  }}
                  className="self-start text-[10px] text-ink-dim hover:text-ink-secondary underline underline-offset-2"
                >
                  Advanced: Raw Data Inspector
                </button>
              )}
            </>
          )}

          {tab === "sharing" && showSharing && (
            <>
              <section className="flex flex-col gap-3" aria-label="Your paired devices">
                <div className="border-b border-subtle pb-1">
                  <div className="text-[10px] uppercase tracking-wider text-ink-muted">Your paired devices</div>
                  <p className="text-[10px] text-ink-dim">Sync this workspace with machines already linked to your herd.</p>
                </div>
              <label className="flex flex-col gap-1">
                <span className={labelClass}>sync policy</span>
                <Select
                  value={syncPolicy}
                  onChange={(v) => {
                    policyDirty.current = true;
                    setSyncPolicy(v);
                  }}
                  ariaLabel="sync policy"
                  options={[
                    { value: "local", label: "local only — never leaves this host" },
                    { value: "synced", label: "synced — members below receive updates" },
                    { value: "shared", label: "shared — synced + open member join" },
                  ]}
                />
              </label>
              {syncPolicy === "local" && !freezeWarning && (
                <p className="text-[10px] text-ink-dim">
                  Local workspace — data stays on this device only. Switch to Synced to share with paired devices.
                </p>
              )}
              {freezeWarning && (
                <p className="text-[10px] text-amber-500">
                  switching to local freezes sync — member devices stop receiving updates and keep their last synced copy.
                </p>
              )}
              {wsHosts?.hub_offline && (
                <p className="text-[10px] text-amber-500">hub offline — member devices are unreachable right now.</p>
              )}

              {syncPolicy !== "local" && (
                <>
                  <div className="flex flex-col gap-1">
                    <span className={labelClass}>Shared devices</span>
                    {hostsNote && <p className="text-[10px] text-red-500">{hostsNote}</p>}
                    {deviceRows.length === 0 && !hostsNote && (
                      <p className="text-[10px] text-ink-dim">no paired devices — pair one from the Devices panel first.</p>
                    )}
                    <div className="flex flex-col gap-1">
                      {deviceRows.map((d) => (
                        <label
                          key={d.device_id}
                          className="flex items-center gap-2 px-2 py-1.5 border border-subtle rounded-md hover:border-strong"
                        >
                          <input
                            type="checkbox"
                            className="accent-white"
                            checked={checkedHosts.has(d.device_id)}
                            disabled={d.device_id === owner}
                            onChange={() => toggleHost(d.device_id)}
                            aria-label={`sync member ${d.label}`}
                          />
                          <span className="text-ink-primary truncate">{d.label || shortId(d.device_id)}</span>
                          {d.label && d.label !== d.device_id && (
                            <span className="text-ink-dim truncate text-[10px]">{shortId(d.device_id)}</span>
                          )}
                          <span
                            className={`ml-auto shrink-0 px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wider ${
                              d.online ? "border-accent text-ink-primary" : "border-subtle text-ink-muted"
                            }`}
                          >
                            {d.online ? "online" : "offline"}
                          </span>
                          <span className="shrink-0 px-1.5 py-0.5 rounded-full border border-subtle text-[9px] uppercase tracking-wider text-ink-muted">
                            {deviceRoleBadge(d.role)}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>default host — where sessions execute</span>
                    <Select
                      value={defaultHost}
                      onChange={setDefaultHost}
                      ariaLabel="default host"
                      options={[
                        { value: "", label: "this host (local)" },
                        ...deviceRows
                          .filter((d) => checkedHosts.has(d.device_id) || d.member)
                          .map((d) => ({
                            value: d.device_id,
                            label: `${d.label || shortId(d.device_id)}${d.label && d.label !== d.device_id ? ` (${shortId(d.device_id)})` : ""}`,
                          })),
                      ]}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className={labelClass}>execution failover</span>
                    <Select
                      value={failover}
                      onChange={setFailover}
                      ariaLabel="execution failover"
                      options={[
                        { value: "none", label: "none — refuse loudly when the bound host is offline" },
                        { value: "standby", label: "standby — a member may take over after failover" },
                      ]}
                    />
                  </label>

                  <div className="flex flex-col gap-1">
                    <span className={labelClass}>repos — synced checkout map</span>
                    {repos.map((r, i) => (
                      // Index key on purpose: rows are never reordered and every
                      // input is controlled. Keying on `r.slug` remounted the card
                      // the moment the first slug character was typed, stealing
                      // focus mid-keystroke.
                      <div key={i} className="flex flex-col gap-1 border border-subtle rounded-md p-2">
                        <div className="flex gap-1">
                          <input
                            className={inputClass}
                            value={r.slug}
                            onChange={(e) => setRepo(i, { slug: e.target.value })}
                            placeholder="slug (org/app)"
                            aria-label={`repo ${i + 1} slug`}
                          />
                          <Select
                            className="w-28 shrink-0"
                            value={r.checkout_mode}
                            onChange={(v) => setRepo(i, { checkout_mode: v === "shared" ? "shared" : "worktree" })}
                            ariaLabel={`repo ${i + 1} checkout mode`}
                            options={[
                              { value: "worktree", label: "worktree" },
                              { value: "shared", label: "shared" },
                            ]}
                          />
                          <button
                            type="button"
                            onClick={() => setRepos((prev) => prev.filter((_, j) => j !== i))}
                            className="shrink-0 px-2 text-ink-dim hover:text-ink-primary"
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
                          placeholder="checkout path — stays local to this device only"
                          aria-label={`repo ${i + 1} checkout path`}
                        />
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setRepos((prev) => [...prev, blankRepo()])}
                      className="inline-flex items-center gap-1 self-start px-2 py-1 border border-dashed border-subtle rounded-md text-ink-muted hover:text-ink-primary hover:border-strong"
                    >
                      <Plus className="w-3 h-3" /> add repo
                    </button>
                    <p className="text-[10px] text-ink-dim">
                      slug + git url + checkout mode sync to members. Checkout path stays local to this device only.
                    </p>
                  </div>
                </>
              )}
              </section>

              {syncPolicy !== "local" && (
              <section className="flex flex-col gap-2 border-t border-subtle pt-3" aria-label="Guest invite">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-ink-muted">Guest invite (this workspace only)</div>
                      <p className="text-[10px] text-ink-dim">
                        Restricted access — guests can only see and sync this workspace, never your other workspaces, devices, or secrets.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setInviteOpen((v) => !v)}
                      className="inline-flex items-center gap-1.5 self-start px-3 py-1.5 border border-subtle rounded-md bg-elevated text-ink-primary hover:border-strong hover:bg-hover"
                    >
                      <QrCode className="w-3.5 h-3.5" />
                      {inviteOpen ? "hide guest invite" : "+ Invite guest to this workspace only (QR / code)"}
                    </button>
                    {inviteOpen && <WsInviteCard ws={workspace.id} ttlSec={60} />}
              </section>
              )}
            </>
          )}

          {tab === "sharing" && !showSharing && (
            <p className="text-[10px] text-ink-dim">
              sharing is edited on the host that owns this workspace — open the workspace modal on that host.
            </p>
          )}

          {tab === "skills" && <WsSkillsRoutinesTab instance={instance} workspace={workspace.id} />}
          {tab === "memory" && <WsMemoryTab instance={instance} workspace={workspace.id} />}
          {tab === "jobs" && <WsJobsTracesTab instance={instance} workspace={workspace.id} onOpenSession={onOpenSession} />}
          {tab === "inbox" && (
            <WsInboxTab
              instance={instance}
              workspace={workspace.id}
              personas={treePersonas}
              onOpenChat={(ws, persona) => {
                onClose();
                onOpenInboxChat?.(ws, persona);
              }}
            />
          )}

          {note && <div className="text-red-500">{note}</div>}
          {dirtyTab && (
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 border border-subtle rounded-md text-ink-secondary hover:border-strong hover:text-ink-primary hover:bg-elevated"
              >
                cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy}
                className="px-3 py-1.5 border border-accent rounded-md bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? "saving…" : "save"}
              </button>
            </div>
          )}
        </div>
    </Dialog>
  );
};
