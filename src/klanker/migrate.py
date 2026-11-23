"""klanker migrate --to-store: fold file domains into store.db datoms.

One-way, idempotent import (klanker#143 / frontier #19):
- personas/<id>/persona.json  -> persona:<id> entities
- config.json scalar settings -> cfg:<key> entities (key_env refs only —
  secret *values* never become datoms)
- memory/**/*.md, *.yaml, *.yml -> mem:<slug> entities (text redacted)

Identity: origin_actor="import@<host>:<domain>:<id>", origin_seq=mtime_ms
— re-running with an unchanged file dedupes on ux_tx_origin; a changed
file re-imports and card-one LWW picks the newer mtime.

Secrets never become datoms: config and persona documents are scrubbed
recursively (secret-named keys at any depth, matched on word tokens;
credential-shaped values; credentials inside other strings redacted);
memory text (markdown and YAML) is redacted line by line and by value
pattern. Only env-indirection names (``"OPENAI_API_KEY"``) may be
recorded.

Only the store copy is scrubbed: the source files on disk keep any raw
tokens -- ``--archive`` moves the originals unchanged into the archive,
it does not redact them. Rotate or delete credentials found there.

Memory notes larger than ``memory_max_bytes`` (default 1 MiB, env
``KLANKER_MIGRATE_MEMORY_MAX_BYTES``) are skipped with a warning.

Sources stay in place by default -- the runtime still reads
personas/config/memory from files. ``archive=True`` (CLI ``--archive``)
moves them to <ws>/archive/pre-store/ after their tx commits.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
from pathlib import Path

from agents_store.db import connect
from agents_store.ingest import ingest

from .msgsync import actor, ensure_domain, local_node_id

log = logging.getLogger(__name__)

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
# indirection may be recorded. Keys are split into word tokens
# (snake/kebab/dot/camelCase), so ``author``/``tokenizer``/``max_tokens``
# stay while ``api_key``/``accessToken``/``GITHUB_TOKEN`` are secret.
SECRET_TOKENS = frozenset({
    "token", "secret", "password", "passwd", "passphrase", "pwd",
    "credential", "credentials", "apikey", "privatekey", "bearer",
    "cookie", "cookies", "authorization", "sessionid", "dsn",
})
# A trailing ``key``/``pass`` is secret (``openai_key``, ``db_pass``)
# unless the key names a non-secret kind of key.
_NON_SECRET_KEY_PREFIX = frozenset({
    "sort", "primary", "foreign", "partition", "cache", "lookup", "group",
    "hot", "short", "shortcut", "idempotency", "dedupe", "public", "pub",
    "hash", "index", "map", "row", "column", "registry", "storage", "model",
})
SECRET_KEY_EXACT = frozenset({"key", "pass", "auth"})
# An env-variable *name* (e.g. OPENAI_API_KEY) may stand in for a secret.
# Require an underscore so an all-caps literal password is not mistaken
# for an indirection and recorded.
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")
# A whole value that starts like a credential is dropped (any key).
_SECRET_VALUE = re.compile(
    r"^(?:sk-|sk_|rk_|pk_live_|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|"
    r"xox[abposr]-|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}|AIza|"
    r"eyJ[\w-]{8,}\.eyJ|Bearer\s|-----BEGIN [A-Z ]*PRIVATE KEY-----)")
# Credentials embedded anywhere in free text (memory notes, descriptions,
# YAML) are redacted in place.
REDACTED = "[REDACTED]"
_INLINE_SECRETS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?"
               r"(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)", re.S),
    re.compile(r"(?<![\w-])sk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?<!\w)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}"),
    re.compile(r"(?<!\w)gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"(?<!\w)github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"(?<![\w-])glpat-[A-Za-z0-9_-]{20,}"),
    re.compile(r"(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}"),
    re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])"),
    re.compile(r"(?<![\w-])AIza[0-9A-Za-z_-]{35}"),
    re.compile(r"(?<![\w-])eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+"),
    re.compile(r"(?i)(?<=\bbearer\s)[A-Za-z0-9._~+/=-]{12,}"),
]
# scheme://user:password@host -> keep user, redact the password
# bounded quantifiers + left boundary keep this linear on huge tokens
_URL_PASSWORD = re.compile(
    r"(?<![a-z0-9+.-])(?P<pre>[a-z][a-z0-9+.-]{0,31}://[^\s/:@]{1,256}:)"
    r"(?P<pw>[^\s/@]{1,256})@", re.I)
# ``key: value`` / ``key = value`` / ``export KEY=value`` assignments in
# text (markdown, YAML, env snippets) whose key is secret-named.
_ASSIGN = re.compile(
    r"^(?P<lead>[ \t]*(?:[-*][ \t]+)?(?:export[ \t]+)?[\"']?)"
    r"(?P<key>[A-Za-z_][\w.-]*)"
    r"(?P<sep>[\"']?[ \t]*[:=][ \t]*)"
    r"(?P<val>\S.*?)[ \t]*$", re.M)
# Candidate high-entropy tokens (API keys without a known prefix).
_TOKEN_CAND = re.compile(r"(?<![\w+=-])[A-Za-z0-9+_=-]{32,}(?![\w+=-])")


def _key_tokens(key: str) -> list[str]:
    k = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key))
    return [t for t in re.split(r"[^A-Za-z0-9]+", k.lower()) if t]


def _is_secret_key(key: str) -> bool:
    toks = _key_tokens(key)
    if not toks:
        return False
    if len(toks) == 1 and toks[0] in SECRET_KEY_EXACT:
        return True
    if any(t in SECRET_TOKENS for t in toks):
        return True
    for a, b in zip(toks, toks[1:]):
        if (a, b) in (("api", "key"), ("private", "key"), ("access", "key"),
                      ("secret", "key"), ("client", "secret"),
                      ("session", "id"), ("auth", "header")):
            return True
    if len(toks) >= 2 and toks[-1] in ("key", "pass") \
            and toks[-2] not in _NON_SECRET_KEY_PREFIX:
        return True
    return False


def _entropy(s: str) -> float:
    n = len(s)
    return -sum((c / n) * math.log2(c / n)
                for c in (s.count(ch) for ch in set(s)))


def _high_entropy(tok: str) -> bool:
    """Random-looking credential: mixed case + digits, high entropy.
    Hex digests and plain words/paths do not qualify."""
    core = tok.strip("=")
    if len(core) < 32:
        return False
    if not (re.search(r"[a-z]", core) and re.search(r"[A-Z]", core)
            and re.search(r"[0-9]", core)):
        return False
    return _entropy(core) >= 4.2


def _is_secret_value(v) -> bool:
    return isinstance(v, str) and bool(_SECRET_VALUE.match(v.strip()))


def _placeholder(val: str) -> bool:
    v = val.strip().strip("\"'")
    return (v in ("", "~", "null", "None", "|", ">", "|-", ">-", REDACTED)
            or v.startswith(("${", "$", "<", "{{"))
            or (len(v) <= 64 and bool(_ENV_NAME.match(v))))


def redact_text(text: str) -> tuple[str, int]:
    """Redact credentials inside free text. Returns (text, count).

    - secret-named assignments (``password: x``, ``API_KEY=x``,
      ``- token: "x"``); prose values with spaces are kept unless quoted,
      env-name/placeholder values are kept
    - YAML block scalars under a secret key (``private_key: |``)
    - known credential shapes anywhere (sk-, ghp_, xox*, AKIA, JWT,
      Bearer, private key blocks, url passwords) and high-entropy tokens
    """
    count = 0
    lines = text.split("\n")
    out_lines = []
    block_indent = None
    for line in lines:
        if block_indent is not None:
            ind = len(line) - len(line.lstrip(" \t"))
            if line.strip() == "" or ind > block_indent:
                if line.strip():
                    out_lines.append(line[:ind] + REDACTED)
                    count += 1
                else:
                    out_lines.append(line)
                continue
            block_indent = None
        m = _ASSIGN.match(line)
        if m and _is_secret_key(m.group("key")):
            val = m.group("val")
            raw = val.strip()
            if raw in ("|", ">", "|-", ">-", "|+", ">+"):
                block_indent = len(line) - len(line.lstrip(" \t"))
            elif not _placeholder(raw):
                quoted = raw[:1] in "\"'" and raw[-1:] == raw[:1] \
                    and len(raw) >= 2
                if quoted or not re.search(r"\s", raw):
                    q = raw[0] if quoted else ""
                    line = (m.group("lead") + m.group("key") + m.group("sep")
                            + q + REDACTED + q)
                    count += 1
        out_lines.append(line)
    text = "\n".join(out_lines)
    for rx in _INLINE_SECRETS:
        text, n = rx.subn(REDACTED, text)
        count += n

    def _url(m):
        nonlocal count
        if m.group("pw") == REDACTED or _placeholder(m.group("pw")):
            return m.group(0)
        count += 1
        return m.group("pre") + REDACTED + "@"

    text = _URL_PASSWORD.sub(_url, text)

    def _ent(m):
        nonlocal count
        if _high_entropy(m.group(0)):
            count += 1
            return REDACTED
        return m.group(0)

    text = _TOKEN_CAND.sub(_ent, text)
    return text, count


def scrub_secrets(obj, path: str = ""):
    """Return (clean, env_refs, dropped) for a JSON value.

    clean     -- copy with every secret removed (secret-named keys dropped
                 from dicts, credential-shaped items dropped from lists,
                 credentials inside other strings redacted in place)
    env_refs  -- [(dotted.path, ENV_NAME)] for secret-named keys whose
                 value is an env-variable name (safe to record)
    dropped   -- number of secret values removed or redacted
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
    if isinstance(obj, str):
        red, n = redact_text(obj)
        if n:
            if red.strip() == REDACTED:
                return _DROP, refs, 1
            return red, refs, n
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


