"""klanker migrate --to-store: fold file domains into store.db datoms.

One-way, idempotent import (klanker#143 / frontier #19):
- personas/<id>/persona.json  -> persona:<id> entities
- config.json scalar settings -> cfg:<key> entities (key_env refs only —
  secret *values* never become datoms)
- memory/*.md (top level)     -> mem:<slug> entities

Identity: origin_actor="import:<domain>:<id>", origin_seq=mtime_ms —
re-running with an unchanged file dedupes on ux_tx_origin; a changed
file re-imports and card-one LWW picks the newer mtime. Source files
move to <ws>/archive/pre-store/ only after their tx commits.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from agents_store.db import connect
from agents_store.ingest import ingest

from .msgsync import ensure_domain

MIGRATE_ATTRS = {
    "persona:id": ("text", "one"),
    "persona:name": ("text", "one"),
    "persona:json": ("text", "one"),
    "cfg:key": ("text", "one"),
    "cfg:value": ("text", "one"),
    "cfg:key_env": ("text", "one"),
    "mem:file": ("text", "one"),
    "mem:title": ("text", "one"),
    "mem:text": ("text", "one"),
}

# config keys whose values must never enter the log — only their env
# indirection may be recorded.
SECRET_HINTS = ("token", "secret", "key", "password", "credential")


def ensure_migrate_domain(conn) -> None:
    ensure_domain(conn)
    for name, (vt, card) in MIGRATE_ATTRS.items():
        conn.execute(
            "INSERT OR IGNORE INTO attr (name, value_type, cardinality, doc)"
            " VALUES (?, ?, ?, ?)",
            (name, vt, card, "migrate --to-store import domain"))


def _import(conn, domain: str, ident: str, mtime_ms: int, datoms) -> bool:
    """One idempotent tx. Returns True if newly applied."""
    actor = f"import:{domain}:{ident}"
    res = ingest(
        conn, actor, int(mtime_ms), f"{int(mtime_ms):013d}.00000.import",
        datoms)
    return bool(res.applied)


def _archive(ws_dir: Path, src: Path) -> Path:
    rel = src.relative_to(ws_dir)
    dst = ws_dir / "archive" / "pre-store" / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst = dst.with_name(dst.name + ".dup")
    shutil.move(str(src), str(dst))
    return dst


def migrate_personas(conn, ws_dir: Path, archive: bool) -> dict:
    root = ws_dir / "personas"
    stats = {"imported": 0, "dupes": 0, "archived": 0}
    if not root.is_dir():
        return stats
    for manifest in sorted(root.glob("*/persona.json")):
        pid = manifest.parent.name
        try:
            doc = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(doc, dict):
            continue
        mtime_ms = int(manifest.stat().st_mtime * 1000)
        e = f"persona:{pid}"
        datoms = [(e, "persona:id", pid, True),
                  (e, "persona:json",
                   json.dumps(doc, sort_keys=True), True)]
        name = doc.get("name") or doc.get("label")
        if name:
            datoms.append((e, "persona:name", str(name), True))
        if _import(conn, "persona", pid, mtime_ms, datoms):
            stats["imported"] += 1
        else:
            stats["dupes"] += 1
        if archive:
            _archive(ws_dir, manifest)
            stats["archived"] += 1
    return stats


def migrate_config(conn, ws_dir: Path, archive: bool) -> dict:
    cfg = ws_dir / "config.json"
    stats = {"imported": 0, "dupes": 0, "skipped_secret": 0, "archived": 0}
    if not cfg.is_file():
        return stats
    try:
        doc = json.loads(cfg.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return stats
    if not isinstance(doc, dict):
        return stats
    import re

    env_name = re.compile(r"^[A-Z][A-Z0-9_]{2,}$")
    mtime_ms = int(cfg.stat().st_mtime * 1000)
    for key in sorted(doc):
        v = doc[key]
        if any(h in key.lower() for h in SECRET_HINTS):
            stats["skipped_secret"] += 1
            # Only an env indirection may be recorded — never a value.
            if isinstance(v, str) and env_name.match(v):
                e = f"cfg:{key}"
                if _import(conn, "config", key, mtime_ms,
                           [(e, "cfg:key", key, True),
                            (e, "cfg:key_env", v, True)]):
                    stats["imported"] += 1
                else:
                    stats["dupes"] += 1
            continue
        if isinstance(v, (dict, list)):
            v = json.dumps(v, sort_keys=True)
        e = f"cfg:{key}"
        if _import(conn, "config", key, mtime_ms,
                   [(e, "cfg:key", key, True),
                    (e, "cfg:value", str(v), True)]):
            stats["imported"] += 1
        else:
            stats["dupes"] += 1
    if archive:
        _archive(ws_dir, cfg)
        stats["archived"] += 1
    return stats


def migrate_memory(conn, ws_dir: Path, archive: bool) -> dict:
    root = ws_dir / "memory"
    stats = {"imported": 0, "dupes": 0, "archived": 0}
    if not root.is_dir():
        return stats
    for md in sorted(root.glob("*.md")):
        slug = md.stem
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        mtime_ms = int(md.stat().st_mtime * 1000)
        title = ""
        for line in text.splitlines():
            if line.strip().startswith("#"):
                title = line.strip().lstrip("#").strip()
                break
        e = f"mem:{slug}"
        datoms = [(e, "mem:file", md.name, True),
                  (e, "mem:text", text, True)]
        if title:
            datoms.append((e, "mem:title", title, True))
        if _import(conn, "memory", slug, mtime_ms, datoms):
            stats["imported"] += 1
        else:
            stats["dupes"] += 1
        if archive:
            _archive(ws_dir, md)
            stats["archived"] += 1
    return stats


def migrate_to_store(ws_dir: str | Path, *, archive: bool = True) -> dict:
    ws_dir = Path(ws_dir)
    conn = connect(ws_dir / "store.db")
    try:
        ensure_migrate_domain(conn)
        out = {}
        for domain, fn in (("personas", migrate_personas),
                           ("config", migrate_config),
                           ("memory", migrate_memory)):
            out[domain] = fn(conn, ws_dir, archive)
        return out
    finally:
        conn.close()
