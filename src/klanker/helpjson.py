"""Build Cordis overlay manifests from suite ``--help-json`` output.

Hand-written manifests (no ``generated_by``) and harness ``as_tool`` modules win.
Generated files are refreshed on each install. ``agents-keys`` exposes read verbs
only unless ``KLANKER_KEYS_WRITE=1``.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

log = logging.getLogger("klanker.helpjson")

GENERATED_BY = "klanker"

# Contract examples plus close read-only cousins. Everything else mutates.
READ_VERBS = frozenset(
    {
        "search",
        "list",
        "read",
        "show",
        "stats",
        "related",
        "projects",
        "calendars",
        "inspect",
        "sessions",
        "catalog",
        "check",
        "status",
        "inventory",
        "verify",
        "audit",
        "replay",
        "did",
        "resolve",
        "ssh-pubkey",
        "tail",
        "playbook",
        "snapshot",
    }
)

# Install / server lifecycle. Not useful as model tools.
SKIP_COMMANDS = frozenset(
    {
        "help",
        "help-json",
        "version",
        "man",
        "serve",
        "mcp",
        "init",
        "sync",
        "sync-mcp",
        "skills",
    }
)

PACKAGES: tuple[dict[str, Any], ...] = (
    {"alias": "memory", "module": "agents_memory", "read_only": False},
    {"alias": "docs", "module": "agents_docs", "read_only": False},
    {"alias": "traces", "module": "agents_traces", "read_only": False},
    {"alias": "calendar", "module": "agents_calendar", "read_only": False},
    {"alias": "terminal", "module": "agents_terminal", "read_only": False},
    {"alias": "browser", "module": "agents_browser", "read_only": False},
    {"alias": "keys", "module": "agents_keys", "read_only": True},
    {"alias": "vand", "module": "vand", "read_only": False},
)

_POS = re.compile(r"[A-Z][A-Z0-9_]*")


def keys_write_enabled() -> bool:
    return os.environ.get("KLANKER_KEYS_WRITE", "").strip().lower() in ("1", "true", "yes", "on")


def command_leaf(name: str) -> str:
    return name.replace(".", " ").split()[-1].lower()


def is_read_verb(name: str) -> bool:
    return command_leaf(name) in READ_VERBS


def _skip(name: str) -> bool:
    leaf = command_leaf(name)
    return leaf in SKIP_COMMANDS or name.lower() in SKIP_COMMANDS


def _tokens(usage: str) -> list[tuple[str, bool]]:
    out: list[tuple[str, bool]] = []
    depth = 0
    buf = ""

    def flush() -> None:
        nonlocal buf
        if buf:
            out.append((buf, depth > 0))
            buf = ""

    for ch in usage:
        if ch == "[":
            flush()
            depth += 1
        elif ch == "]":
            flush()
            depth = max(0, depth - 1)
        elif ch.isspace() or ch in "|{}":
            flush()
        else:
            buf += ch
    flush()
    return out


def schema_from_usage(usage: str) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    tokens = _tokens(usage)
    index = 0
    while index < len(tokens):
        tok, optional = tokens[index]
        if tok.startswith("--") and len(tok) > 2:
            flag = tok
            key = flag[2:].replace("-", "_")
            takes_value = False
            if index + 1 < len(tokens) and _POS.fullmatch(tokens[index + 1][0].rstrip(".")):
                takes_value = True
                index += 1
            if key not in properties:
                properties[key] = {
                    "type": "string" if takes_value else "boolean",
                    "description": flag,
                    "x-cli": flag,
                }
        else:
            word = tok.rstrip(".")
            if _POS.fullmatch(word):
                key = word.lower()
                if key not in properties:
                    properties[key] = {
                        "type": "string",
                        "description": word,
                        "x-cli": "positional",
                    }
                    if not optional:
                        required.append(key)
        index += 1
    if not properties:
        properties["argv"] = {
            "type": "array",
            "items": {"type": "string"},
            "description": usage or "Extra CLI arguments",
        }
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def _long_flag(opt: dict[str, Any]) -> str:
    flags = opt.get("flags") or opt.get("option_strings") or []
    if isinstance(flags, list):
        for flag in flags:
            if isinstance(flag, str) and flag.startswith("--"):
                return flag
        if flags and isinstance(flags[0], str) and flags[0].startswith("-"):
            return flags[0]
    dest = str(opt.get("dest") or opt.get("name") or "").strip()
    return f"--{dest}" if dest else ""


def schema_from_structured(meta: dict[str, Any]) -> dict[str, Any] | None:
    options = meta.get("options") if isinstance(meta.get("options"), list) else []
    arguments = meta.get("arguments") if isinstance(meta.get("arguments"), list) else []
    flag_names = meta.get("flags") if isinstance(meta.get("flags"), list) else []
    properties: dict[str, Any] = {}
    required: list[str] = []

    positional_sources: list[dict[str, Any]] = []
    option_sources: list[dict[str, Any]] = [item for item in options if isinstance(item, dict)]
    for arg in arguments:
        if not isinstance(arg, dict):
            continue
        if arg.get("option_strings") or arg.get("flags"):
            option_sources.append(arg)
        else:
            positional_sources.append(arg)

    for arg in positional_sources:
        key = str(arg.get("dest") or arg.get("name") or "").strip().replace("-", "_")
        if not key or key in ("help", "command", "func"):
            continue
        properties[key] = {
            "type": "string",
            "description": str(arg.get("help") or arg.get("name") or key),
            "x-cli": "positional",
        }
        nargs = str(arg.get("nargs") or "")
        if arg.get("required", True) and nargs not in ("?", "*", "..."):
            required.append(key)

    for opt in option_sources:
        flag = _long_flag(opt)
        if not flag or flag in ("--help", "--help-json", "-h"):
            continue
        key = flag.lstrip("-").replace("-", "_")
        if not key or key in properties:
            continue
        kind = str(opt.get("kind") or "")
        is_bool = kind == "flag" or opt.get("nargs") in (0, "0")
        properties[key] = {
            "type": "boolean" if is_bool else "string",
            "description": str(opt.get("help") or flag),
            "x-cli": flag if flag.startswith("--") else f"--{key}",
        }
        if opt.get("required"):
            required.append(key)

    for flag in flag_names:
        if not isinstance(flag, str) or not flag.startswith("--"):
            continue
        if flag in ("--help", "--help-json"):
            continue
        key = flag[2:].replace("-", "_")
        if key in properties:
            continue
        properties[key] = {"type": "string", "description": flag, "x-cli": flag}

    if not properties:
        return None
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def schema_for(meta: dict[str, Any]) -> dict[str, Any]:
    structured = schema_from_structured(meta)
    if structured and structured.get("properties"):
        return structured
    usage = str(meta.get("usage") or "").strip()
    if usage:
        return schema_from_usage(usage)
    desc = str(meta.get("description") or meta.get("help") or "Extra CLI arguments")
    return {
        "type": "object",
        "properties": {
            "argv": {
                "type": "array",
                "items": {"type": "string"},
                "description": desc,
            }
        },
    }


def iter_commands(spec: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    commands = spec.get("commands")
    items: list[tuple[str, dict[str, Any]]] = []
    if isinstance(commands, dict):
        for name, meta in commands.items():
            items.append((str(name), meta if isinstance(meta, dict) else {"description": str(meta)}))
    elif isinstance(commands, list):
        for item in commands:
            if isinstance(item, str):
                items.append((item, {"description": item}))
            elif isinstance(item, dict) and item.get("name"):
                items.append((str(item["name"]), item))
    for name, meta in items:
        found.append((name, meta))
        subs = meta.get("subcommands")
        if isinstance(subs, dict):
            for sub_name, sub_meta in subs.items():
                child = sub_meta if isinstance(sub_meta, dict) else {"description": str(sub_meta)}
                found.append((f"{name}.{sub_name}", child))
    return found


def _module_name(alias: str, command: str) -> str:
    raw = f"mcp.{alias}.{command}"
    return re.sub(r"[^a-zA-Z0-9._-]", "_", raw)


def build_manifests(
    spec: dict[str, Any],
    *,
    alias: str,
    module: str,
    read_only: bool = False,
) -> list[dict[str, Any]]:
    """Normalize one help-json document into catalog manifests."""
    rows: list[dict[str, Any]] = []
    allow_mutate = (not read_only) or keys_write_enabled()
    for command, meta in iter_commands(spec):
        if _skip(command):
            continue
        read = is_read_verb(command)
        if read_only and not read and not allow_mutate:
            continue
        if read_only and not read and not keys_write_enabled():
            continue
        description = str(meta.get("description") or meta.get("help") or command).strip()
        cli = command.replace(".", " ")
        name = _module_name(alias, command)
        rows.append(
            {
                "name": name,
                "kind": "mcp",
                "when": "on_request",
                "cadence": "on_request",
                "verb": f"python -m {module} {cli}",
                "rests_on": description[:240] or f"{module} {cli}",
                "expected_exit": 0,
                "timeout_sec": 30,
                "as_tool": True,
                "mutates": not read,
                "generated_by": GENERATED_BY,
                "parameters": schema_for(meta),
            }
        )
    if allow_mutate or not read_only:
        if not (read_only and not keys_write_enabled()):
            rows.append(_passthrough(alias, module, spec))
    return rows


def _passthrough(alias: str, module: str, spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": f"mcp.{alias}.argv",
        "kind": "mcp",
        "when": "on_request",
        "cadence": "on_request",
        "verb": f"python -m {module}",
        "rests_on": f"{module} argv passthrough. load_schema includes --help-json.",
        "expected_exit": 0,
        "timeout_sec": 60,
        "as_tool": True,
        "mutates": True,
        "generated_by": GENERATED_BY,
        "parameters": {
            "type": "object",
            "properties": {
                "argv": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": f"Arguments after python -m {module}",
                }
            },
            "required": ["argv"],
            "x-help-json": spec,
        },
    }


def _parse_json_blob(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            return None
    return data if isinstance(data, dict) else None


def module_installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except Exception:
        return False


def fetch_help_json(module: str, *, timeout: float = 15) -> dict[str, Any] | None:
    if not module_installed(module):
        return None
    env = dict(os.environ)
    env["AGENTS_NO_UPDATE_CHECK"] = "1"
    try:
        proc = subprocess.run(
            [sys.executable, "-m", module, "--help-json"],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.debug("help-json failed for %s: %s", module, exc)
        return None
    if proc.returncode != 0:
        log.debug("help-json exit %s for %s", proc.returncode, module)
        return None
    return _parse_json_blob(proc.stdout)


def harness_as_tool_names() -> set[str]:
    try:
        from runner.modules import MODULES_DIR, load_module
    except Exception:
        return set()
    names: set[str] = set()
    if not MODULES_DIR.is_dir():
        return names
    for path in MODULES_DIR.glob("*.json"):
        try:
            row = load_module(path)
        except Exception:
            continue
        if row.get("as_tool"):
            names.add(str(row.get("name") or path.stem))
    return names


def _is_generated(path: Path) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(data, dict) and data.get("generated_by") == GENERATED_BY


def _write(path: Path, manifest: dict[str, Any]) -> None:
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def generate_overlays(
    dest: Path,
    *,
    packages: tuple[dict[str, Any], ...] | None = None,
    fetcher: Any = None,
) -> list[str]:
    """Write generated manifests into ``dest``. Return names written."""
    dest.mkdir(parents=True, exist_ok=True)
    fetch = fetcher or fetch_help_json
    protected = harness_as_tool_names()
    for path in dest.glob("*.json"):
        if _is_generated(path) and path.stem in protected:
            path.unlink()
            continue
        if not _is_generated(path):
            protected.add(path.stem)

    written: list[str] = []
    for pkg in packages or PACKAGES:
        alias = str(pkg["alias"])
        module = str(pkg["module"])
        spec = fetch(module)
        if not spec:
            continue
        for manifest in build_manifests(
            spec,
            alias=alias,
            module=module,
            read_only=bool(pkg.get("read_only")),
        ):
            name = str(manifest["name"])
            path = dest / f"{name}.json"
            if name in protected:
                continue
            if path.exists() and not _is_generated(path):
                continue
            _write(path, manifest)
            written.append(name)
    return written
