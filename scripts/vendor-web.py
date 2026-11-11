#!/usr/bin/env python3
"""Vendor the built dashboard into the wheel.

Build `web/` first (`pnpm i && pnpm build`), then run this before
`python -m build`. Copies `web/dist` -> `src/klanker/_web` (gitignored).
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "dist"
DEST = ROOT / "src" / "klanker" / "_web"


def main() -> int:
    if not (SRC / "index.html").is_file():
        print(f"error: {SRC} missing — run `pnpm build` in web/ first", file=sys.stderr)
        return 1
    if DEST.exists():
        shutil.rmtree(DEST)
    shutil.copytree(SRC, DEST)
    print(f"vendored {SRC} -> {DEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
