/**
 * Workspace share-sheet + devices-panel pure logic (klanker#151).
 *
 * The PATCH /v1/workspaces/<ws> policy keys are validated strictly
 * server-side (agents-workspace Host.update_workspace): sync_policy in
 * local|synced|shared, sync_hosts peer ids, default_host host id,
 * execution {owner|failover|lease_sec} with failover standby|none, and
 * repos[] {slug,url,checkout_mode} where a host-local `path` key is
 * REFUSED — checkout paths live in host_paths.json and never travel in
 * the synced workspace.json. Builders below mirror that contract so the
 * UI never emits a patch the wire would reject. Pure functions: no DOM,
 * no fetch — runs under node --test.
 */
import type {
  HubDevice,
  HubLease,
  HubLink,
  WsInvite,
  WorkspaceHosts,
  WorkspacePolicyPatch,
  WsRepoPatch,
} from "./types/klanker.ts";
import { isLoopbackOrigin, resolveInviteUrl } from "./pairLink.ts";

// --- policy draft -> patch ---------------------------------------------------

const PEER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const POLICIES = new Set(["local", "synced", "shared"]);

/** Editable repo row: `path` is host-local only — buildPolicyPatch must
 *  never let it reach the wire (server rejects `path` keys outright). */
export interface RepoEditRow {
  slug: string;
  url: string;
  checkout_mode: "worktree" | "shared";
  /** Host-local checkout path — stored device-side, never synced. */
  path: string;
}

export interface PolicyDraft {
  sync_policy: string;
  sync_hosts: string[];
  default_host: string;
  failover: string;
  repos: RepoEditRow[];
}

export type PolicyPatchResult =
  | { ok: true; patch: WorkspacePolicyPatch }
  | { ok: false; error: string };

/** Build a wire-valid policy patch from the share-sheet draft.
 *  Fail-closed: `local` always wins over a half-filled member set (the
 *  server 400s sync_hosts on local — the patch sends [] to clear), and
 *  repo rows without a slug are dropped rather than sent malformed.
 *  `existing` carries the current workspace row's execution map:
 *  PATCH merges execution server-side, but the client MUST replay the
 *  untouched keys (owner, lease_sec) — a bare {failover} write from a
 *  second admin would otherwise wipe the bound owner. */
export function buildPolicyPatch(
  draft: PolicyDraft,
  existing?: { execution?: Record<string, unknown> }
): PolicyPatchResult {
  const policy = (draft.sync_policy || "local").trim().toLowerCase();
  if (!POLICIES.has(policy)) {
    return { ok: false, error: `sync_policy must be local|synced|shared` };
  }
  const patch: WorkspacePolicyPatch = { sync_policy: policy };

  const hosts: string[] = [];
  for (const raw of draft.sync_hosts) {
    const peer = String(raw || "").trim();
    if (!peer) continue;
    if (!PEER_ID_RE.test(peer)) {
      return { ok: false, error: `invalid sync_hosts device id: ${peer}` };
    }
    if (!hosts.includes(peer)) hosts.push(peer);
  }
  patch.sync_hosts = policy === "local" ? [] : hosts.sort();

  const dh = (draft.default_host || "").trim();
  if (dh && !HOST_ID_RE.test(dh)) {
    return { ok: false, error: `invalid default_host id: ${dh}` };
  }
  patch.default_host = dh;

  const failover = (draft.failover || "none").trim().toLowerCase();
  if (failover !== "standby" && failover !== "none") {
    return { ok: false, error: `failover must be standby|none` };
  }
  patch.execution = { ...(existing?.execution || {}), failover };

  const repos: WsRepoPatch[] = [];
  const seen = new Set<string>();
  for (const row of draft.repos) {
    const slug = (row.slug || "").trim();
    if (!slug && !(row.url || "").trim() && !(row.path || "").trim()) continue; // untouched row
    if (!slug || slug.includes("..") || !REPO_SLUG_RE.test(slug)) {
      return { ok: false, error: `invalid repo slug: ${slug || "(empty)"}` };
    }
    if (seen.has(slug)) {
      return { ok: false, error: `duplicate repo slug: ${slug}` };
    }
    seen.add(slug);
    const mode = row.checkout_mode === "shared" ? "shared" : "worktree";
    // `path` deliberately never copied — host-local checkout mapping only.
    repos.push({ slug, url: (row.url || "").trim(), checkout_mode: mode });
  }
  patch.repos = repos;
  return { ok: true, patch };
}

// --- member device checklist --------------------------------------------------

export interface DeviceCheckRow {
  device_id: string;
  label: string;
  /** owner|default|member from the ws view, else the hub device role. */
  role: string;
  online: boolean;
  self: boolean;
  member: boolean;
}

/** Merge /v1/workspaces/<ws>/hosts members with /v1/hub/devices so the
 *  checklist can offer devices that are not members yet. Sorted:
 *  members first, then by label. */
export function mergeDeviceRows(
  wsHosts: WorkspaceHosts | null,
  devices: HubDevice[]
): DeviceCheckRow[] {
  const rows = new Map<string, DeviceCheckRow>();
  for (const d of devices) {
    rows.set(d.id, {
      device_id: d.id,
      label: d.label || d.id,
      role: d.role || "member",
      online: !!d.connected,
      self: false,
      member: false,
    });
  }
  for (const h of wsHosts?.hosts || []) {
    const prev = rows.get(h.device_id);
    rows.set(h.device_id, {
      device_id: h.device_id,
      label: h.label || prev?.label || h.device_id,
      role: h.role || prev?.role || "member",
      online: !!h.online || !!prev?.online,
      self: !!h.self,
      member: true,
    });
  }
  return [...rows.values()].sort(
    (a, b) => Number(b.member) - Number(a.member) || Number(b.self) - Number(a.self) || a.label.localeCompare(b.label)
  );
}

// --- devices panel ------------------------------------------------------------

export function linkBadge(link: HubLink): "connected" | "disconnected" {
  return link.connected ? "connected" : "disconnected";
}

export function deviceBadge(device: HubDevice): "online" | "offline" {
  return device.connected ? "online" : "offline";
}

/** Shared-workspace pills for a device row: any ws allowlist/workspaces
 *  fields a newer relay may serve, plus ws ids of its active leases. */
export function deviceWsPills(device: HubDevice, leases: HubLease[]): string[] {
  const out = new Set<string>();
  for (const ws of device.workspaces || device.allowlist || []) {
    const clean = String(ws || "").trim();
    if (clean) out.add(clean);
  }
  for (const l of leases) {
    if (l.holder === device.id && l.ws) out.add(l.ws);
  }
  return [...out].sort();
}

/** Active lease rows held by one device. */
export function deviceLeases(device: HubDevice, leases: HubLease[]): HubLease[] {
  return leases.filter((l) => l.holder === device.id);
}

// --- ws invite view -------------------------------------------------------------

/** Everything the invite card needs to render: dashed code, resolved
 *  absolute link, QR payload text, and the loopback reachability flag. */
export function wsInviteView(
  invite: Pick<WsInvite, "code" | "token" | "pair_url">,
  baseUrl: string
): { code: string; link: string; loopback: boolean; qrText: string } {
  const { url, loopback } = resolveInviteUrl(invite.pair_url || "", baseUrl);
  const code = (invite.code || "").trim();
  return { code, link: url, loopback, qrText: url || code || invite.token || "" };
}

export { isLoopbackOrigin };
