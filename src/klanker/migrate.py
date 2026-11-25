"""klanker migrate --to-store: fold file domains into store.db datoms.

One-way, idempotent import (klanker#143 / frontier #19):
- personas/<id>/persona.json  -> persona:<id> entities
- config.json scalar settings -> cfg:<key> entities (key_env refs only —
  secret *values* never become datoms)
- memory/**/*.md, *.yaml, *.yml -> mem:<slug> entities (text redacted)

Identity: origin_actor="import@<host>:store", origin_seq=1..N per run,
monotonic across runs and assigned in deterministic (domain, relpath,
line) order — never mtime_ms, which collides under fast edits. A file
whose datoms are already current dedupes on content; a changed file
re-imports under the next seq and card-one LWW picks the newer tx.

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

from .msgsync import actor, local_node_id, next_seq
from .store_domains import MIGRATE_ATTRS, ensure_domains

log = logging.getLogger(__name__)

# Key names whose values must never enter the log -- only an env
# indirection may be recorded. Keys are split into word tokens
# (snake/kebab/dot/camelCase), so ``author``/``tokenizer``/``max_tokens``
# stay while ``api_key``/``accessToken``/``GITHUB_TOKEN`` are secret.
SECRET_TOKENS = frozenset({
    "token", "secret", "password", "passwd", "passphrase", "pwd",
    "credential", "credentials", "apikey", "privatekey", "bearer",
    "cookie", "cookies", "authorization", "sessionid", "dsn",
    "secrets", "passwords", "vault",
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
    # Telegram bot token: <digits>:AA<35 chars>
    re.compile(r"(?<!\w)\d{6,}:AA[A-Za-z0-9_-]{20,}\b"),
    # Slack + Discord incoming-webhook URLs (the tail is the credential)
    re.compile(r"https://hooks\.slack\.com/services"
               r"(?:/[A-Za-z0-9_-]+){1,4}"),
    re.compile(r"https://discord(?:app)?\.com/api/webhooks"
               r"(?:/[A-Za-z0-9_-]+){1,3}"),
]
# 32-char lowercase hex under a secret-named assignment
# (``secret_key = 'd3ad…'``, ``client_secret: 0123…``).
_HEX32_SECRET = re.compile(
    r"(?i)(?<![\w.])([A-Za-z0-9_.-]{0,40}secret[A-Za-z0-9_.-]{0,40}"
    r"[ \t]*[:=][ \t]*[\"']?)[0-9a-fA-F]{32}(?![0-9a-fA-F]*[\w-])")
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
            # strip an inline ` # comment` tail before the whitespace
            # check so `api_key: abc123 # prod` still redacts; quoted
            # values keep their inner # verbatim. A QUOTED value may
            # also carry a trailing comment — `api_key: "sec" # note`
            # must reduce to the quoted core or the whitespace test
            # waves it through (klanker#155).
            if raw[:1] in "\"'":
                q = raw[0]
                end = raw.find(q, 1)
                if end >= 1:
                    tail = raw[end + 1:].lstrip(" \t")
                    if not tail or tail.startswith("#"):
                        raw = raw[:end + 1]
            else:
                raw = re.sub(r"[ \t]+#.*$", "", raw).rstrip()
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
    text, n = _HEX32_SECRET.subn(lambda m: m.group(1) + REDACTED, text)
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
            if _is_secret_key(k):
                if isinstance(v, (dict, list)):
                    # a secret-named container gives up every string leaf —
                    # `{"secrets": {"db": "plain"}}` must not leak "plain"
                    # through a harmless-looking nested key
                    c, d = _redact_leaves(v)
                    dropped += d
                    if c is not _DROP:
                        clean[k] = c
                    continue
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


def _redact_leaves(v):
    """(clean, dropped): every string leaf of a container -> REDACTED.

    Structure is kept so the store copy still documents shape; non-string
    leaves (numbers, bools, null) are kept — they carry no credential.
    """
    if isinstance(v, dict):
        out, n = {}, 0
        for k, x in v.items():
            c, d = _redact_leaves(x)
            n += d
            if c is not _DROP:
                out[k] = c
        return out, n
    if isinstance(v, list):
        out, n = [], 0
        for x in v:
            c, d = _redact_leaves(x)
            n += d
            if c is not _DROP:
                out.append(c)
        return out, n
    if isinstance(v, str):
        return REDACTED, 1
    return v, 0


_DROP = object()


def ensure_migrate_domain(conn) -> None:
    ensure_domains(conn)


class _ImportTx:
    """One file/config-key's datoms — one deterministic tx unit."""
    __slots__ = ("domain", "relpath", "line", "datoms", "applied")

    def __init__(self, domain: str, relpath: str, line: str, datoms):
        self.domain = domain
        self.relpath = relpath
        self.line = line
        self.datoms = datoms
        self.applied = False


