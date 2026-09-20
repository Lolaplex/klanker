"""Install Klanker Cordis module overlays into AGENTS_MODULES_DIR."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

BUNDLED = Path(__file__).resolve().parent / "modules"
OVERLAY_ALWAYS = frozenset({"mcp.schedule.add.json"})


def overlay_dir() -> Path:
    raw = os.environ.get("AGENTS_MODULES_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".agents" / "modules"


def install_overlay(target: Path | None = None) -> Path:
    dest = target or overlay_dir()
    dest.mkdir(parents=True, exist_ok=True)
    if not BUNDLED.is_dir():
        return dest
    for src in sorted(BUNDLED.glob("*.json")):
        out = dest / src.name
        if src.name in OVERLAY_ALWAYS or not out.exists():
            shutil.copy2(src, out)
    return dest
