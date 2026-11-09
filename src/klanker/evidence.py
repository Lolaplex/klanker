"""Evidence for absence, date coverage, and unbacked side effects.

Routine replies used to exist only in the outbound message. A later turn
that searched memory could treat that miss as proof nothing was produced.
Finished runs are recorded under the routine-runs directory. This module
lists those files, the workspace, and schedule jobs by day, and reviews a
draft reply against what was actually retrieved and which tools succeeded.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import sys
import tempfile
from collections.abc import Iterator, Mapping
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from agents_workspace import Workspace

_MAX_RANGE_DAYS = 366
_MAX_FILES = 2000
_MAX_READ_BYTES = 1_000_000
# A daily run for a quarter stays. The count cap stops a tight loop filling the disk.
DEFAULT_KEEP_DAYS = 90
DEFAULT_KEEP_COUNT = 2000
_SKIP_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
    }
)
_SUFFIXES = frozenset({".md", ".txt", ".log", ".jsonl"})
_REQUIRED_SOURCES = ("memory", "traces", "routine_runs", "workspace")

_DATE_SPAN = re.compile(r"20\d{2}-\d{2}-\d{2}")
_INT = re.compile(r"\d+")
_TRUNCATION = re.compile(
    r"\[truncated\]|\btruncat\w*\b|\bomitted\b|\bclipped\b|\(\.\.\.\)|\.\.\.|…",
    re.IGNORECASE,
)
_ASK = re.compile(
    r"\b("
    r"may i|can i|shall i|should i|"
    r"do you want me to|would you like me to|"
    r"if you(?:'d| would) like|"
    r"need(?: your)? permission|ask(?:ing)? (?:for )?permission|"
    r"with your permission|let me know if i should"
    r")\b",
    re.IGNORECASE,
)
_ASK_NEGATED = re.compile(
    r"\b(?:do not|don't|never) ask permission\b",
    re.IGNORECASE,
)
_READ_ACT = re.compile(
    r"\b(read(?:-only)?|list|search|inspect|look|cat|ls|rg|grep|terminal|files?|investigation)\b",
    re.IGNORECASE,
)
_MUTATE_ACT = re.compile(
    r"\b(delete|remove|write|send|install|overwrite|drop|kill|restart|reboot)\b",
    re.IGNORECASE,
)
_GLOBAL_ABSENCE = re.compile(
    r"\b("
    r"does not exist|doesn't exist|did not exist|do not exist|"
    r"there (?:were|are|was) no\b|"
    r"nothing (?:exists|happened|was (?:scheduled|produced))|"
    r"no (?:briefings|outputs|runs|files) (?:exist|that day|for those|in that range)"
    r")\b",
    re.IGNORECASE,
)
_GAP_STATEMENT = re.compile(
    r"\b(missing|not retrieved|could not (?:read|retrieve)|cannot (?:read|retrieve)|"
    r"no tool (?:can|could)|unavailable)\b",
    re.IGNORECASE,
)
_MEMORY_CLAIM = re.compile(
    r"\b(?:saved|wrote|written|persisted|stored|remembered)\b"
    r"(?:\W+(?!memory\b)\w+){0,10}\W+\bmemory\b",
    re.IGNORECASE,
)
_FILE_SAVE = re.compile(
    r"\b(?:saved|wrote|written|persisted) (?:the |a |this |that )?(?:file|note|summary)\b",
    re.IGNORECASE,
)
_SCHEDULE_CLAIM = re.compile(
    r"\b(?:i(?:'ve| have)? )(?:scheduled|set) (?:a |the )?(?:reminder|routine|schedule)\b"
    r"|\b(?:reminder|routine) is (?:set|scheduled)\b",
    re.IGNORECASE,
)
_SEND_CLAIM = re.compile(
    r"\b(?:i(?:'ve| have)? )(?:sent|delivered) (?:the |a |your )?(?:message|reply|note|text)\b",
    re.IGNORECASE,
)
_META = re.compile(
    r"\b(memory|traces?|workspace|routines?|gaps?|checked|search(?:ed)?|"
    r"listed|read|missing|truncat\w*|sources?|index|records?|hits?|miss(?:es)?|"
    r"existence|incomplete|capped|undated|directory|scanned|permission|schedules?)\b",
    re.IGNORECASE,
)
_ASSERT = re.compile(r"\b(no|not|none|never|without)\b|\d", re.IGNORECASE)
_COVERAGE_LINE = re.compile(
    r"^(?:memory|traces|routine_runs|workspace|schedules|root:\S+)\s*:"
    r"|^\d{4}-\d{2}-\d{2}\s*:",
    re.IGNORECASE,
)
_CLAIM_WORD = re.compile(r"\b(critical|reboot|required)\b", re.IGNORECASE)
_EPISTEMIC = re.compile(
    r"\b(mention(?:s|ed)?|says?|said|states?|includes?|contains?|shows?|lists?|sees?|seen|reads?|according|quotes?)\b",
    re.IGNORECASE,
)
_EFFECT_VERB = (
    r"saved|wrote|written|persisted|stored|remembered|scheduled|sent|delivered"
)
_NEGATED_EFFECT = re.compile(
    rf"\b(?:not|never|nothing|nichts|nicht|nie|kein(?:e|en|er|em)?)\b"
    rf"(?:\W+(?!{_EFFECT_VERB}\b)\w+){{0,6}}"
    rf"\W+\b(?:{_EFFECT_VERB})\b"
    rf"|\b(?:{_EFFECT_VERB})\b"
    rf"(?:\W+\w+){{0,4}}\W+\b(?:nothing|nichts)\b",
    re.IGNORECASE,
)
_PROCESS = re.compile(
    r"\b(i |i'll |i will |checked|searched|listed|read|found|cannot|can't|could not)\b",
    re.IGNORECASE,
)
_STOP = frozenset(
    {
        "that",
        "this",
        "with",
        "from",
        "have",
        "been",
        "were",
        "your",
        "about",
        "into",
        "them",
        "they",
        "their",
        "there",
        "then",
        "than",
        "only",
        "also",
        "just",
        "some",
        "such",
        "when",
        "what",
        "which",
        "where",
        "while",
        "after",
        "before",
        "each",
        "every",
        "other",
        "summary",
    }
)


class Artifact:
    """One file or index row the agent can read."""

    __slots__ = ("source", "path", "day", "status")

    def __init__(self, source: str, path: str, day: date | None, status: str = "") -> None:
        self.source = source
        self.path = path
        self.day = day
        self.status = status

    def as_dict(self) -> dict[str, str]:
        return {
            "source": self.source,
            "path": self.path,
            "status": self.status,
            "day": self.day.isoformat() if self.day else "",
        }


def agents_home() -> Path:
    return Workspace.from_env().root


def routine_runs_path() -> Path:
    """Directory of recorded routine replies. Does not create it."""
    return Workspace.from_env().routine_runs


def routine_runs_dir() -> Path:
    path = routine_runs_path()
    path.mkdir(parents=True, exist_ok=True)
    return path


def workspace_path() -> Path:
    raw = os.environ.get("AGENTS_WORKSPACE_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return agents_home() / "workspace"


def evidence_policy_lines() -> list[str]:
    """Prompt section. Paths match the directories this process actually uses."""
    runs = routine_runs_path().as_posix()
    work = workspace_path().as_posix()
    from .routine import schedules_path

    sched = schedules_path().as_posix()
    keep_days, keep_count = keep_limits()
    if keep_days:
        retention = f"older than {keep_days} days, and past the newest {keep_count} runs,"
    else:
        retention = f"past the newest {keep_count} runs"
    return [
        "",
        "5. Evidence before absence:",
        "   - Before you say something is missing, did not happen, or does not exist, check every source below that this host actually exposes. Name each source you checked and the result. 'No hit in <source>' is not 'does not exist'.",
        "   - Memory (`mcp.memory.search`, `mcp.memory.read`) covers only the indexed memory tree. An empty search is a miss in memory. Files outside that tree are invisible to it.",
        "   - Traces (`mcp.traces.sessions`, `mcp.traces.inspect`) include session `routine:<name>` and the chat session. Use them for past turns.",
        f"   - Routine outputs: `{runs}` (`index.jsonl` plus one markdown file per finished run, including status no_update). These files are not memory hits unless you added them. Retention removes runs {retention} (`AGENTS_ROUTINE_RUNS_KEEP_DAYS`, `AGENTS_ROUTINE_RUNS_KEEP_COUNT`). A day removed that way is 'no record', not 'does not exist'. `klanker evidence --from YYYY-MM-DD --to YYYY-MM-DD` lists them with workspace files, per day. That command does not search memory or traces.",
        f"   - Workspace: `{work}`. List it. Read dated and undated files before calling a day empty. A date mentioned inside a file is not a record for that day unless the file itself is that day's output.",
        f"   - Schedules: `{sched}` shows configured jobs. A job file is not proof that a day ran.",
        "   - Date range: cover every calendar day from the first day through the last day, inclusive. Report each day as a record (path or session) or as a gap. A gap means no record in the sources you checked.",
        "   - Do not ask permission for a read-only investigation. Read-only terminal verbs are `mcp.terminal.list`, `mcp.terminal.read`, `mcp.terminal.grep`, and `mcp.terminal.stat` (declared side_effects read-only). Use them for workspace files. Do not ask, and do not use `mcp.terminal.run` for a read those verbs already cover. `mcp.terminal.run` is mutating. Ask only when a mutating tool needs an approval this host actually requires.",
        "   - File edits: change an existing file with `mcp.terminal.edit` (exact `old` to `new`), create a new file with `mcp.terminal.write`. Both are mutating. Do not use `mcp.terminal.run` for a file edit. They need an approval only when this host sets AGENTS_APPROVAL_MODE to ask or strict; unset mode is ungated.",
        "   - If a tool result or earlier turn is truncated, omitted, clipped, or carries a `<ref digest=\"...\"/>`, call `read_content` with that digest, offset, and limit before you summarize. Page with offset plus the length of the returned text. If `read_content` says the content is unavailable, name the missing span. Do not invent it. Facts, counts, and statuses that are not in the retrieved text must not appear in the reply.",
        "   - Claim a side effect (saved, written, sent, scheduled, remembered) only when this turn has a successful tool receipt (`agents_harness.tool_receipt.v1`, success true) for that action (`mcp.memory.add`, `mcp.memory.write`, `mcp.schedule.add`, a real write, or a send). A memory save also needs a nested `agents_memory.write_receipt.v1`. A sentence that says you saved something is not a save.",
    ]


def iter_days(start: date, end: date) -> list[date]:
    if end < start:
        raise ValueError("end is before start")
    count = (end - start).days + 1
    if count > _MAX_RANGE_DAYS:
        raise ValueError(f"range is longer than {_MAX_RANGE_DAYS} days")
    return [start + timedelta(days=offset) for offset in range(count)]


def parse_day(value: str) -> date | None:
    match = _DATE_SPAN.search(value or "")
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(0))
    except ValueError:
        return None


def _front_matter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end < 0:
        return {}
    found: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        found[key.strip().lower()] = raw.strip()
    return found


def _day_from_text(text: str) -> date | None:
    meta = _front_matter(text)
    if meta.get("day"):
        found = parse_day(meta["day"])
        if found:
            return found
    if meta.get("minute"):
        found = parse_day(meta["minute"])
        if found:
            return found
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if not stripped:
            continue
        if _DATE_SPAN.fullmatch(stripped):
            return parse_day(stripped)
        break
    return None


def _norm(path: str | Path) -> str:
    try:
        return str(Path(path).expanduser().resolve())
    except OSError:
        return str(path)


def _from_index(path: Path, source: str) -> list[Artifact]:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    rows: list[Artifact] = []
    for line in raw.splitlines():
        body = line.strip()
        if not body:
            continue
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        day = parse_day(str(data.get("day") or data.get("minute") or ""))
        target = str(data.get("path") or "").strip()
        if not target:
            continue
        rows.append(Artifact(source, _norm(target), day, str(data.get("status") or "")))
    return rows


def _from_file(path: Path, source: str) -> list[Artifact]:
    if path.name == "index.jsonl":
        return _from_index(path, source)
    try:
        size = path.stat().st_size
    except OSError:
        return [Artifact(source, _norm(path), parse_day(path.name), "")]
    if size > _MAX_READ_BYTES:
        return [Artifact(source, _norm(path), parse_day(str(path)), "too_large")]
    if path.suffix.lower() == ".jsonl":
        rows = _from_index(path, source)
        if rows:
            return rows
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return [Artifact(source, _norm(path), parse_day(str(path)), "")]
    day = _day_from_text(text) or parse_day(str(path))
    status = _front_matter(text).get("status", "")
    return [Artifact(source, _norm(path), day, status)]


def _dedupe(items: list[Artifact]) -> list[Artifact]:
    best: dict[str, Artifact] = {}
    for item in items:
        current = best.get(item.path)
        if current is None:
            best[item.path] = item
            continue
        best[item.path] = Artifact(
            item.source or current.source,
            item.path,
            item.day or current.day,
            item.status or current.status,
        )
    return list(best.values())


def enumerate_tree(
    root: Path,
    *,
    source: str,
    max_files: int = _MAX_FILES,
) -> tuple[list[Artifact], bool]:
    """Return artifacts under ``root`` and whether the file cap was hit.

    Dates come from the path, front matter, or a first heading that is only
    a date. A date mentioned in the body does not assign the file to that day.
    """
    if not root.is_dir():
        return [], False
    found: list[Artifact] = []
    seen = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in _SKIP_DIRS and not name.startswith("."))
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            path = Path(dirpath) / name
            if name != "index.jsonl" and path.suffix.lower() not in _SUFFIXES:
                continue
            seen += 1
            if seen > max_files:
                return _dedupe(found), True
            found.extend(_from_file(path, source))
    return _dedupe(found), False


def schedule_note(root: Path) -> str:
    """Configured routines are not per-day output."""
    if not root.exists():
        return "directory absent"
    if not root.is_dir():
        return "not a directory"
    count = 0
    for path in sorted(root.glob("*.json")):
        if path.name.startswith("."):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("kind") == "routine":
            count += 1
    if count == 0:
        return "no hit"
    return f"{count} configured routine(s)"


def default_roots() -> list[tuple[str, Path]]:
    from .routine import schedules_path

    return [
        ("routine_runs", routine_runs_path()),
        ("workspace", workspace_path()),
        ("schedules", schedules_path()),
    ]


def _source_result(found: list[Artifact], *, capped: bool, max_files: int) -> str:
    if capped:
        return f"scan capped at {max_files}"
    if not found:
        return "no hit"
    return f"{len(found)} record(s)"


def investigate(
    start: date,
    end: date,
    *,
    roots: list[tuple[str, Path]] | None = None,
    tool_results: Mapping[str, str] | None = None,
    max_files: int = _MAX_FILES,
    include_defaults: bool = False,
) -> dict[str, Any]:
    """Per-day report. A tool miss is stored as given and is not absence."""
    scan_roots: list[tuple[str, Path]] = []
    if include_defaults:
        scan_roots.extend(default_roots())
    if roots:
        scan_roots.extend(roots)
    provided = dict(tool_results or {})
    checked: dict[str, str] = {
        "memory": str(provided.get("memory", "not scanned")),
        "traces": str(provided.get("traces", "not scanned")),
    }
    artifacts: list[Artifact] = []
    scan_capped = False
    for name, path in scan_roots:
        if name == "schedules":
            checked["schedules"] = schedule_note(path)
            continue
        if not path.exists():
            checked[name] = "directory absent"
            continue
        if not path.is_dir():
            checked[name] = "not a directory"
            continue
        found, capped = enumerate_tree(path, source=name, max_files=max_files)
        scan_capped = scan_capped or capped
        artifacts.extend(found)
        file_result = _source_result(found, capped=capped, max_files=max_files)
        tool = provided.get(name)
        if tool and found and tool.startswith("no hit"):
            checked[name] = f"search said no hit; {len(found)} file(s) on disk"
        elif tool and not found:
            checked[name] = tool
        else:
            checked[name] = file_result
    days = _coverage(start, end, artifacts)
    gaps = [row["day"] for row in days if row["gap"]]
    undated = [item.as_dict() for item in artifacts if item.day is None]
    report: dict[str, Any] = {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "checked": checked,
        "days": days,
        "gaps": gaps,
        "undated": undated,
        "scan_capped": scan_capped,
    }
    report["statement"] = _statement(report)
    return report


def _coverage(start: date, end: date, artifacts: list[Artifact]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    by_day: dict[date, list[Artifact]] = {day: [] for day in iter_days(start, end)}
    for item in artifacts:
        if item.day in by_day:
            by_day[item.day].append(item)
    for day, items in by_day.items():
        rows.append(
            {
                "day": day.isoformat(),
                "gap": not items,
                "records": [
                    {"source": item.source, "path": item.path, "status": item.status}
                    for item in items
                ],
            }
        )
    return rows


def _statement(report: Mapping[str, Any]) -> str:
    lines = [f"{name}: {result}" for name, result in report["checked"].items()]
    if report.get("scan_capped"):
        lines.append("Incomplete scan. A capped listing cannot support an absence claim.")
    values = [str(value) for value in report["checked"].values()]
    if any("not scanned" in value or "not checked" in value for value in values):
        lines.append("Unchecked sources remain. A miss is not non-existence.")
    else:
        lines.append("Results above are hits or misses per source. A miss is not non-existence.")
    undated = report.get("undated") or []
    if undated:
        lines.append(
            f"{len(undated)} undated record(s). Read them before treating a gap as empty."
        )
    gaps = report.get("gaps") or []
    if gaps:
        lines.append("Gaps: " + ", ".join(str(day) for day in gaps))
    return "\n".join(lines)


def render_report(report: Mapping[str, Any]) -> str:
    lines = ["Checked sources:"]
    for name, result in report["checked"].items():
        lines.append(f"{name}: {result}")
    lines.append("")
    for row in report["days"]:
        if row["gap"]:
            lines.append(f"{row['day']}: gap (no record in the sources checked)")
            continue
        bits: list[str] = []
        for rec in row["records"]:
            status = f" status={rec['status']}" if rec.get("status") else ""
            bits.append(f"{rec['source']} {rec['path']}{status}")
        lines.append(f"{row['day']}: " + "; ".join(bits))
    undated = report.get("undated") or []
    if undated:
        lines.append("")
        lines.append("Undated records (read before treating a gap as empty):")
        for rec in undated:
            lines.append(f"- {rec['source']} {rec['path']}")
    lines.append("")
    lines.append(str(report.get("statement") or ""))
    return "\n".join(lines).rstrip() + "\n"


def keep_limits() -> tuple[int, int]:
    """Return ``(keep_days, keep_count)``.

    ``AGENTS_ROUTINE_RUNS_KEEP_DAYS=0`` turns off the age limit. The count
    stays at least 1. Unparseable values fall back to the defaults.
    """
    days = _env_int("AGENTS_ROUTINE_RUNS_KEEP_DAYS", DEFAULT_KEEP_DAYS)
    count = _env_int("AGENTS_ROUTINE_RUNS_KEEP_COUNT", DEFAULT_KEEP_COUNT)
    if days < 0:
        days = DEFAULT_KEEP_DAYS
    if count < 1:
        count = DEFAULT_KEEP_COUNT
    return days, count


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _atomic_write(path: Path, text: str) -> None:
    """Write ``path`` via a temp file and ``os.replace``.

    Readers see the previous file or the complete new file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    try:
        dir_fd = os.open(path.parent, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        return
    finally:
        os.close(dir_fd)


def _under(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return True


@contextlib.contextmanager
def _index_lock(root: Path) -> Iterator[None]:
    root.mkdir(parents=True, exist_ok=True)
    handle = open(root / ".index.lock", "a+b")
    from .routine import _lock_ex, _unlock

    try:
        _lock_ex(handle)
        yield
    finally:
        _unlock(handle)
        handle.close()


def _load_index(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    rows: list[dict[str, str]] = []
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    for line in raw.splitlines():
        body = line.strip()
        if not body:
            continue
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and str(data.get("path") or "").strip():
            rows.append({key: str(value) for key, value in data.items() if value is not None})
    return rows


def _row_from_file(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    meta = _front_matter(text)
    return {
        "routine": path.parent.name,
        "session": meta.get("session", ""),
        "minute": meta.get("minute", ""),
        "day": meta.get("day", ""),
        "status": meta.get("status", ""),
        "path": str(path.resolve()),
        "channel": meta.get("channel", ""),
    }


def prune_routine_runs(root: Path, *, today: date | None = None, extra: Mapping[str, str] | None = None) -> None:
    """Drop runs outside the retention window and rewrite ``index.jsonl``."""
    keep_days, keep_count = keep_limits()
    current = today or date.today()
    rows = _load_index(root / "index.jsonl")
    if extra and extra.get("path"):
        rows.append({key: str(value) for key, value in extra.items()})
    known: set[str] = set()
    for row in rows:
        try:
            known.add(str(Path(row["path"]).resolve()))
        except OSError:
            continue
    if root.is_dir():
        for path in sorted(root.glob("*/*.md")):
            if not path.is_file() or not _under(root, path):
                continue
            resolved = str(path.resolve())
            if resolved not in known:
                rows.append(_row_from_file(path))
    deduped: dict[str, dict[str, str]] = {}
    order: list[str] = []
    for row in rows:
        try:
            key = str(Path(row["path"]).resolve())
        except OSError:
            continue
        if not _under(root, Path(key)):
            continue
        stored = dict(row)
        stored["path"] = key
        if key in deduped:
            order.remove(key)
        order.append(key)
        deduped[key] = stored
    kept_keys: list[str] = []
    for key in order:
        day = parse_day(deduped[key].get("day") or deduped[key].get("minute") or "")
        if keep_days and day is not None and (current - day).days > keep_days:
            continue
        kept_keys.append(key)
    if len(kept_keys) > keep_count:
        ranked = sorted(kept_keys, key=lambda key: (deduped[key].get("day") or "", deduped[key].get("minute") or "", key))
        drop = set(ranked[: len(kept_keys) - keep_count])
        kept_keys = [key for key in kept_keys if key not in drop]
    kept = [deduped[key] for key in kept_keys]
    keep_paths = {row["path"] for row in kept}
    text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in kept)
    _atomic_write(root / "index.jsonl", text)
    if root.is_dir():
        for path in list(root.glob("*/*.md")):
            if path.is_file() and _under(root, path) and str(path.resolve()) not in keep_paths:
                path.unlink(missing_ok=True)
        for child in list(root.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            try:
                next(child.iterdir())
            except StopIteration:
                child.rmdir()
            except OSError:
                continue


def record_routine_run(
    job: Mapping[str, Any],
    *,
    minute: str,
    status: str,
    reply: str,
) -> dict[str, str]:
    """Write one finished run where a later turn can find it.

    The markdown file and ``index.jsonl`` are replaced atomically. Retention
    then drops runs outside ``keep_limits``.
    """
    from .routine import resolve_channel, slugify

    raw_name = str(job.get("name") or "routine").strip() or "routine"
    try:
        slug = slugify(raw_name)
    except ValueError:
        slug = "routine"
    session = str(job.get("session") or f"routine:{slug}")
    channel = resolve_channel(str(job.get("channel") or ""))
    day = minute[:10] if parse_day(minute) else ""
    safe_minute = re.sub(r"[^0-9A-Za-zT._+-]", "-", minute).strip("-") or "run"
    root = routine_runs_dir()
    folder = root / slug
    folder.mkdir(parents=True, exist_ok=True)
    path = (folder / f"{safe_minute}.md").resolve()
    header = (
        "---\n"
        f"routine: {slug}\n"
        f"session: {session}\n"
        f"minute: {minute}\n"
        f"day: {day}\n"
        f"status: {status}\n"
        f"channel: {channel}\n"
        "---\n\n"
    )
    row = {
        "routine": slug,
        "session": session,
        "minute": minute,
        "day": day,
        "status": status,
        "path": str(path),
        "channel": channel,
    }
    with _index_lock(root):
        _atomic_write(path, header + (reply or ""))
        prune_routine_runs(root, extra=row)
    if not path.is_file():
        row["path"] = ""
    return row


def read_source(path: Path) -> tuple[str, str | None]:
    """Return ``(text, gap)``. ``gap`` is set when the file cannot be read.

    The gap names the path. It does not invent file contents.
    """
    try:
        if path.stat().st_size > _MAX_READ_BYTES:
            return "", f"missing: {path} (larger than {_MAX_READ_BYTES} bytes; not read)"
        return path.read_text(encoding="utf-8"), None
    except FileNotFoundError:
        return "", f"missing: {path} (not readable)"
    except OSError as exc:
        detail = exc.strerror or exc.__class__.__name__
        return "", f"missing: {path} ({detail})"


def _prefix_before_truncation(snippet: str) -> str:
    matches = list(_TRUNCATION.finditer(snippet or ""))
    if not matches:
        return ""
    # The cut is the last marker. A label such as "output clipped:" can precede the excerpt.
    before = snippet[: matches[-1].start()]
    lines = []
    for line in before.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.endswith(":"):
            continue
        lines.append(stripped)
    if not lines:
        return ""
    tail = re.sub(r"(\.\.\.|…)\s*$", "", lines[-1]).strip()
    if len(tail) < 8:
        return ""
    return tail


def recover_truncated(snippet: str, roots: list[Path]) -> tuple[str, str | None]:
    """Read the one file that contains the untruncated prefix.

    Zero matches or several matches produce a gap string and no invented body.
    """
    prefix = _prefix_before_truncation(snippet)
    if not prefix:
        return "", "missing: truncated text has no readable prefix and names no path"
    matches: list[str] = []
    for root in roots:
        found, _capped = enumerate_tree(root, source="scan")
        seen: set[str] = set()
        for item in found:
            if item.path in seen:
                continue
            seen.add(item.path)
            try:
                size = Path(item.path).stat().st_size
            except OSError:
                continue
            if size > _MAX_READ_BYTES:
                continue
            try:
                text = Path(item.path).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if prefix in text:
                matches.append(text)
    if len(matches) == 1:
        return matches[0], None
    if not matches:
        return "", f"missing: no file under the scanned roots contains the prefix {prefix!r}"
    return "", f"missing: {len(matches)} files contain the prefix {prefix!r}; not choosing one"


def _sentences(text: str) -> list[str]:
    parts = re.split(r"\n+|(?<=[.!?])\s+", (text or "").strip())
    return [part.strip() for part in parts if part.strip()]


def claims_global_absence(text: str) -> bool:
    return bool(_GLOBAL_ABSENCE.search(text or ""))


def asks_permission_for_read(text: str) -> bool:
    for sentence in _sentences(text):
        if _ASK_NEGATED.search(sentence):
            continue
        if _ASK.search(sentence) and _READ_ACT.search(sentence) and not _MUTATE_ACT.search(sentence):
            return True
    return False


def admits_truncation(text: str) -> bool:
    return bool(_TRUNCATION.search(text or ""))


def _succeeded(call: Mapping[str, Any]) -> bool:
    if call.get("ok") is False or call.get("success") is False:
        return False
    status = str(call.get("status") or "").lower()
    if status in {"error", "failed", "denied"}:
        return False
    return True


def _call_blob(call: Mapping[str, Any]) -> str:
    parts = [
        str(call.get("name") or ""),
        str(call.get("tool") or ""),
        str(call.get("command") or ""),
    ]
    args = call.get("arguments") if "arguments" in call else call.get("args")
    if args is not None:
        try:
            parts.append(json.dumps(args, default=str, ensure_ascii=False))
        except TypeError:
            parts.append(str(args))
    return " ".join(parts).lower()


def _command(call: Mapping[str, Any]) -> str:
    if call.get("command"):
        return str(call["command"])
    args = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
    if not args and isinstance(call.get("args"), dict):
        args = call["args"]
    if isinstance(args, dict):
        return str(args.get("command") or args.get("cmd") or "")
    return ""


def _has_memory_write(calls: list[Mapping[str, Any]]) -> bool:
    for call in calls:
        if not _succeeded(call):
            continue
        blob = _call_blob(call)
        if "agents_memory.write_receipt.v1" in blob:
            return True
        if "mcp.memory.add" in blob or "mcp.memory.write" in blob:
            return True
        if re.search(r"agents_memory\s+(add|write)\b", blob):
            return True
    return False


def _has_file_write(calls: list[Mapping[str, Any]]) -> bool:
    if _has_memory_write(calls):
        return True
    for call in calls:
        if not _succeeded(call):
            continue
        if _terminal_file_write(call):
            return True
        command = _command(call)
        if re.search(r"\btee\b", command):
            return True
        if re.search(r"(?<![0-9&])>>?(?![>&])", command):
            return True
    return False


def _terminal_file_write(call: Mapping[str, Any]) -> bool:
    """True for a successful ``mcp.terminal.write`` or ``mcp.terminal.edit`` call."""
    name = str(call.get("name") or call.get("tool") or "").lower()
    if name in {"mcp.terminal.write", "mcp.terminal.edit"}:
        return True
    args = call.get("arguments")
    if not isinstance(args, dict):
        args = call.get("args")
    if not isinstance(args, dict):
        return False
    if str(args.get("name") or "").lower() != "mcp.terminal":
        return False
    inner = args.get("arguments")
    if not isinstance(inner, dict):
        return False
    verb = str(inner.get("command_name") or inner.get("command") or "").lower()
    return verb in {"write", "edit"}


def _has_schedule(calls: list[Mapping[str, Any]]) -> bool:
    return any(_succeeded(call) and "mcp.schedule.add" in _call_blob(call) for call in calls)


def _has_send(calls: list[Mapping[str, Any]]) -> bool:
    for call in calls:
        if not _succeeded(call):
            continue
        blob = _call_blob(call)
        if "send" in blob and ("relay" in blob or "telegram" in blob):
            return True
    return False


def is_full_read(call: Mapping[str, Any]) -> bool:
    """True when the call retrieved a whole source, not a preview."""
    if not _succeeded(call):
        return False
    blob = _call_blob(call)
    name = str(call.get("name") or call.get("tool") or "").lower()
    if name in {"mcp.memory.read", "mcp.traces.inspect", "read_content", "mcp.terminal.read"}:
        return True
    if "mcp.memory.read" in blob or "mcp.traces.inspect" in blob or "read_content" in blob or "mcp.terminal.read" in blob:
        return True
    command = _command(call)
    if not re.search(r"(?:^|[;&|]\s*)(?:cat|type)\s+\S+", command):
        return False
    if re.search(r"\b(head|tail|sed|less|more)\b", command):
        return False
    if re.search(r"\b(rm|mv|tee|dd)\b|[>]", command):
        return False
    return True


def flag_unbacked_side_effects(
    text: str,
    tool_calls: list[Mapping[str, Any]] | None,
) -> list[str]:
    """Flag save, send, and schedule claims with no successful tool call."""
    calls = list(tool_calls or [])
    issues: list[str] = []
    for sentence in _sentences(text):
        if _NEGATED_EFFECT.search(sentence):
            continue
        if _MEMORY_CLAIM.search(sentence):
            if not _has_memory_write(calls):
                issues.append(
                    "memory write claimed without a successful agents_memory.write_receipt.v1 or mcp.memory.add in this turn"
                )
        elif _FILE_SAVE.search(sentence):
            if not _has_file_write(calls):
                issues.append("file save claimed without a successful write in this turn")
        if _SCHEDULE_CLAIM.search(sentence) and not _has_schedule(calls):
            issues.append("schedule claimed without a successful mcp.schedule.add in this turn")
        if _SEND_CLAIM.search(sentence) and not _has_send(calls):
            issues.append("send claimed without a successful send in this turn")
    return list(dict.fromkeys(issues))


def _integers_outside_dates(text: str) -> list[str]:
    masked = _DATE_SPAN.sub(" ", text or "")
    return _INT.findall(masked)


def unsupported_facts(reply: str, evidence: str) -> list[str]:
    """Numbers and negated claims that do not appear in retrieved text."""
    issues: list[str] = []
    seen: set[str] = set()
    for sentence in _sentences(reply):
        if _META.search(sentence):
            continue
        if _COVERAGE_LINE.search(sentence) and not _CLAIM_WORD.search(sentence):
            continue
        numbers = _integers_outside_dates(sentence)
        grounded = bool(numbers) and all(_number_in_evidence(number, evidence) for number in numbers)
        for number in numbers:
            if number in seen or _number_in_evidence(number, evidence):
                continue
            seen.add(number)
            issues.append(f"number {number} is not in the retrieved text")
        if grounded or _EPISTEMIC.search(sentence) or _PROCESS.search(sentence) or not _ASSERT.search(sentence):
            continue
        words = [
            word
            for word in re.findall(r"[A-Za-z]{4,}", sentence.lower())
            if word not in _STOP
        ]
        if words and all(word not in (evidence or "").lower() for word in words):
            issues.append(f"not in retrieved text: {sentence.strip()}")
    return issues


def _number_in_evidence(number: str, evidence: str) -> bool:
    return bool(re.search(rf"(?<!\d){re.escape(number)}(?!\d)", evidence or ""))


HARNESS_RECEIPT_SCHEMA = "agents_harness.tool_receipt.v1"
MEMORY_WRITE_RECEIPT_SCHEMA = "agents_memory.write_receipt.v1"


def _is_memory_write_tool(name: str) -> bool:
    low = name.lower().replace("_", ".")
    return "memory.add" in low or "memory.write" in low


def receipts_as_tool_calls(receipts: list[Any] | None) -> list[dict[str, Any]]:
    """Map harness receipts onto the tool-call shape ``review_turn`` already checks.

    A receipt counts only when ``success`` is true and the schema is
    ``agents_harness.tool_receipt.v1``. A memory add or write counts only when
    the nested payload is ``agents_memory.write_receipt.v1`` and is not
    ``verified: false``.
    """
    calls: list[dict[str, Any]] = []
    for item in receipts or []:
        if not isinstance(item, dict) or item.get("success") is not True:
            continue
        schema = str(item.get("schema") or "")
        if schema != HARNESS_RECEIPT_SCHEMA:
            continue
        tool = str(item.get("tool") or "")
        nested = item.get("receipt") if isinstance(item.get("receipt"), dict) else None
        nested_schema = str((nested or {}).get("schema") or "")
        if _is_memory_write_tool(tool) or nested_schema == MEMORY_WRITE_RECEIPT_SCHEMA:
            if nested_schema != MEMORY_WRITE_RECEIPT_SCHEMA or (nested or {}).get("verified") is False:
                continue
            calls.append({"name": tool or "mcp.memory.write", "ok": True, "arguments": nested})
            continue
        calls.append({"name": tool, "ok": True, "arguments": nested or {}})
    return calls


def review_turn(
    assistant_text: str,
    *,
    tool_calls: list[Mapping[str, Any]] | None = None,
    receipts: list[Any] | None = None,
    checked: Mapping[str, str] | None = None,
    evidence: str = "",
    prior_context: str = "",
    required_sources: tuple[str, ...] = _REQUIRED_SOURCES,
    scope: str = "all",
) -> list[str]:
    """Review a draft the way the evidence policy requires.

    ``checked`` maps a source id to the result string (``no hit``, ``not scanned``,
    ``3 record(s)``, …). ``evidence`` is the text actually retrieved.
    ``receipts`` are ``agents_harness.tool_receipt.v1`` objects and replace
    ``tool_calls`` for the side-effect check. ``scope="side_effects"`` is the
    harness final check: it does not score absence or truncated text, because
    that hook does not receive the retrieved sources.
    """
    calls = receipts_as_tool_calls(receipts) if receipts is not None else list(tool_calls or [])
    if scope == "side_effects":
        return [f"side_effect: {item}" for item in flag_unbacked_side_effects(assistant_text, calls)]
    sources = dict(checked or {})
    issues: list[str] = []
    if claims_global_absence(assistant_text):
        unchecked = [
            name
            for name in required_sources
            if name not in sources or "not checked" in sources[name] or "not scanned" in sources[name]
        ]
        if unchecked:
            issues.append("absence: not checked: " + ", ".join(unchecked))
        if any(re.search(r"\d+ record", value) or "file(s) on disk" in value for value in sources.values()):
            issues.append("absence: checked sources have records")
        issues.append("absence: say 'no hit in <source>' instead of claiming it does not exist")
    if asks_permission_for_read(assistant_text):
        issues.append("permission: read-only investigation does not need permission")
    if admits_truncation(prior_context + "\n" + assistant_text) and not any(is_full_read(call) for call in calls):
        if not _GAP_STATEMENT.search(assistant_text):
            issues.append("truncated: retrieve the full source or name the missing span")
    issues.extend(f"side_effect: {item}" for item in flag_unbacked_side_effects(assistant_text, calls))
    if evidence or assistant_text:
        issues.extend(f"unsupported: {item}" for item in unsupported_facts(assistant_text, evidence))
    return issues


def harness_final_check(text: str, receipts: list[Any]) -> list[str]:
    """Adapter for ``runner.register_final_check``.

    An empty list means the reply is acceptable. Leftover strings are findings.
    """
    return review_turn(text, receipts=receipts, scope="side_effects")


def run_evidence(args: argparse.Namespace) -> int:
    try:
        start = date.fromisoformat(str(args.date_from))
        end = date.fromisoformat(str(args.date_to))
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    extra: list[tuple[str, Path]] = []
    for raw in list(args.root or []):
        path = Path(str(raw)).expanduser()
        extra.append((f"root:{path.name}", path))
    try:
        report = investigate(start, end, roots=extra, include_defaults=True)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    if getattr(args, "json", False):
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(render_report(report), end="")
    return 0
