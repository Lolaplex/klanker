/**
 * Workspace-first sidebar tree helpers (klanker#150).
 *
 * The serving relay fronts every local/synced/shared workspace, so the tree
 * root is workspaces — never instances/devices. A shared ws synced onto this
 * host renders exactly one top-level row no matter how many devices serve it.
 * Pure functions only: no DOM, no fetch — runs under node --test.
 */
import type { WorkspaceHosts, WorkspaceRow } from "./types/klanker.ts";
import { friendlyHostName } from "./hostPicker.ts";

/** One row per workspace id; later rows union over earlier ones (a synced
 *  copy carrying policy fields and a local stub merge into the richer row). */
export function dedupeWorkspaces(rows: WorkspaceRow[]): WorkspaceRow[] {
  const byId = new Map<string, WorkspaceRow>();
  for (const row of rows) {
    const prev = byId.get(row.id);
    byId.set(row.id, prev ? { ...prev, ...row } : row);
  }
  return [...byId.values()];
}

export type WsBadgeKind = "local" | "synced" | "hub" | "offline";

export interface WsBadge {
  kind: WsBadgeKind;
  /** Member count — only meaningful for `synced` (rendered next to the
   *  icon); 0 everywhere else. */
  count: number;
  /** Descriptive tooltip — the only place words live. The badge itself is
   *  a compact icon so a wide `SYNCED N HOSTS` pill can never crush the
   *  workspace title again (klanker#158 U03). */
  tooltip: string;
}

/** Sidebar sync badge per workspace (klanker#150, compact icons klanker#158):
 *  - `local`  — sync_policy local/absent, the ws never leaves this host (lock)
 *  - `synced` — synced policy + numeric member count from the live member
 *    set (hosts payload) or the row's sync_hosts allowlist
 *  - `hub`    — shared policy: synced plus open member join
 *  - `offline`— synced/shared but the hub has no connected devices
 *  Missing/unknown policy reads local — fail-closed like the server. */
export function wsSyncBadge(
  ws: Pick<WorkspaceRow, "sync_policy" | "sync_hosts">,
  hosts: WorkspaceHosts | null | undefined
): WsBadge {
  const policy = String(hosts?.sync_policy || ws.sync_policy || "local").toLowerCase();
  if (policy !== "synced" && policy !== "shared") {
    return { kind: "local", count: 0, tooltip: "local — never leaves this host" };
  }
  if (hosts?.hub_offline) {
    return { kind: "offline", count: 0, tooltip: "offline — no connected devices on the hub" };
  }
  if (policy === "shared") {
    return { kind: "hub", count: 0, tooltip: "shared — open member join via hub" };
  }
  const n = hosts?.hosts?.length ?? ws.sync_hosts?.length ?? 0;
  return {
    kind: "synced",
    count: n,
    tooltip: `synced · ${n} host${n === 1 ? "" : "s"}`,
  };
}

/** Bound-host pill for a session row (klanker#150). A session is bound when
 *  the synced store projection says `host` (session:host binding, W11/W12) or
 *  a member holds an active (ws, session) lease. The label resolves through
 *  the hosts payload (device label > raw id); a labelless id degrades to a
 *  short friendly form — never the raw 37-char hex (klanker#158 U03). */
export function sessionHostPill(
  sessionHost: string | undefined,
  sessionId: string,
  hosts: WorkspaceHosts | null | undefined
): string | null {
  const bound = (sessionHost || "").trim() || leaseHolder(sessionId, hosts);
  if (!bound) return null;
  const row = hosts?.hosts?.find((h) => h.device_id === bound || h.label === bound);
  return friendlyHostName(bound, row?.label);
}

function leaseHolder(sessionId: string, hosts: WorkspaceHosts | null | undefined): string {
  for (const h of hosts?.hosts || []) {
    if (h.leases?.some((l) => l.session === sessionId)) return h.device_id;
  }
  return "";
}
