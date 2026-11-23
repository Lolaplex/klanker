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


def _hub_rows() -> dict:
    """hub_id -> hubs.json row (url, device_id, ...)."""
    from agents_workspace import Host

    p = Host.from_env().clients / "hubs.json"
    try:
        return dict(
            (json.loads(p.read_text(encoding="utf-8")) or {}).get("hubs")
            or {})
    except (OSError, json.JSONDecodeError):
        return {}


def cmd_ws_invite(args) -> int:
    """Mint a ws-scoped pair code on the hub — redeem pairs the device
    AND grants ws membership in one step (klanker#145 R4)."""
    import urllib.error
    import urllib.request

    from agents_workspace import Host

    host = Host.from_env()
    ws_id = args.id.strip()
    if not host.workspace_exists(ws_id):
        print(f"Error: unknown workspace id: {ws_id}", file=sys.stderr)
        return 2
    rows = _hub_rows()
    if not rows:
        print("Error: no paired hub — pair a device first "
              "(`agents-relay channel connect <url> <code>`)",
              file=sys.stderr)
        return 2
    hub_id = args.hub.strip() if getattr(args, "hub", "") else ""
    if hub_id:
        row = rows.get(hub_id)
        if row is None:
            print(f"Error: unknown hub id: {hub_id} "
                  f"(have: {', '.join(sorted(rows))})", file=sys.stderr)
            return 2
    elif len(rows) == 1:
        hub_id, row = next(iter(rows.items()))
    else:
        print(f"Error: multiple hubs — pass --hub "
              f"({', '.join(sorted(rows))})", file=sys.stderr)
        return 2
    own = str(row.get("device_id") or "")
    ws = host.workspace(ws_id)
    owner = (getattr(ws, "execution", None) or {}).get("owner") or ""
    if owner != own:
        host.update_workspace(
            ws_id, sync_policy="synced",
            execution={
                **(getattr(ws, "execution", None) or {}),
                "owner": own})
    from agents_relay.channel_client import hub_token

    token = hub_token(hub_id)
    if not token:
        print(f"Error: no device token for hub {hub_id}",
              file=sys.stderr)
        return 2
    url = row["hub_url"].rstrip("/") + "/v1/ws/invite"
    req = urllib.request.Request(
        url, data=json.dumps({"ws": ws_id}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}",
                 "X-Device-Id": own},
        method="POST")
    try:
        res = json.loads(urllib.request.urlopen(req, timeout=15).read())
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        print(f"Error: invite refused ({exc.code}): {detail}",
              file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"Error: invite failed: {exc}", file=sys.stderr)
        return 2
    print(f"workspace {ws_id} invite on {hub_id} "
          f"(expires in {res.get('expires_in', '?')}s):")
    print(f"  code: {res['code']}")
    print(f"  url:  {res['pair_url']}")
    try:
        from .qr import render_qr_unicode
        print(render_qr_unicode(res["pair_url"]))
    except Exception:  # noqa: BLE001
        pass
    return 0


def cmd_ws_join(args) -> int:
    """Redeem a ws invite: pairs the device and grants ws membership."""
    raw = args.invite.strip()
    if not raw:
        print("Error: invite code or URL required", file=sys.stderr)
        return 2
    hub_url, credential = "", raw
    if "://" in raw:
        # pair_url shape: <base>/#pair=<token>
        base, _, frag = raw.partition("#")
        hub_url = base.rstrip("/")
        if frag.startswith("pair="):
            credential = frag[5:]
    if not hub_url:
        # bare code: needs a hub URL — reuse the first paired row's hub
        rows = _hub_rows()
        if len(rows) == 1:
            hub_url = rows[next(iter(rows))]["hub_url"]
        else:
            print("Error: pass the full invite URL "
                  "(code alone cannot resolve the hub)", file=sys.stderr)
            return 2
    if not credential:
        print("Error: empty invite credential", file=sys.stderr)
        return 2
    from agents_relay.channel_client import connect_hub

    try:
        row = connect_hub(hub_url, credential, label="ws-invite")
    except Exception as exc:  # noqa: BLE001
        print(f"Error: join failed: {exc}", file=sys.stderr)
        return 2
    print(f"paired {row['hub_id']} as {row['device_id']}")
    if row.get("ws"):
        print(f"workspace grant: {row['ws']} "
              f"(appears after `klanker serve` connects)")
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
