/** Relay version compat (klanker#106). The bundled web build requires a
 *  relay of at least MIN_RELAY; older relays keep working but get a
 *  warning, and relays too old to report a version get a one-shot hint. */
export const MIN_RELAY = "0.1.1";

export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((s) => parseInt(s, 10) || 0);
  const pb = b.split(/[.-]/).map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type RelayCompat =
  | { kind: "stale-local"; version: string }
  | { kind: "stale-remote"; version: string }
  | { kind: "unknown" };

/** Map a probed health result to a banner decision. `local` = this app
 *  owns the serve (desktop managedId), so an upgrade path exists. */
export function compatOf(
  version: string | null | undefined,
  local: boolean
): RelayCompat | null {
  if (version) {
    if (cmpVersion(version, MIN_RELAY) < 0) {
      return { kind: local ? "stale-local" : "stale-remote", version };
    }
    return null;
  }
  return { kind: "unknown" };
}
