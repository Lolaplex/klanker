"""Runner entry used by serve, chat, and routines.

Installs harness argv shims, then delegates to ``runner.loop``.
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    try:
        from runner.loop import main as loop_main
    except ImportError:
        print("Error: agents-harness is not installed.", file=sys.stderr)
        return 1
    try:
        from .shim import install_argv_shim

        install_argv_shim()
    except Exception:
        pass
    return loop_main(list(sys.argv[1:] if argv is None else argv))


if __name__ == "__main__":
    raise SystemExit(main())