def _all_current(conn, datoms) -> bool:
    """Every asserted (e, a, v) already current -> a re-run is a no-op."""
    for e, a, v, added in datoms:
        if not added:
            return False
        row = conn.execute(
            "SELECT 1 FROM v_current WHERE e = ? AND a = ? AND v = ? LIMIT 1",
            (e, a, v)).fetchone()
        if row is None:
            return False
    return True


class _Importer:
    """Deterministic import sequencer.

    One actor ``import@<node>:store``; ``origin_seq`` continues past the
    store's high-water mark and is assigned in sorted (domain, relpath,
    line) order on ``flush`` — never mtime_ms, so two files edited in the
    same millisecond can never collide on ``ux_tx_origin``. Dedupe is
    content equality on ``v_current``: unchanged files produce no tx,
    changed files re-import under the next seq (LWW keeps the newer tx).

    ``ord`` comes from a node-qualified :class:`Hlc` seeded on the
    store's highest HLC ord (``HLC_GLOB``) — the old synthetic
    ``"…00000.import"`` ords collided across hosts and never carried a
    node suffix a peer could attribute (klanker#155).
    """

    def __init__(self, conn, node: str = ""):
        self.conn = conn
        self.node = node or local_node_id()
        self.origin = actor("import", self.node, "store")
        self.seq = next_seq(conn, self.origin)
        self.units: list[_ImportTx] = []
        self._clock = None

    def _ord(self) -> str:
        if self._clock is None:
            from agents_store.hlc import Hlc, HLC_GLOB
            from .msgsync import _node_part
            self._clock = Hlc(_node_part(self.node))
            row = self.conn.execute(
                "SELECT MAX(ord) FROM datom WHERE ord GLOB ?",
                (HLC_GLOB,)).fetchone()
            if row and row[0]:
                self._clock.observe(row[0])
        return self._clock.tick()

    def submit(self, domain: str, relpath: str, line, datoms) -> _ImportTx:
        u = _ImportTx(domain, relpath, str(line), datoms)
        self.units.append(u)
        return u

    def flush(self) -> None:
        for u in sorted(
                self.units, key=lambda u: (u.domain, u.relpath, u.line)):
            if _all_current(self.conn, u.datoms):
                u.applied = False
                continue
            res = ingest(
                self.conn, self.origin, self.seq,
                self._ord(), u.datoms)
            self.seq += 1
            u.applied = bool(res.applied)


def _archive(ws_dir: Path, src: Path) -> Path:
    """Move ``src`` under ``archive/pre-store/`` — never overwrites:
    collisions get ``.bak.<n>`` suffixes."""
    rel = src.relative_to(ws_dir)
    dst = ws_dir / "archive" / "pre-store" / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        n = 1
        while dst.with_name(dst.name + f".bak.{n}").exists():
            n += 1
        dst = dst.with_name(dst.name + f".bak.{n}")
    shutil.move(str(src), str(dst))
    return dst


def _settle(stats: dict, pending: list, archive: bool, ws_dir: Path) -> dict:
    """After ``_Importer.flush``: count applied/dupes and archive sources."""
    for u, src in pending:
        if u.applied:
            stats["imported"] += 1
        else:
            stats["dupes"] += 1
        if archive and src.is_file():
            _archive(ws_dir, src)
            stats["archived"] += 1
    return stats


def _migrate_personas(conn, ws_dir: Path, imp: _Importer):
    """Collect persona units. Returns (stats, pending)."""
    root = ws_dir / "personas"
    stats = {"imported": 0, "dupes": 0, "skipped_secret": 0, "archived": 0}
    pending = []
    if not root.is_dir():
        return stats, pending
    for manifest in sorted(root.glob("*/persona.json")):
        pid = manifest.parent.name
        try:
            doc = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(doc, dict):
            continue
        doc, refs, dropped = scrub_secrets(doc)
        stats["skipped_secret"] += dropped + len(refs)
        e = f"persona:{pid}"
        datoms = [(e, "persona:id", pid, True),
                  (e, "persona:json",
                   json.dumps(doc, sort_keys=True), True)]
        name = doc.get("name") or doc.get("label")
        if name:
            datoms.append((e, "persona:name", str(name), True))
        u = imp.submit("personas",
                       manifest.relative_to(ws_dir).as_posix(), pid, datoms)
        pending.append((u, manifest))
    return stats, pending


