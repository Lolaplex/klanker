import { swrKey } from "./swrCache";

export type SidebarSession = {
  id: string;
  goal?: string;
  title?: string;
  host?: string;
  branch?: string;
  repo?: string;
  wip_unpushed?: boolean;
  last_active?: string;
};

/** Canonical per-persona session-list cache key. The persona is part of the
 *  domain because one workspace can host several independent persona lanes. */
export function sessionListKey(instanceId: string, workspace: string, persona: string): string {
  return swrKey(instanceId, workspace, `sessions:${persona}`);
}

export function sessionEventsKey(instanceId: string, workspace: string, persona: string, session: string): string {
  return swrKey(instanceId, workspace, `sessions:events:${persona}:${session}`);
}

export function providerRowsKey(instanceId: string, remoteDevice = ""): string {
  return swrKey(instanceId, "_root", remoteDevice ? `providers:remote:${remoteDevice}` : "providers");
}

export function providerCatalogKey(instanceId: string): string {
  return swrKey(instanceId, "_root", "providers:catalog");
}
