"""klanker migrate --to-store: fold file domains into store.db datoms.

One-way, idempotent import (klanker#143 / frontier #19):
- personas/<id>/persona.json  -> persona:<id> entities
- config.json scalar settings -> cfg:<key> entities (key_env refs only —
  secret *values* never become datoms)
- memory/*.md (top level)     -> mem:<slug> entities

Identity: origin_actor="import@<host>:<domain>:<id>", origin_seq=mtime_ms
— re-running with an unchanged file dedupes on ux_tx_origin; a changed
file re-imports and card-one LWW picks the newer mtime.

Secrets never become datoms: config and persona documents are scrubbed
recursively (secret-named keys at any depth, secret-looking values);
only env-indirection names (``"OPENAI_API_KEY"``) may be recorded.

Sources stay in place by default -- the runtime still reads
personas/config/memory from files. ``archive=True`` (CLI ``--archive``)
moves them to <ws>/archive/pre-store/ after their tx commits.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from agents_store.db import connect
from agents_store.ingest import ingest

from .msgsync import actor, ensure_domain, local_node_id

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

# Key names whose values must never enter the log -- only an env
# indirection may be recorded. Matched case-insensitively at any depth.
SECRET_HINTS = ("token", "secret", "password", "passwd", "passphrase",
                "credential", "apikey", "api_key", "private_key", "auth",
                "bearer", "cookie")
# An env-variable *name* (e.g. OPENAI_API_KEY) may stand in for a secret.
# Require an underscore so an all-caps literal password is not mistaken
# for an indirection and recorded.
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")
# Values that look like credentials regardless of their key name.
_SECRET_VALUE = re.compile(
    r"^(?:sk-|sk_|rk_|pk_live_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|"
    r"xox[abprs]-|AKIA[0-9A-Z]{12}|AIza|eyJ[\w-]{8,}\.eyJ|Bearer\s)")


def _is_secret_key(key: str) -> bool:
    k = str(key).lower().replace("-", "_")
    return (any(h in k for h in SECRET_HINTS) or k in ("key", "pass")
            or k.endswith("_key") or k.endswith("_pass"))


def _is_secret_value(v) -> bool:
    return isinstance(v, str) and bool(_SECRET_VALUE.match(v.strip()))


def scrub_secrets(obj, path: str = ""):
    """Return (clean, env_refs, dropped) for a JSON value.

    clean     -- copy with every secret removed (keys dropped from dicts,
                 items dropped from lists)
    env_refs  -- [(dotted.path, ENV_NAME)] for secret-named keys whose
                 value is an env-variable name (safe to record)
    dropped   -- number of secret values removed
    """
    refs: list[tuple[str, str]] = []
    dropped = 0
    if isinstance(obj, dict):
        clean = {}
        for k, v in obj.items():
            sub = f"{path}.{k}" if path else str(k)
            if _is_secret_key(k) and not isinstance(v, (dict, list)):
                if isinstance(v, str) and len(v) <= 64 and _ENV_NAME.match(v):
                    refs.append((sub, v))
                elif v not in (None, "", False):
                    dropped += 1
                continue
            c, r, d = scrub_secrets(v, sub)
            refs.extend(r)
            dropped += d
            if c is not _DROP:
                clean[k] = c
        return clean, refs, dropped
    if isinstance(obj, list):
        clean_list = []
        for i, v in enumerate(obj):
            c, r, d = scrub_secrets(v, f"{path}[{i}]")
            refs.extend(r)
            dropped += d
            if c is not _DROP:
                clean_list.append(c)
        return clean_list, refs, dropped
    if _is_secret_value(obj):
        return _DROP, refs, 1
    return obj, refs, 0


_DROP = object()


def ensure_migrate_domain(conn) -> None:
    ensure_domain(conn)
    for name, (vt, card) in MIGRATE_ATTRS.items():
        conn.execute(
            "INSERT OR IGNORE INTO attr (name, value_type, cardinality, doc)"
            " VALUES (?, ?, ?, ?)",
            (name, vt, card, "migrate --to-store import domain"))


def _import(conn, domain: str, ident: str, mtime_ms: int, datoms,
            node: str = "") -> bool:
    """One idempotent tx. Returns True if newly applied."""
    origin = actor("import", node or local_node_id(), f"{domain}:{ident}")
    res = ingest(
        conn, origin, int(mtime_ms), f"{int(mtime_ms):013d}.00000.import",
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


def migrate_personas(conn, ws_dir: Path, archive: bool,
                     node: str = "") -> dict:
    root = ws_dir / "personas"
    stats = {"imported": 0, "dupes": 0, "skipped_secret": 0, "archived": 0}
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
        doc, refs, dropped = scrub_secrets(doc)
        stats["skipped_secret"] += dropped + len(refs)
        e = f"persona:{pid}"
        datoms = [(e, "persona:id", pid, True),
                  (e, "persona:json",
                   json.dumps(doc, sort_keys=True), True)]
        name = doc.get("name") or doc.get("label")
        if name:
            datoms.append((e, "persona:name", str(name), True))
        if _import(conn, "persona", pid, mtime_ms, datoms, node):
            stats["imported"] += 1
        else:
            stats["dupes"] += 1
        if archive:
            _archive(ws_dir, manifest)
            stats["archived"] += 1
    return stats


def migrate_config(conn, ws_dir: Path, archive: bool,
                   node: str = "") -> dict:
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
    mtime_ms = int(cfg.stat().st_mtime * 1000)

    def put(key, datoms):
        if _import(conn, "config", key, mtime_ms, datoms, node):
            stats["imported"] += 1
        else:
            stats["dupes"] += 1

    clean, refs, dropped = scrub_secrets(doc)
    stats["skipped_secret"] += dropped + len(refs)
    # Only an env indirection may be recorded for a secret -- never a value.
    for path, env in refs:
        e = f"cfg:{path}"
        put(path, [(e, "cfg:key", path, True), (e, "cfg:key_env", env, True)])
    for key in sorted(clean):
        v = clean[key]
        if isinstance(v, (dict, list)):
            v = json.dumps(v, sort_keys=True)
        e = f"cfg:{key}"
        put(key, [(e, "cfg:key", key, True), (e, "cfg:value", str(v), True)])
    if archive:
        _archive(ws_dir, cfg)
        stats["archived"] += 1
    return stats


def migrate_memory(conn, ws_dir: Path, archive: bool,
                   node: str = "") -> dict:
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
        if _import(conn, "memory", slug, mtime_ms, datoms, node):
            stats["imported"] += 1
        else:
            stats["dupes"] += 1
        if archive:
            _archive(ws_dir, md)
            stats["archived"] += 1
    return stats


def migrate_to_store(ws_dir: str | Path, *, archive: bool = False,
                     node: str = "") -> dict:
    """Import file domains into store.db. Sources are kept unless
    ``archive=True`` -- the runtime still reads the files."""
    ws_dir = Path(ws_dir)
    node = node or local_node_id()
    conn = connect(ws_dir / "store.db")
    try:
        ensure_migrate_domain(conn)
        out = {}
        for domain, fn in (("personas", migrate_personas),
                           ("config", migrate_config),
                           ("memory", migrate_memory)):
            out[domain] = fn(conn, ws_dir, archive, node)
        return out
    finally:
        conn.close()
