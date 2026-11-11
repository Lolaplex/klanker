"""Vendored dashboard assets.

`scripts/vendor-web.py` copies `web/dist` into `src/klanker/_web` before a
wheel build, so `pip install klanker` ships the static dashboard without any
node dependency. `klanker serve` points `AGENTS_RELAY_WEB_DIR` at it when the
env var is unset.
"""

from __future__ import annotations

from pathlib import Path


def default_web_dir() -> Path | None:
    root = Path(__file__).resolve().parent / "_web"
    return root if (root / "index.html").is_file() else None
