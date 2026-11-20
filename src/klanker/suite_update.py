"""``klanker update`` — pull every suite package to its latest ref/release.

Editable checkouts (a module living in a git repo outside site-packages) are
updated with ``git pull --ff-only``; plain installs go through
``pip install -U`` — or ``uv tool upgrade`` when klanker itself runs as a uv
tool, whose venv pip cannot reach.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .doctor import _dist_name
from .sensing import SUITE_MODULES


@dataclass
class Row:
    name: str
    action: str  # pull | upgrade
    status: str = "pending"  # ok | current | error | skipped
    detail: str = ""


def _git_root(path: Path) -> Path | None:
    """Walk up for a ``.git`` entry; None when outside any checkout."""
    for parent in (path, *path.parents):
        if (parent / ".git").exists():
            return parent
    return None


def _module_path(module: str) -> Path | None:
    try:
        spec = importlib.util.find_spec(module)
    except Exception:
        return None
    if spec is None or not spec.origin:
        return None
    return Path(spec.origin).resolve()


def _is_uv_tool(name: str) -> bool:
    uv = shutil.which("uv")
    if not uv:
        return False
    try:
        proc = subprocess.run(
            [uv, "tool", "list"], capture_output=True, text=True, timeout=15, check=False
        )
    except Exception:
        return False
    return any(line.split()[0] == name for line in proc.stdout.splitlines() if line.split())


def plan_updates() -> list[Row]:
    """One row per update unit: git checkouts deduped, pip for the rest."""
    rows: list[Row] = []
    repos: dict[Path, str] = {}
    pip_dists: list[str] = []
    uv_tool = _is_uv_tool("klanker")
    for alias, module in sorted(SUITE_MODULES.items()):
        dist = _dist_name(alias, module)
        path = _module_path(module)
        if path is None:
            rows.append(Row(dist, "skip", "skipped", "not installed"))
            continue
        root = _git_root(path)
        if root is not None and "site-packages" not in path.parts:
            repos.setdefault(root, dist)
        elif not uv_tool:
            pip_dists.append(dist)
    kpath = _module_path("klanker")
    kroot = _git_root(kpath) if kpath else None
    if kroot is not None and "site-packages" not in (kpath or Path()).parts:
        repos.setdefault(kroot, "klanker")
    elif uv_tool:
        rows.append(Row("klanker", "upgrade"))
    elif kpath is not None:
        pip_dists.append("klanker")
    for root, dist in sorted(repos.items(), key=lambda kv: str(kv[0])):
        rows.append(Row(dist, "pull", detail=str(root)))
    rows.extend(Row(d, "upgrade") for d in pip_dists)
    return rows


def _run(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except Exception as exc:
        return 1, str(exc)
    out = (proc.stdout or proc.stderr or "").strip()
    return proc.returncode, out.splitlines()[-1] if out else ""


def apply_update(row: Row) -> Row:
    if row.action == "pull":
        repo = Path(row.detail)
        code, out = _run(["git", "rev-parse", "HEAD"], cwd=repo)
        before = out[:10] if code == 0 else ""
        code, out = _run(["git", "pull", "--ff-only"], cwd=repo)
        if code != 0:
            row.status, row.detail = "error", out
            return row
        _, after = _run(["git", "rev-parse", "HEAD"], cwd=repo)
        if after[:10] == before:
            row.status, row.detail = "current", str(repo)
        else:
            row.status, row.detail = "ok", f"{before} -> {after[:10]}"
        return row
    if row.action == "upgrade":
        if _is_uv_tool(row.name):
            code, out = _run(["uv", "tool", "upgrade", row.name])
        else:
            code, out = _run([sys.executable, "-m", "pip", "install", "-U", row.name])
        row.status = "ok" if code == 0 else "error"
        row.detail = out
        return row
    row.status = "skipped"
    return row


def run(check: bool = False) -> int:
    rows = plan_updates()
    if check:
        for row in rows:
            print(f"  {row.action:<7} {row.name:<18} {row.detail}")
        return 0
    for row in rows:
        if row.status == "skipped":
            print(f"  skip    {row.name:<18} {row.detail}")
            continue
        apply_update(row)
        print(f"  {row.status:<7} {row.name:<18} {row.detail}")
    return 1 if any(r.status == "error" for r in rows) else 0
