"""Runner entry used by serve, chat, and routines.

Installs harness argv shims, then delegates to ``runner.loop``.
"""

from __future__ import annotations

import os
import sys


def channel_from_argv(argv: list[str]) -> str:
    """Return the ``--channel`` value from a ``runner.loop`` argv, if present."""
    for index, arg in enumerate(argv):
        if arg == "--channel" and index + 1 < len(argv):
            return argv[index + 1].strip()
        if arg.startswith("--channel="):
            return arg.split("=", 1)[1].strip()
    return ""


def main(argv: list[str] | None = None) -> int:
    from .gating import apply_approval_env
    from .overlay import publish_modules_dir

    publish_modules_dir()
    args = list(sys.argv[1:] if argv is None else argv)
    channel = channel_from_argv(args)
    if channel:
        os.environ["KLANKER_CHANNEL"] = channel
    apply_approval_env(telegram=False)
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
    return loop_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