MEMORY_SUFFIXES = (".md", ".yaml", ".yml")
MEMORY_MAX_BYTES = 1024 * 1024
MEMORY_MAX_ENV = "KLANKER_MIGRATE_MEMORY_MAX_BYTES"


def _memory_max_bytes(override: int | None = None) -> int:
    """Effective limit: override, else env, else 1 MiB. 0 = no limit;
    negative or non-integer values are an error, never "no limit"."""
    if override is not None:
        if isinstance(override, bool) or not isinstance(override, int) \
                or override < 0:
            raise ValueError(
                f"memory_max_bytes must be an integer >= 0: {override!r}")
        return override
    raw = os.environ.get(MEMORY_MAX_ENV, "").strip()
    if not raw:
        return MEMORY_MAX_BYTES
    try:
        val = int(raw)
    except ValueError:
        val = -1
    if val < 0:
        raise ValueError(
            f"{MEMORY_MAX_ENV} must be an integer >= 0: {raw!r}")
    return val


def _memory_files(root: Path):
    """memory/**/*.{md,yaml,yml}; symlinks and dot-dirs are skipped."""
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if p.is_symlink() or not p.is_file():
            continue
        if p.suffix.lower() in MEMORY_SUFFIXES:
            yield p, rel


def migrate_memory(conn, ws_dir: Path, archive: bool,
                   node: str = "", max_bytes: int | None = None,
                   warnings: list | None = None) -> dict:
    root = ws_dir / "memory"
    stats = {"imported": 0, "dupes": 0, "archived": 0, "redacted": 0,
             "skipped_large": 0}
    if not root.is_dir():
        return stats
    limit = _memory_max_bytes(max_bytes)
    for src, rel in list(_memory_files(root)):
        try:
            size = src.stat().st_size
        except OSError:
            continue
        if limit > 0 and size > limit:
            stats["skipped_large"] += 1
            msg = (f"memory/{rel.as_posix()}: {size} bytes > {limit},"
                   " skipped (not imported, not archived)")
            log.warning("migrate: %s", msg)
            if warnings is not None:
                warnings.append(msg)
            continue
        # top-level notes keep their historic slug (stem); nested files
        # and YAML use the relative path so names never collide
        if len(rel.parts) == 1 and src.suffix.lower() == ".md":
            slug = src.stem
        elif src.suffix.lower() == ".md":
            slug = rel.with_suffix("").as_posix()
        else:
            slug = rel.as_posix()
        try:
            text = src.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        mtime_ms = int(src.stat().st_mtime * 1000)
        text, n = redact_text(text)
        stats["redacted"] += n
        title = ""
        if src.suffix.lower() == ".md":
            for line in text.splitlines():
                if line.strip().startswith("#"):
                    title = line.strip().lstrip("#").strip()
                    break
        e = f"mem:{slug}"
        datoms = [(e, "mem:file", rel.as_posix(), True),
                  (e, "mem:text", text, True)]
        if title:
            datoms.append((e, "mem:title", title, True))
        if _import(conn, "memory", slug, mtime_ms, datoms, node):
            stats["imported"] += 1
        else:
            stats["dupes"] += 1
        if archive:
            _archive(ws_dir, src)
            stats["archived"] += 1
    return stats


def migrate_to_store(ws_dir: str | Path, *, archive: bool = False,
                     node: str = "",
                     memory_max_bytes: int | None = None) -> dict:
    """Import file domains into store.db. Sources are kept unless
    ``archive=True`` -- the runtime still reads the files."""
    ws_dir = Path(ws_dir)
    memory_max_bytes = _memory_max_bytes(memory_max_bytes)  # fail early
    node = node or local_node_id()
    conn = connect(ws_dir / "store.db")
    try:
        ensure_migrate_domain(conn)
        out: dict = {}
        warnings: list[str] = []
        out["personas"] = migrate_personas(conn, ws_dir, archive, node)
        out["config"] = migrate_config(conn, ws_dir, archive, node)
        out["memory"] = migrate_memory(conn, ws_dir, archive, node,
                                       memory_max_bytes, warnings)
        out["warnings"] = warnings
        return out
    finally:
        conn.close()
