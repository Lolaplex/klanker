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

    print("usage: klanker remote list|add|rm", file=sys.stderr)
    return 2
