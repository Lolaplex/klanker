/**
 * Per-chat host picker + switch logic (klanker#152).
 *
 * A session's execution host is the session:host binding (or the ws
 * default_host when unbound). The picker lists exactly the ws members the
 * relay returned from GET /v1/workspaces/<ws>/hosts — never a device the
 * workspace did not grant. Pure functions only: no DOM, no fetch — the
 * api/dialog seams are injected so everything runs under node --test.
 */
import type {
  RelayEvent,
  SessionHostSwitch,
  WorkspaceHost,
  WorkspaceHosts,
} from "./types/klanker.ts";

/** /v1/remote/<id> mount row for a hub-paired device (relay registers
 *  `dev-<device_id>` on pair; tolerate ids already carrying the prefix). */
export function remoteMountId(deviceId: string): string {
  const d = deviceId.trim();
  if (!d) return "";
  return d.startsWith("dev-") ? d : `dev-${d}`;
}

/** Session worktree checkpoint branch — mirrors session_branch(). */
export function checkpointBranch(sessionId: string): string {
  return `klanker/s-${sessionId}`;
}

export interface HostRow {
  deviceId: string;
  label: string;
  online: boolean;
  self: boolean;
  role: string;
  /** This device holds an active execution lease on SOME session. */
  leased: boolean;
}

/** Picker rows: strictly the payload's member set (self included).
 *  Display order: self, then online members, then offline — alphabetical
 *  inside each tier. */
export function hostPickerRows(payload: WorkspaceHosts | null | undefined): HostRow[] {
  const hosts = payload?.hosts || [];
  const rows: HostRow[] = hosts.map((h: WorkspaceHost) => ({
    deviceId: h.device_id,
    label: h.label || h.device_id,
    online: !!h.online,
    self: !!h.self,
    role: h.role || "member",
    leased: (h.leases || []).length > 0,
  }));
  const tier = (r: HostRow) => (r.self ? 0 : r.online ? 1 : 2);
  return rows.sort(
    (a, b) => tier(a) - tier(b) || a.label.localeCompare(b.label) || a.deviceId.localeCompare(b.deviceId)
  );
}

/** Device id holding an active (ws, session) lease, "" when free. */
export function leaseHolderFor(
  session: string,
  hosts: WorkspaceHosts | null | undefined
): string {
  if (!session) return "";
  for (const h of hosts?.hosts || []) {
    if ((h.leases || []).some((l) => l.session === session)) return h.device_id;
  }
  return "";
}

/** Label for a member device id; falls back to the raw id. */
export function hostLabelFor(
  hosts: WorkspaceHosts | null | undefined,
  deviceId: string
): string {
  const row = hosts?.hosts?.find((h) => h.device_id === deviceId);
  return row?.label || deviceId;
}

function hostOnline(
  hosts: WorkspaceHosts | null | undefined,
  deviceId: string
): boolean {
  return !!hosts?.hosts?.find((h) => h.device_id === deviceId)?.online;
}

/** Own device id inside the hosts payload ("" when unknown). */
export function selfDeviceId(hosts: WorkspaceHosts | null | undefined): string {
  return hosts?.hosts?.find((h) => h.self)?.device_id || "";
}

export type HostBinding =
  /** No session:host — rides the ws default host (or self when unset). */
  | { kind: "unbound"; host: string; label: string; online: boolean }
  /** session:host is set. */
  | { kind: "bound"; host: string; label: string; online: boolean }
  /** A run/lease is active — the picker stays read-only (Running). */
  | { kind: "locked"; host: string; label: string; online: boolean };

/** Chip binding state for the open chat.
 *  `running` = a live turn on this session — a local busy key, a foreign
 *  composer hold or a remote-active reconcile; server-side leases are
 *  read off the hosts payload itself. */
export function hostBinding(args: {
  sessionHost?: string;
  session?: string;
  hosts?: WorkspaceHosts | null;
  running?: boolean;
}): HostBinding {
  const hosts = args.hosts;
  const bound = (args.sessionHost || "").trim();
  const lease = leaseHolderFor(args.session || "", hosts);
  const locked = !!args.running || !!lease;
  if (bound) {
    return {
      kind: locked ? "locked" : "bound",
      host: bound,
      label: hostLabelFor(hosts, bound),
      online: hostOnline(hosts, bound),
    };
  }
  if (locked) {
    const host = lease || selfDeviceId(hosts) || hosts?.default_host || "";
    return {
      kind: "locked",
      host,
      label: hostLabelFor(hosts, host) || host,
      online: hostOnline(hosts, host),
    };
  }
  const host = hosts?.default_host || selfDeviceId(hosts) || "";
  return {
    kind: "unbound",
    host,
    label: hostLabelFor(hosts, host) || host,
    online: hostOnline(hosts, host) || (!!host && host === selfDeviceId(hosts)),
  };
}

