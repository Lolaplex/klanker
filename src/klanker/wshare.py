"""`klanker workspace share|unshare|members` — per-ws member grants.

Edits only the local ``workspace.json``; a running ``klanker serve``
detects the member-set diff on its sync tick and emits ws:announce /
ws:revoke frames to the hub (klanker#145 — desired-state
reconciliation, so shares also propagate after reconnect).
"""
from __future__ import annotations

import json
import sys


def _own_device_ids() -> set[str]:
    """Our channel device ids — one per paired hub (hubs.json rows)."""
    from agents_workspace import Host

    p = Host.from_env().clients / "hubs.json"
    try:
        rows = (json.loads(p.read_text(encoding="utf-8")) or {}).get("hubs") or {}
    except (OSError, json.JSONDecodeError):
        rows = {}
    return {str(r.get("device_id") or "") for r in rows.values()
            if r.get("device_id")}


def _member_state(host, ws_id: str):
    ws = host.workspace(ws_id)
    return ws, set(getattr(ws, "sync_hosts", None) or ())


def cmd_ws_share(args) -> int:
    from agents_workspace import Host

    host = Host.from_env()
    ws_id = args.id.strip()
    if not host.workspace_exists(ws_id):
        print(f"Error: unknown workspace id: {ws_id}", file=sys.stderr)
        return 2
    target = (args.to or "").strip()
    if not target:
        print("Error: --to <device-id> required "
              "(see /v1/hub/devices on the hub)", file=sys.stderr)
        return 2
    own = _own_device_ids()
    if target in own:
        print("Error: target is one of this host's own device ids",
              file=sys.stderr)
        return 2
    ws, members = _member_state(host, ws_id)
    if not own:
        print("warning: no paired hub found — share applies on next "
              "channel connect", file=sys.stderr)
    members |= own | {target}
    host.update_workspace(
        ws_id,
        sync_hosts=sorted(members),
        sync_policy="synced",
        execution={
            **(getattr(ws, "execution", None) or {}),
            "owner": next(iter(own), "") or "local",
        })
    print(f"workspace {ws_id}: shared -> {target} "
          f"(members: {', '.join(sorted(members))})")
    print("propagates via running `klanker serve` on the next sync tick")
    return 0


def cmd_ws_unshare(args) -> int:
    from agents_workspace import Host

    host = Host.from_env()
    ws_id = args.id.strip()
    if not host.workspace_exists(ws_id):
        print(f"Error: unknown workspace id: {ws_id}", file=sys.stderr)
        return 2
    if args.open:
        host.update_workspace(ws_id, sync_hosts=[])
        print(f"workspace {ws_id}: reopened to all paired devices")
        return 0
    target = (args.to or "").strip()
    if not target:
        print("Error: --to <device-id> required", file=sys.stderr)
        return 2
    if target in _own_device_ids():
        print("Error: refusing to unshare this host's own device id",
              file=sys.stderr)
        return 2
    _, members = _member_state(host, ws_id)
    if target not in members:
        print(f"workspace {ws_id}: {target} is not a member")
        return 0
    members.discard(target)
    host.update_workspace(
        ws_id, sync_hosts=sorted(members) if members else [])
    print(f"workspace {ws_id}: unshared <- {target} "
          f"(members: {', '.join(sorted(members)) or 'open'})")
    return 0


def cmd_ws_members(args) -> int:
    from agents_workspace import Host

    host = Host.from_env()
    ws_id = args.id.strip()
    if not host.workspace_exists(ws_id):
        print(f"Error: unknown workspace id: {ws_id}", file=sys.stderr)
        return 2
    ws, members = _member_state(host, ws_id)
    owner = (getattr(ws, "execution", None) or {}).get("owner") or ""
    print(f"{ws.id}  {ws.label or ''}")
    print(f"  sync_policy: {getattr(ws, 'sync_policy', '') or 'synced'}")
    print(f"  owner:       {owner or '-'}")
    print(f"  members:     {', '.join(sorted(members)) or 'open (all paired devices)'}")
    own = _own_device_ids()
    if own:
        print(f"  own devices: {', '.join(sorted(own))}")
    return 0
