"""`klanker workspace share|unshare|members` — per-ws member grants.

Edits only the local ``workspace.json``; a running ``klanker serve``
detects the member-set diff on its sync tick and emits ws:announce /
ws:revoke frames to the hub (klanker#145 — desired-state
reconciliation, so shares also propagate after reconnect).
"""
from __future__ import annotations

import json
import sys


def _own_device_ids(hub_id: str = "") -> set[str]:
    """Our channel device ids — one per paired hub (hubs.json rows).
    ``hub_id`` scopes the set to a single paired hub."""
    from agents_workspace import Host

    p = Host.from_env().clients / "hubs.json"
    try:
        rows = (json.loads(p.read_text(encoding="utf-8")) or {}).get("hubs") or {}
    except (OSError, json.JSONDecodeError):
        rows = {}
    if hub_id:
        rows = {hub_id: rows[hub_id]} if hub_id in rows else {}
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
    own = _own_device_ids(getattr(args, "hub", "") or "")
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
    target = (args.to or "").strip()
    if not target:
        print("Error: --to <device-id> required", file=sys.stderr)
        return 2
    if target in _own_device_ids(getattr(args, "hub", "") or ""):
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
          f"(members: {', '.join(sorted(members)) or 'none — closed'})")
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
    AND grants ws membership in one step (klanker#145 R4 / klanker#147)."""
    import urllib.error
    import urllib.request

    from agents_workspace import Host

    want_json = bool(getattr(args, "json", False))
    if not want_json and not sys.stdout.isatty():
        # The code IS a credential: never pipe it into a file/log by
        # accident. --json is the explicit non-interactive escape hatch.
        print("Error: refusing to print invite credentials on non-TTY "
              "stdout — pass --json for machine use", file=sys.stderr)
        return 2
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
    if not own:
        print(f"Error: hubs.json row for {hub_id} has no device_id",
              file=sys.stderr)
        return 2
    ws = host.workspace(ws_id)
    prev_exec = dict(getattr(ws, "execution", None) or {})
    owner = prev_exec.get("owner") or ""
    if owner and owner != own:
        # never clobber a recorded foreign owner for a doomed invite
        print(f"Error: workspace {ws_id} is owned by {owner} — "
              "invite refused", file=sys.stderr)
        return 2
    try:
        # 1) make the ws syncable + put our device on the member set —
        #    the reconcile tick (or an already-live channel) carries the
        #    announce to the hub BEFORE we mint credentials there.
        members = set(getattr(ws, "sync_hosts", None) or ()) | {own}
        host.update_workspace(
            ws_id, sync_policy="synced", sync_hosts=sorted(members))
        # 2) only then record local ownership — announce frames now
        #    carry us as owner (klanker#147 ordering).
        if not owner:
            host.update_workspace(
                ws_id, execution={**prev_exec, "owner": own})
    except (TypeError, ValueError) as exc:
        print(f"Error: workspace policy update failed: {exc}",
              file=sys.stderr)
        return 2
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
        try:
            detail = exc.read()[:300].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = str(exc)
        if not owner:
            # invite died — restore the pre-existing (empty) owner so a
            # failed invite never leaves a phantom owner behind.
            try:
                host.update_workspace(ws_id, execution=prev_exec)
            except Exception:  # noqa: BLE001
                pass
        if exc.code == 403:
            print(f"Error: invite refused (403): {detail} — "
                  "the hub has not seen our ownership announce yet; "
                  "run `klanker serve` and retry after a sync tick",
                  file=sys.stderr)
        else:
            print(f"Error: invite refused ({exc.code}): {detail}",
                  file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"Error: invite failed: {exc}", file=sys.stderr)
        return 2
    if want_json:
        print(json.dumps({
            "ok": True, "ws": ws_id, "hub": hub_id,
            "code": res["code"], "pair_url": res["pair_url"],
            "expires_in": res.get("expires_in")}))
        return 0
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


_PAIR_URL_RE = None
_BARE_CODE_RE = None


def _parse_invite(raw: str) -> tuple[str, str]:
    """Strict invite parse -> (hub_url, code).

    Accepted forms (klanker#147):
      https://host/#pair=XXXX-XXXX   (full pair URL, fragment-carried)
      XXXX-XXXX                      (bare code — hub resolved from
                                      the single paired hubs.json row)
    """
    import re

    global _PAIR_URL_RE, _BARE_CODE_RE
    if _PAIR_URL_RE is None:
        _PAIR_URL_RE = re.compile(
            r"^(https?://[^#\s]+)#pair=([A-Za-z0-9-]{4,64})$")
        _BARE_CODE_RE = re.compile(r"^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$")
    m = _PAIR_URL_RE.match(raw)
    if m:
        return m.group(1).rstrip("/"), m.group(2)
    if _BARE_CODE_RE.match(raw):
        return "", raw
    return "", ""


def cmd_ws_join(args) -> int:
    """Redeem a ws invite: pairs the device and grants ws membership.

    An already-paired device redeems under its existing identity — the
    hub grants the ws onto the SAME device_id and every prior ws share
    survives (klanker#147)."""
    raw = args.invite.strip()
    if not raw:
        print("Error: invite code or URL required", file=sys.stderr)
        return 2
    hub_url, credential = _parse_invite(raw)
    if not credential:
        print("Error: malformed invite — pass the full "
              "<hub>/#pair=XXXX-XXXX URL or a bare XXXX-XXXX code",
              file=sys.stderr)
        return 2
    rows = _hub_rows()
    if not hub_url:
        if len(rows) == 1:
            hub_url = rows[next(iter(rows))]["hub_url"]
        else:
            print("Error: pass the full invite URL "
                  "(a bare code cannot resolve the hub)",
                  file=sys.stderr)
            return 2
    existing = None
    for hid, r in rows.items():
        if str(r.get("hub_url") or "").rstrip("/") == hub_url:
            existing = (hid, r)
            break
    import urllib.error
    import urllib.parse
    import urllib.request

    body = {"token": credential, "code": credential,
            "label": getattr(args, "label", "") or ""}
    headers = {"Content-Type": "application/json",
               "User-Agent": "agents-relay/device"}
    reused = False
    if existing is not None:
        hid, r = existing
        from agents_relay.channel_client import hub_token

        tok = hub_token(hid)
        did = str(r.get("device_id") or "")
        if tok and did:
            # Present our existing credential: the hub grants the ws
            # onto the same device_id — no replacement identity,
            # all prior shares kept (agents-relay#42, klanker#147).
            headers["Authorization"] = f"Bearer {tok}"
            headers["X-Device-Id"] = did
            reused = True
    req = urllib.request.Request(
        f"{hub_url}/v1/pair/redeem",
        data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        res = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as exc:
        detail = exc.read()[:300].decode("utf-8", "replace")
        print(f"Error: join refused ({exc.code}): {detail}",
              file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"Error: join failed: {exc}", file=sys.stderr)
        return 2
    if not res.get("ok"):
        print(f"Error: join refused: {res.get('error') or res}",
              file=sys.stderr)
        return 2
    device_id = str(res.get("device_id") or "")
    hub_id = str(res.get("host_id") or "") or \
        urllib.parse.urlparse(hub_url).hostname or "hub"
    if reused:
        if device_id != existing[1].get("device_id"):
            print(f"paired {hub_id} as {device_id} "
                  "(WARNING: hub returned a different device id)")
        else:
            print(f"redeemed on {hub_id} — device {device_id} kept "
                  "(prior workspace shares preserved)")
    else:
        token = str(res.get("token") or "")
        if not device_id or not token:
            print("Error: hub returned no device credentials",
                  file=sys.stderr)
            return 2
        from agents_workspace import write_secret
        from agents_relay.channel_client import _secret_key

        rows[hub_id] = {
            "hub_url": hub_url, "device_id": device_id,
            "label": getattr(args, "label", "") or res.get("host_id") or hub_id,
            "last_seq": 0, "connected_at": int(__import__("time").time())}
        _store_hub_rows(rows)
        write_secret(_secret_key(hub_id), token, scope="host")
        print(f"paired {hub_id} as {device_id}")
    if res.get("ws"):
        print(f"workspace grant: {res['ws']} — a running "
              "`klanker serve` attaches the new hub link and syncs it "
              "on the next tick")
    return 0


def _store_hub_rows(rows: dict) -> None:
    from agents_relay.state import write_json_atomic
    from agents_workspace import Host

    write_json_atomic(
        Host.from_env().clients / "hubs.json", {"hubs": rows})


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