/** The binding text the chip exposes (aria-label + dropdown header). */
export function bindingText(b: HostBinding): string {
  if (b.kind === "locked") return `running (locked)${b.label ? `: ${b.label}` : ""}`;
  if (b.kind === "bound") return `bound: ${b.label || b.host}`;
  return `unbound (default: ${b.label || b.host || "local"})`;
}

/** Effective execution host for provider scoping: the session binding,
 *  else the ws default host. "" means "this relay" (local). */
export function effectiveHost(b: HostBinding): string {
  return b.host || "";
}

/** Where the provider/model picker reads its manifest from. */
export type ProviderScope =
  | { kind: "local" }
  | { kind: "remote"; deviceId: string; mountId: string; online: boolean };

/** Host A's providers must never leak into host B's chat: a chat bound to
 *  a remote member reads `/v1/remote/dev-<id>/v1/providers`; self/unbound
 *  reads the serving relay's `/v1/providers`. */
export function providerScope(
  host: string,
  hosts: WorkspaceHosts | null | undefined
): ProviderScope {
  const h = (host || "").trim();
  if (!h || h === selfDeviceId(hosts)) return { kind: "local" };
  return {
    kind: "remote",
    deviceId: h,
    mountId: remoteMountId(h),
    online: hostOnline(hosts, h),
  };
}

// --- host switch: checkpoint -> rebind -> optional force retry -----------

export type SwitchOutcome =
  | { kind: "switched"; unchanged?: boolean; unpushed?: boolean }
  /** Confirmable conflicts — wip_unpushed, or host_offline while the ws
   *  failover policy is "none" (a standby policy reroutes server-side). */
  | { kind: "confirm"; reason: "wip_unpushed" | "host_offline"; holder?: string }
  | { kind: "refused"; reason: string; holder?: string };

/** Classify a POST .../sessions/<sid>/host payload (parsed, never thrown). */
export function classifySwitch(res: SessionHostSwitch | null | undefined): SwitchOutcome {
  if (!res) return { kind: "refused", reason: "no response" };
  if (res.ok) {
    return {
      kind: "switched",
      unchanged: !!res.unchanged,
      unpushed: !!res.checkpoint?.unpushed,
    };
  }
  const err = String(res.error || "failed");
  if (err === "wip_unpushed") return { kind: "confirm", reason: "wip_unpushed" };
  if (err === "host_offline") {
    const failover = String((res as Record<string, unknown>).failover || "none");
    if (failover === "none") {
      return { kind: "confirm", reason: "host_offline", holder: res.holder };
    }
    return { kind: "refused", reason: `host offline — failover ${failover}` };
  }
  return { kind: "refused", reason: err, holder: res.holder };
}

/** Explicit confirm text — the only path to force:true. */
export function confirmMessage(
  reason: "wip_unpushed" | "host_offline",
  session: string,
  hostLabel: string
): string {
  const target = hostLabel ? ` to ${hostLabel}` : "";
  if (reason === "wip_unpushed") {
    return (
      `Unpushed WIP on the current host — switch${target} anyway? ` +
      `The ${checkpointBranch(session)} checkpoint keeps the work on the old host.`
    );
  }
  return `Host offline — switch${target} anyway? Any unpushed work stays on the old host.`;
}

export interface SwitchRunResult {
  switched: boolean;
  forced: boolean;
  unchanged?: boolean;
  /** User cancelled the explicit confirm — no force retry happened. */
  cancelled?: boolean;
  refused?: SwitchOutcome & { kind: "refused" };
  /** Displayable result line (chip note). */
  note: string;
}

/** One switch attempt + the confirmable-conflict flow.
 *  `post` is api.switchSessionHost; `confirm` is the app dialog — a
 *  confirmed conflict retries ONCE with force:true. */
export async function runHostSwitch(args: {
  ws: string;
  session: string;
  host: string;
  hostLabel?: string;
  post: (ws: string, session: string, host: string, force: boolean) => Promise<SessionHostSwitch>;
  confirm: (message: string) => Promise<boolean> | boolean;
}): Promise<SwitchRunResult> {
  const { ws, session, host } = args;
  const label = args.hostLabel || host;
  const refuse = (o: { reason: string; holder?: string }, forced = false): SwitchRunResult => ({
    switched: false,
    forced,
    refused: { kind: "refused", reason: o.reason, holder: o.holder },
    note:
      o.reason === "lease_held"
        ? `lease held by ${o.holder || "another device"} — try again when the run ends`
        : `switch refused: ${o.reason}`,
  });

  const first = classifySwitch(await args.post(ws, session, host, false));
  if (first.kind === "switched") {
    const wip = first.unpushed ? " · unpushed WIP kept" : "";
    return { switched: true, forced: false, unchanged: first.unchanged, note: first.unchanged ? `already on ${label}` : `bound: ${label} · ${checkpointBranch(session)}${wip}` };
  }
  if (first.kind !== "confirm") return refuse(first);

  // 409 wip_unpushed / host_offline-under-failover-none — explicit confirm
  // is the ONLY path to force:true (klanker#148: never silently strand work).
  const ok = await args.confirm(confirmMessage(first.reason, session, label));
  if (!ok) {
    return { switched: false, forced: false, cancelled: true, note: "kept on current host" };
  }
  const second = await args.post(ws, session, host, true);
  const retry = classifySwitch(second);
  if (retry.kind === "switched") {
    const wip = retry.unpushed ? " · unpushed WIP kept" : "";
    return { switched: true, forced: true, unchanged: retry.unchanged, note: retry.unchanged ? `already on ${label}` : `bound: ${label} · ${checkpointBranch(session)}${wip}` };
  }
  return refuse(retry.kind === "confirm" ? { reason: retry.reason } : retry, true);
}