def migrate_personas(conn, ws_dir: Path, archive: bool,
                     node: str = "") -> dict:
    imp = _Importer(conn, node)
    stats, pending = _migrate_personas(conn, ws_dir, imp)
    imp.flush()
    return _settle(stats, pending, archive, ws_dir)


def _migrate_config(conn, ws_dir: Path, imp: _Importer):
    """Collect config units. Returns (stats, pending, cfg_path)."""
    cfg = ws_dir / "config.json"
    stats = {"imported": 0, "dupes": 0, "skipped_secret": 0, "archived": 0}
    pending = []
    if not cfg.is_file():
        return stats, pending, cfg
    try:
        doc = json.loads(cfg.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return stats, pending, cfg
    if not isinstance(doc, dict):
        return stats, pending, cfg
    clean, refs, dropped = scrub_secrets(doc)
    stats["skipped_secret"] += dropped + len(refs)
    # Only an env indirection may be recorded for a secret -- never a value.
    for path, env in refs:
        e = f"cfg:{path}"
        u = imp.submit("config", "config.json", f"env:{path}",
                       [(e, "cfg:key", path, True),
                        (e, "cfg:key_env", env, True)])
        pending.append((u, cfg))
    for key in sorted(clean):
        v = clean[key]
        if isinstance(v, (dict, list)):
            v = json.dumps(v, sort_keys=True)
        e = f"cfg:{key}"
        u = imp.submit("config", "config.json", key,
                       [(e, "cfg:key", key, True),
                        (e, "cfg:value", str(v), True)])
        pending.append((u, cfg))
    return stats, pending, cfg


def migrate_config(conn, ws_dir: Path, archive: bool,
                   node: str = "") -> dict:
    imp = _Importer(conn, node)
    stats, pending, cfg = _migrate_config(conn, ws_dir, imp)
    imp.flush()
    settled = _settle(stats, pending, False, ws_dir)
    if archive and pending and cfg.is_file():
        _archive(ws_dir, cfg)
        settled["archived"] += 1
    return settled


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


# Generated projection lives under memory/projection/ — one-way store.db
# -> files. It must never feed back through the importer (or through the
# bidirectional agents_store folder.sync adapter, which is deprecated for
# agents-memory trees exactly for this reason).
GENERATED_MARKER = "<!-- generated from store.db -->"
PROJECTION_DIR = "projection"


def _memory_files(root: Path):
    """memory/**/*.{md,yaml,yml}; symlinks, dot-dirs and the generated
    ``memory/projection/`` tree are skipped — projection files are outputs
    of the store, never import sources."""
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if rel.parts and rel.parts[0] == PROJECTION_DIR:
            continue
        if any(part.startswith(".") for part in rel.parts):
            continue
        if p.is_symlink() or not p.is_file():
            continue
        if p.suffix.lower() in MEMORY_SUFFIXES:
            yield p, rel


def _memory_unit(src: Path, rel: Path, stats: dict, node: str = ""):
    """(slug, datoms, redactions) for one memory file, or None."""
    try:
        text = src.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    if GENERATED_MARKER in text[:400]:
        return None  # generated projection, not a source
    # top-level notes keep their historic slug (stem); nested files
    # and YAML use the relative path so names never collide
    if len(rel.parts) == 1 and src.suffix.lower() == ".md":
        slug = src.stem
    elif src.suffix.lower() == ".md":
        slug = rel.with_suffix("").as_posix()
    else:
        slug = rel.as_posix()
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
    if node:
        # ownership marker: only the importing host may later retract
        # this entity when the file vanishes (klanker#155)
        datoms.append((e, "mem:host", node, True))
    if title:
        datoms.append((e, "mem:title", title, True))
    return slug, datoms


def _retract_missing_memory(conn, imp: _Importer, seen: set[str],
                            stats: dict) -> None:
    """Files deleted from this host's ``memory/`` retract their ``mem:*``
    datoms so the projection removes the note on every peer.

    Scoped to ``mem:host == <this node>`` — a mem entity another host
    imported must survive here even though the file never existed on
    this disk (memory syncs through the store, not the filesystem).
    Legacy entities without ``mem:host`` are never retracted.
    """
    cur: dict[str, dict] = {}
    for e, a, v in conn.execute(
            "SELECT e, a, v FROM v_current WHERE e LIKE 'mem:%'"):
        cur.setdefault(e, {})[a] = v
    for e in sorted(cur):
        d = cur[e]
        if str(d.get("mem:host") or "") != imp.node:
            continue
        rel = str(d.get("mem:file") or "")
        if rel and rel not in seen:
            datoms = [(e, a, v, False) for a, v in d.items()]
            imp.submit("memory", f"memory/{rel}", f"retract:{e}", datoms)
            stats["retracted"] += 1


def _migrate_memory(conn, ws_dir: Path, imp: _Importer,
                    max_bytes: int | None, warnings: list | None):
    """Collect memory units. Returns (stats, pending)."""
    root = ws_dir / "memory"
    stats = {"imported": 0, "dupes": 0, "archived": 0, "redacted": 0,
             "skipped_large": 0, "retracted": 0}
    pending = []
    limit = _memory_max_bytes(max_bytes)
    seen: set[str] = set()
    if root.is_dir():
        for src, rel in list(_memory_files(root)):
            seen.add(rel.as_posix())
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
            unit = _memory_unit(src, rel, stats, node=imp.node)
            if unit is None:
                continue
            slug, datoms = unit
            u = imp.submit("memory", f"memory/{rel.as_posix()}", slug,
                           datoms)
            pending.append((u, src))
    _retract_missing_memory(conn, imp, seen, stats)
    return stats, pending


def migrate_memory(conn, ws_dir: Path, archive: bool,
                   node: str = "", max_bytes: int | None = None,
                   warnings: list | None = None) -> dict:
    imp = _Importer(conn, node)
    stats, pending = _migrate_memory(conn, ws_dir, imp, max_bytes, warnings)
    imp.flush()
    return _settle(stats, pending, archive, ws_dir)


def project_memory(conn, ws_dir: Path, node: str = "") -> dict:
    """Fold live ``<ws>/memory`` writes into ``mem:*`` datoms.

    Incremental bridge leg (files -> store): unchanged files dedupe on
    content, new/edited files transact under the next import seq.
    The generated ``memory/projection/`` tree and marker files are never
    projected back — the store->files leg is one-way.
    """
    ensure_domains(conn)
    imp = _Importer(conn, node)
    stats, _pending = _migrate_memory(conn, Path(ws_dir), imp, None, None)
    imp.flush()
    out = {"projected": 0, "dupes": 0}
    for u in imp.units:
        out["projected" if u.applied else "dupes"] += 1
    stats.update(out)
    return stats


def render_memory_projection(conn, ws_dir: Path) -> dict:
    """store.db -> generated legacy markdown under ``memory/projection/``.

    Read-only w.r.t. store truth: writes only files, never datoms. Each
    file carries ``GENERATED_MARKER`` so importers and folder.sync never
    feed it back. Stale projections whose entity vanished are removed.
    """
    ws_dir = Path(ws_dir)
    out_dir = ws_dir / "memory" / PROJECTION_DIR
    rows: dict[str, dict] = {}
    for e, a, v in conn.execute(
            "SELECT e, a, v FROM v_current WHERE e LIKE 'mem:%'"):
        rows.setdefault(e, {})[a] = v
    stats = {"written": 0, "unchanged": 0, "removed": 0}
    keep: set[Path] = set()
    for e in sorted(rows):
        d = rows[e]
        rel = str(d.get("mem:file") or "").strip()
        if not rel:
            rel = e[len("mem:"):] + ".md"
        dst = (out_dir / rel).resolve()
        if not dst.is_relative_to(out_dir.resolve()):
            continue  # mem:file must never escape the projection dir
        body = (f"{GENERATED_MARKER}\n\n"
                f"{d.get('mem:text') or ''}\n")
        keep.add(dst)
        try:
            if dst.read_text(encoding="utf-8") == body:
                stats["unchanged"] += 1
                continue
        except OSError:
            pass
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(body, encoding="utf-8")
        stats["written"] += 1
    if out_dir.is_dir():
        for p in sorted(out_dir.rglob("*")):
            if p.is_file() and p.resolve() not in keep:
                p.unlink()
                stats["removed"] += 1
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
        imp = _Importer(conn, node)
        warnings: list[str] = []
        pstats, ppending = _migrate_personas(conn, ws_dir, imp)
        cstats, cpending, ccfg = _migrate_config(conn, ws_dir, imp)
        mstats, mpending = _migrate_memory(
            conn, ws_dir, imp, memory_max_bytes, warnings)
        imp.flush()
        out: dict = {}
        out["personas"] = _settle(pstats, ppending, archive, ws_dir)
        out["config"] = _settle(cstats, cpending, False, ws_dir)
        if archive and cpending and ccfg.is_file():
            _archive(ws_dir, ccfg)
            out["config"]["archived"] += 1
        out["memory"] = _settle(mstats, mpending, archive, ws_dir)
        # store -> files leg right after import: retracted mem:* entities
        # drop their generated projection file (klanker#155)
        out["projection"] = render_memory_projection(conn, ws_dir)
        out["warnings"] = warnings
        return out
    finally:
        conn.close()
