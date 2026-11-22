"""``klanker remote list|add|rm`` + ``--remote <id>`` remote host registry.

Canonical store is ``<host>/clients/remotes.json`` via
``agents_relay.remotes``; tokens live in the Host Vault as
``REMOTE_<ID>_TOKEN`` (``scope="host"``) and are never printed, never
written to metadata, and never passed on argv where ``ps`` can see them.
"""

from __future__ import annotations

import getpass
import json
import re
import sys
import urllib.error
import urllib.request
from typing import Any

_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9_-]+", "-", (name or "").strip().lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug


def _relay_config():
    from agents_relay.config import RelayConfig

    return RelayConfig.from_env()


def list_remotes() -> list[dict[str, Any]]:
    """Public rows: id, base_url, label, token_set — no secret material."""
    from agents_relay.remotes import list_public

    rows = []
    for row in list_public(_relay_config()):
        rows.append(
            {
                "id": str(row.get("id") or ""),
                "base_url": str(row.get("base_url") or ""),
                "label": str(row.get("label") or ""),
                "token_set": bool(row.get("has_secret")),
            }
        )
    return rows


def resolve_remote(rid: str) -> dict[str, Any] | None:
    """One registered remote row by id, or None."""
    wanted = (rid or "").strip()
    if not wanted:
        return None
    for row in list_remotes():
        if row["id"] == wanted:
            return row
    return None


def _read_token(args: Any) -> str:
    if getattr(args, "token_stdin", False):
        return sys.stdin.read().strip()
    token = str(getattr(args, "token", "") or "").strip()
    if token:
        return token
    if getattr(args, "prompt", False) or sys.stdin.isatty():
        return getpass.getpass("remote token (empty for none): ").strip()
    print(
        "Error: no token flag in non-TTY mode — pass --token-stdin "
        "(or --token/--prompt interactively)",
        file=sys.stderr,
    )
    raise SystemExit(2)


def cmd_remote(args: Any) -> int:
    op = getattr(args, "remote_cmd", "") or ""
    if op == "list":
        rows = list_remotes()
        if getattr(args, "json", False):
            print(json.dumps({"remotes": rows}, indent=2))
            return 0
        for row in rows:
            token = "token" if row["token_set"] else "no-token"
            label = f" — {row['label']}" if row["label"] else ""
            print(f"{row['id']:<20} {row['base_url']:<40} {token}{label}")
        if not rows:
            print("no remotes registered")
        return 0

    if op == "add":
        from agents_relay.remotes import upsert_remote, validate_remote_base_url

        name = str(getattr(args, "name", "") or "").strip()
        rid = str(getattr(args, "id", "") or "").strip() or _slug(name)
        if not rid or not _SAFE_ID.match(rid):
            print(f"Error: invalid remote id: {rid!r}", file=sys.stderr)
            return 2
        try:
            base_url = validate_remote_base_url(getattr(args, "url", "") or "")
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2
        token = _read_token(args)
        body: dict[str, Any] = {"id": rid, "base_url": base_url}
        if token:
            body["secret"] = token
        row, err = upsert_remote(_relay_config(), body)
        if row is None:
            print(f"Error: {err}", file=sys.stderr)
            return 2
        token_state = "token stored in host vault" if row.get("has_secret") else "no token"
        print(f"remote {row['id']} -> {row['base_url']} ({token_state})")
        return 0

    if op == "rm":
        from agents_relay.remotes import delete_remote

        rid = str(getattr(args, "id", "") or "").strip()
        if not delete_remote(_relay_config(), rid):
            print(f"Error: unknown remote: {rid!r}", file=sys.stderr)
            return 1
        print(f"removed remote {rid}")
        return 0

    if op == "pair":
        return _cmd_remote_pair(args)

    print("usage: klanker remote list|add|pair|rm", file=sys.stderr)
    return 2


def _cmd_remote_pair(args: Any) -> int:
    from agents_relay.remotes import upsert_remote, validate_remote_base_url

    name = str(getattr(args, "name", "") or "").strip()
    rid = str(getattr(args, "id", "") or "").strip() or _slug(name)
    if not rid or not _SAFE_ID.match(rid):
        print(f"Error: invalid remote id: {rid!r}", file=sys.stderr)
        return 2
    try:
        base_url = validate_remote_base_url(getattr(args, "url", "") or "")
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2

    code = str(getattr(args, "code", "") or "").strip()
    if not code:
        if sys.stdin.isatty():
            code = getpass.getpass("pairing code (XXXX-XXXX): ").strip()
        else:
            print("Error: pairing code is required in non-TTY mode", file=sys.stderr)
            return 2
    if not code:
        print("Error: pairing code is required", file=sys.stderr)
        return 2

    req_body = json.dumps({"code": code, "mode": "remote"}).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/v1/pair/redeem",
        data=req_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        print(f"Error: pairing rejected ({exc.code}): {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: pairing failed: {exc}", file=sys.stderr)
        return 1

    if not isinstance(data, dict) or not data.get("ok") or data.get("mode") != "remote":
        print("Error: server did not authorize remote pairing", file=sys.stderr)
        return 1
    token = str(data.get("token") or "").strip()
    if not token:
        print("Error: pairing response missing token", file=sys.stderr)
        return 1

    row, err = upsert_remote(
        _relay_config(),
        {"id": rid, "base_url": base_url, "label": name, "secret": token},
    )
    if row is None:
        print(f"Error: {err}", file=sys.stderr)
        return 2
    host_id = str(data.get("host_id") or "").strip() or "-"
    print(f"paired remote {row['id']} -> {row['base_url']} (host_id={host_id}, token stored in host vault)")
    return 0


def cmd_pair(args: Any) -> int:
    """Mint a single-use pairing code / QR URL against the running local serve."""
    from agents_workspace import resolve_relay_token

    from .daemon import discover_live_serve
    from .qr import render_qr_unicode

    live_url = discover_live_serve()
    if not live_url:
        print("Error: no live local klanker serve found (start with 'klanker serve')", file=sys.stderr)
        return 1
    try:
        token = resolve_relay_token()
    except Exception:
        token = ""
    if not token:
        print("Error: relay bearer token unavailable in host vault", file=sys.stderr)
        return 1

    mode = "remote" if getattr(args, "remote", False) else "web"
    try:
        ttl = int(getattr(args, "ttl", 60) or 60)
    except (TypeError, ValueError):
        ttl = 60

    req = urllib.request.Request(
        f"{live_url.rstrip('/')}/v1/pair/create",
        data=json.dumps({"mode": mode, "ttl_sec": ttl}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:200]
        print(f"Error: failed to create pairing ({exc.code}): {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: failed to create pairing: {exc}", file=sys.stderr)
        return 1

    if not sys.stdout.isatty():
        print("pairing created: [REDACTED] (run on an interactive TTY to view code/QR)")
        print("warning: pairing credentials redacted because stdout is not a TTY", file=sys.stderr)
        return 0

    code = str(data.get("code") or "").strip()
    pair_url = str(data.get("pair_url") or "").strip()
    if pair_url.startswith("/"):
        pair_url = f"{live_url.rstrip('/')}{pair_url}"
    expires_in = int(data.get("expires_in") or ttl)

    print(f"pairing mode={mode} expires_in={expires_in}s")
    if code:
        print(f"code: {code}")
    if mode == "web" and pair_url:
        print(f"url:  {pair_url}")
        print(render_qr_unicode(pair_url))
    elif code:
        print(render_qr_unicode(code))
    return 0