// --- relay SSE: presence + scoped refreshes (klanker#152) -----------------

/** Presence delta carried by a device.* event, null when the kind carries
 *  none. `device.presence` implies connectivity (a live frame just
 *  arrived); `device.changed` on a revoke drops the row's online flag. */
export function presenceDelta(
  ev: RelayEvent
): { deviceId: string; online: boolean; gone?: boolean } | null {
  const p = ev?.payload || {};
  const id = String(p.device_id || p.id || "").trim();
  if (!id) return null;
  if (ev.kind === "device.connected") return { deviceId: id, online: true };
  if (ev.kind === "device.disconnected") return { deviceId: id, online: false };
  if (ev.kind === "device.presence") return { deviceId: id, online: true };
  if (ev.kind === "device.changed") return { deviceId: id, online: false, gone: true };
  return null;
}

/** Apply a presence delta to a hosts payload — updates the member row's
 *  online/status and recomputes hub_offline off the member set (same
 *  approximation the relay serves: nothing connected => hub_offline). */
export function applyPresence(
  payload: WorkspaceHosts,
  deviceId: string,
  online: boolean
): WorkspaceHosts {
  const hosts = (payload.hosts || []).map((h) =>
    h.device_id === deviceId ? { ...h, online, status: online ? "online" : "offline" } : h
  );
  return {
    ...payload,
    hosts,
    hub_offline: !hosts.some((h) => h.online),
  };
}

/** session.bound payload, normalized. */
export function sessionBoundDelta(
  ev: RelayEvent
): { ws: string; session: string; host: string } | null {
  if (ev?.kind !== "session.bound") return null;
  const p = ev.payload || {};
  const session = String(p.session || "").trim();
  if (!session) return null;
  return {
    ws: String(ev.workspace || p.ws || "").trim(),
    session,
    host: String(p.host || "").trim(),
  };
}

export interface HostEventEffect {
  /** Presence update applied in place to every loaded hosts payload. */
  presence?: { deviceId: string; online: boolean; gone?: boolean };
  /** Workspaces whose /hosts payload needs a refetch (lease/book kept
   *  server-side — a pull is the authoritative update). */
  refreshHosts: string[];
  /** Member set changed — refetch every loaded ws payload. */
  refreshAll?: boolean;
  /** session.bound — rebind a known session row + refresh that ws. */
  sessionBound?: { ws: string; session: string; host: string };
}

/** Map a relay event onto the host-picker/lease actions the UI must take.
 *  Returns null for kinds this surface ignores. */
export function hostEventEffect(ev: RelayEvent): HostEventEffect | null {
  if (!ev || typeof ev.kind !== "string") return null;
  const p = ev.payload || {};
  if (ev.kind === "device.connected" || ev.kind === "device.disconnected" || ev.kind === "device.presence") {
    const presence = presenceDelta(ev);
    return presence ? { presence, refreshHosts: [] } : null;
  }
  if (ev.kind === "device.changed") {
    // Pairing graph mutated — presence rows and member lists may shift.
    return { presence: presenceDelta(ev) || undefined, refreshHosts: [], refreshAll: true };
  }
  if (ev.kind === "ws.announced" || ev.kind === "ws.revoked") {
    const ws = String(ev.workspace || p.ws || "").trim();
    return ws ? { refreshHosts: [ws] } : null;
  }
  if (ev.kind === "lease.changed" || ev.kind === "workspace.changed") {
    // lease set or policy/default_host mutated — the hosts payload is the
    // authoritative refresh for either (klanker#152 R12).
    const ws = String(ev.workspace || p.ws || "").trim();
    return ws ? { refreshHosts: [ws] } : null;
  }
  const bound = sessionBoundDelta(ev);
  if (bound) {
    return { sessionBound: bound, refreshHosts: bound.ws ? [bound.ws] : [] };
  }
  return null;
}
