"""`klanker workspace share|unshare|members` — per-ws member grants.

Edits only the local ``workspace.json``; a running ``klanker serve``
detects the member-set diff on its sync tick and emits ws:announce /
ws:revoke frames to the hub (klanker#145 — desired-state
reconciliation, so shares also propagate after reconnect).
"""
from __future__ import annotations

import json
import sys
import time


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
    prev_exec = dict(getattr(ws, "execution", None) or {})
    owner = str(prev_exec.get("owner") or "")
    if owner and owner not in own:
        # never clobber a recorded foreign owner (klanker#155)
        print(f"Error: workspace {ws_id} is owned by {owner} — "
              "share refused", file=sys.stderr)
        return 2
    members |= own | {target}
    host.update_workspace(
        ws_id,
        sync_hosts=sorted(members),
        sync_policy="synced",
        execution={
            **prev_exec,
            # deterministic own id (set iteration order is random);
            # an existing owner is never overwritten (klanker#155)
            "owner": owner or (sorted(own)[0] if own else "local"),
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


def _post_ws_announce(row: dict, device_id: str, token: str,
                      payload: dict) -> None:
    """Synchronously upstream one ws:announce through /v1/hub/send.

    ``ChannelClient.send`` is intentionally asynchronous inside a running
    serve. The invite CLI is a short-lived process, and /v1/ws/invite can
    only authorize after the hub has applied the ownership announce — so
    the credential-minting path posts this one frame itself instead of
    waiting for a sync tick (klanker#155).
    """
    import urllib.request

    envelope = {"v": 1, "ch": device_id, "kind": "ws:announce",
                "id": "", "ts": time.time(), "payload": payload}
    req = urllib.request.Request(
        str(row["hub_url"]).rstrip("/") + "/v1/hub/send",
        data=json.dumps({"ch": device_id, "msgs": [envelope]}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}",
                 "X-Device-Id": device_id},
        method="POST")
    resp = None
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        out = json.loads(resp.read().decode("utf-8") or "{}")
    finally:
        if resp is not None:
            close = getattr(resp, "close", None)
            if callable(close):
                close()
    if not out.get("ok", False):
        raise RuntimeError(out.get("error") or out or "hub send refused")
    if int(out.get("malformed") or 0):
        raise RuntimeError("hub dropped the ownership announce as malformed")


def _restore_preinvite_owner(host, ws_id: str, prev_exec: dict,
                             owner: str) -> None:
    """Undo the owner written solely for a failed invite mint."""
    if owner:
        return
    try:
        host.update_workspace(
            ws_id, execution={**prev_exec, "owner": ""})
    except Exception:  # noqa: BLE001
        pass


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
        # 1) make the ws syncable + put our device on the member set.
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
    try:
        # The hub authorizes /v1/ws/invite against ITS workspace copy.
        # A short-lived CLI cannot wait for the serve reconcile tick, so
        # upstream the ownership announce synchronously first.
        _post_ws_announce(row, own, token, {
            "ws": ws_id,
            "label": str(getattr(ws, "label", "") or ""),
            "owner": own,
            "sync_hosts": sorted(members),
            "seq": int(time.time() * 1000),
        })
    except Exception as exc:  # noqa: BLE001
        _restore_preinvite_owner(host, ws_id, prev_exec, owner)
        print(f"Error: ownership announce failed: {exc}",
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
        # invite died — restore the pre-existing (empty) owner so a
        # failed invite never leaves a phantom owner behind. execution
        # MERGES (agents-workspace failclosed): an explicit "owner":""
        # is the only owner-clear (klanker#155).
        _restore_preinvite_owner(host, ws_id, prev_exec, owner)
        if exc.code == 403:
            print(f"Error: invite refused (403): {detail} — "
                  "the hub rejected the synchronized ownership announce",
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


_TOKEN_RE_SRC = r"[A-Za-z0-9_-]{3,64}"  # secrets.token_urlsafe charset


def _parse_invite(raw: str) -> tuple[str, str]:
    """Strict invite parse -> (hub_url, credential).

    Accepted forms (klanker#147, fragment shapes minted by pairing.py):
      https://host/#pair=<token>                  (admin/legacy pair)
      https://host/#kind=remote&pair=<token>      (remote pair)
      https://host/#kind=ws&ws=<id>&pair=<token>  (ws invite)
      XXXX-XXXX                                   (bare code — hub
        resolved from the single paired hubs.json row)

    The fragment credential is a urlsafe token — ``_`` and ``-`` both
    occur; a ``[A-Za-z0-9-]``-only regex silently rejected valid
    invites (klanker#155).
    """
    import re
    import urllib.parse

    global _PAIR_URL_RE, _BARE_CODE_RE
    if _PAIR_URL_RE is None:
        _PAIR_URL_RE = re.compile(r"^(https?://[^#\s]+)#(.+)$")
        _BARE_CODE_RE = re.compile(r"^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$")
    m = _PAIR_URL_RE.match(raw)
    if m:
        params = urllib.parse.parse_qs(
            m.group(2), keep_blank_values=True)
        # strict: only the fragment keys pairing.py mints — a smuggled
        # param (`&evil=1`) rejects the whole invite (klanker#147)
        if not set(params) <= {"pair", "kind", "ws"}:
            return "", ""
        token = str((params.get("pair") or [""])[0])
        if re.fullmatch(_TOKEN_RE_SRC, token):
            return m.group(1).rstrip("/"), token
        return "", ""
    if _BARE_CODE_RE.match(raw):
        return "", raw
    return "", ""


def _join_via_live_serve(hub_url: str, credential: str,
                         label: str) -> tuple[dict | None, str, bool]:
    """Redeem through the running local serve's /v1/hub/connect.

    Returns ``(result, error, endpoint_used)``. ``endpoint_used=False``
    means there is no usable local management surface and the caller may
    fall back to ``connect_hub`` directly; a hard error is never retried
    because the single-use invite may already have been consumed.
    """
    import urllib.error
    import urllib.request

    try:
        from agents_workspace import resolve_relay_token

        from .daemon import discover_live_serve

        live = discover_live_serve()
        token = resolve_relay_token() if live else ""
    except Exception:  # noqa: BLE001
        return None, "", False
    if not live or not token:
        return None, "", False
    req = urllib.request.Request(
        live.rstrip("/") + "/v1/hub/connect",
        data=json.dumps({"url": hub_url, "code": credential,
                         "label": label}).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST")
    resp = None
    try:
        resp = urllib.request.urlopen(req, timeout=35)
        out = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read()[:300].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = str(exc)
        if exc.code in (404, 405, 501):
            return None, "", False  # old serve without the mgmt route
        return None, f"local serve refused join ({exc.code}): {detail}", True
    except Exception:  # noqa: BLE001 — the live serve raced shutdown
        return None, "", False
    finally:
        if resp is not None:
            close = getattr(resp, "close", None)
            if callable(close):
                close()
    if not isinstance(out, dict) or not out.get("ok"):
        return None, ("local serve refused join: "
                      f"{(out or {}).get('error') or out}"), True
    return out, "", True


def cmd_ws_join(args) -> int:
    """Redeem a ws invite: pairs the device and grants ws membership.

    A running local serve owns the live SyncRuntime, so prefer its
    ``/v1/hub/connect`` route — redeem + persist + attach happen in the
    process that must open the channel. Without a live management
    surface, fall back to ``channel_client.connect_hub`` (the same
    redeem + reuse wire): an already-paired device redeems under its
    existing credential so the hub grants the ws onto the SAME device_id
    and every prior ws share survives (klanker#147)."""
    import urllib.error

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
    label = getattr(args, "label", "") or ""
    res, local_err, local_used = _join_via_live_serve(
        hub_url, credential, label)
    if local_err:
        print(f"Error: {local_err}", file=sys.stderr)
        return 2
    if res is None:
        from agents_relay.channel_client import connect_hub

        try:
            res = connect_hub(hub_url, credential, label=label)
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read()[:300].decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                detail = str(exc)
            print(f"Error: join refused ({exc.code}): {detail}",
                  file=sys.stderr)
            return 2
        except Exception as exc:  # noqa: BLE001
            print(f"Error: join failed: {exc}", file=sys.stderr)
            return 2
    device_id = str(res.get("device_id") or "")
    hub_id = str(res.get("hub_id") or "")
    if res.get("reused"):
        print(f"redeemed on {hub_id} — device {device_id} kept "
              "(prior workspace shares preserved)")
    else:
        print(f"paired {hub_id} as {device_id}")
    if res.get("ws"):
        if local_used:
            print(f"workspace grant: {res['ws']} — local serve "
                  "attach requested via /v1/hub/connect")
        else:
            print(f"workspace grant: {res['ws']} — a running "
                  "`klanker serve` attaches the new hub link and syncs it "
                  "on the next tick")
    # Direct fallback only: nudge an in-process runtime when the CLI is
    # embedded in one. The normal live-serve path already went through
    # /v1/hub/connect, whose handler attaches the new link itself.
    if not local_used:
        try:
            from .wssync import _runtime as _rt

            rt = _rt()
            if rt is not None:
                rt._attach_new_hubs()
        except Exception:  # noqa: BLE001
            pass
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
    print(f"  sync_policy: {getattr(ws, 'sync_policy', '') or 'local'}")
    print(f"  owner:       {owner or '-'}")
    # frozenset() = CLOSED — there is no open-herd mode (klanker#146)
    print(f"  members:     {', '.join(sorted(members)) or 'closed (no members)'}")
    own = _own_device_ids()
    if own:
        print(f"  own devices: {', '.join(sorted(own))}")
    return 0
