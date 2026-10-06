"""Install Klanker Cordis module overlays into AGENTS_MODULES_DIR."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

BUNDLED = Path(__file__).resolve().parent / "modules"
OVERLAY_ALWAYS = frozenset({"mcp.schedule.add.json"})
_default_ready = False


def overlay_dir() -> Path:
    raw = os.environ.get("AGENTS_MODULES_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".agents" / "modules"


def publish_modules_dir() -> Path:
    """Harness reads the overlay only when ``AGENTS_MODULES_DIR`` is set."""
    path = overlay_dir()
    os.environ.setdefault("AGENTS_MODULES_DIR", str(path))
    return Path(os.environ["AGENTS_MODULES_DIR"]).expanduser()


def install_overlay(target: Path | None = None, *, generate: bool = True) -> Path:
    dest = target or overlay_dir()
    dest.mkdir(parents=True, exist_ok=True)
    if BUNDLED.is_dir():
        for src in sorted(BUNDLED.glob("*.json")):
            out = dest / src.name
            if src.name in OVERLAY_ALWAYS or not out.exists():
                shutil.copy2(src, out)
    if generate:
        from .helpjson import generate_overlays

        generate_overlays(dest)
    return dest


def ensure_default_overlay() -> Path:
    """Install the default overlay once per process."""
    global _default_ready
    if _default_ready:
        return overlay_dir()
    dest = install_overlay()
    _default_ready = True
    return dest
