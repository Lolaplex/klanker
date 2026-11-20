"""``klanker import`` — migrate ~/.claude, ~/.codex, ~/.cursor assets into a workspace.

Preview lists what each source would contribute; ``--apply`` copies skills into
``<ws>/skills``, instruction/memory files into ``<ws>/rules/imported``, and merges
``mcpServers`` into the workspace ``mcp.json`` overlay.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Item:
    source: str
    kind: str  # rule | skill | mcp | note
    name: str
    src: Path
    dst: str = ""


def _skill_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())


def _md_files(root: Path, pattern: str) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(p for p in root.glob(pattern) if p.is_file())


def _mcp_servers(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    servers = data.get("mcpServers") if isinstance(data, dict) else {}
    return servers if isinstance(servers, dict) else {}


def scan(home: Path, sources: tuple[str, ...] = ("claude", "codex", "cursor")) -> list[Item]:
    items: list[Item] = []
    if "claude" in sources:
        root = home / ".claude"
        items += [Item("claude", "rule", p.name, p) for p in _md_files(root, "CLAUDE.md")]
        items += [Item("claude", "rule", f"commands/{p.name}", p) for p in _md_files(root / "commands", "*.md")]
        items += [Item("claude", "skill", p.name, p) for p in _skill_dirs(root / "skills")]
        for cfg in (root / "settings.json", home / ".claude.json"):
            for name in _mcp_servers(cfg):
                items.append(Item("claude", "mcp", name, cfg))
    if "codex" in sources:
        root = home / ".codex"
        items += [Item("codex", "rule", p.name, p) for p in _md_files(root, "AGENTS.md")]
        items += [Item("codex", "rule", f"prompts/{p.name}", p) for p in _md_files(root / "prompts", "*.md")]
        items += [Item("codex", "skill", p.name, p) for p in _skill_dirs(root / "skills")]
        if (root / "config.toml").is_file():
            items.append(Item("codex", "note", "config.toml", root / "config.toml"))
    if "cursor" in sources:
        root = home / ".cursor"
        items += [Item("cursor", "rule", p.name, p) for p in _md_files(root / "rules", "*.mdc")]
        items += [Item("cursor", "rule", p.name, p) for p in _md_files(root / "rules", "*.md")]
        items += [Item("cursor", "skill", p.name, p) for p in _skill_dirs(root / "skills")]
        for name in _mcp_servers(root / "mcp.json"):
            items.append(Item("cursor", "mcp", name, root / "mcp.json"))
    return items


def _dst_for(ws, item: Item) -> Path:
    if item.kind == "skill":
        return ws.skills / item.name
    if item.kind == "rule":
        sub = Path(item.name).parent
        return ws.rules / "imported" / item.source / sub / Path(item.name).name
    raise ValueError(f"no file target for kind {item.kind}")


def apply_items(ws, items: list[Item]) -> list[str]:
    """Copy items into the workspace; returns written/merged path lines."""
    done: list[str] = []
    mcp_merge: dict[str, dict] = {}
    for item in items:
        if item.kind == "note":
            done.append(f"note  {item.source} {item.name} — manual review")
            continue
        if item.kind == "mcp":
            servers = _mcp_servers(item.src)
            if item.name in servers:
                mcp_merge[item.name] = servers[item.name]
            continue
        dst = _dst_for(ws, item)
        if item.src.is_dir():
            if dst.exists():
                done.append(f"skip  {item.kind} {item.name} — exists")
                continue
            shutil.copytree(item.src, dst)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item.src, dst)
        done.append(f"wrote {item.kind} {item.name} -> {dst}")
    if mcp_merge:
        overlay = ws.dir / "mcp.json"
        try:
            data = json.loads(overlay.read_text(encoding="utf-8")) if overlay.is_file() else {}
        except json.JSONDecodeError:
            data = {}
        servers = data.setdefault("mcpServers", {})
        added = [k for k in mcp_merge if k not in servers]
        for name in added:
            servers[name] = mcp_merge[name]
        overlay.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        done.append(f"mcp   merged {len(added)} server(s) -> {overlay} ({len(mcp_merge) - len(added)} already present)")
    return done


def run(source: str = "all", workspace: str = "", apply: bool = False) -> int:
    from agents_workspace import Host

    sources = ("claude", "codex", "cursor") if source == "all" else (source,)
    host = Host.from_env()
    ws = host.workspace(workspace) if workspace else host.select_workspace()
    items = scan(Path.home(), sources)
    if not items:
        print("nothing found to import")
        return 0
    for item in items:
        dst = ""
        if not apply:
            try:
                dst = f" -> {_dst_for(ws, item)}"
            except ValueError:
                dst = " -> (mcp overlay)" if item.kind == "mcp" else ""
        print(f"  {item.kind:<5} {item.source:<7} {item.name:<40} {item.src}{dst}")
    print(f"{len(items)} item(s) from {', '.join(sources)}")
    if not apply:
        print("preview only — re-run with --apply to write")
        return 0
    for line in apply_items(ws, items):
        print(f"  {line}")
    return 0
