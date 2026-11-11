"""Runner entry used by serve, chat, and routines.

Installs harness argv shims, then delegates to ``runner.loop``.
"""

from __future__ import annotations

import logging
import os
import sys

log = logging.getLogger("klanker.turn")


def channel_from_argv(argv: list[str]) -> str:
    """Return the ``--channel`` value from a ``runner.loop`` argv, if present."""
    for index, arg in enumerate(argv):
        if arg == "--channel" and index + 1 < len(argv):
            return argv[index + 1].strip()
        if arg.startswith("--channel="):
            return arg.split("=", 1)[1].strip()
    return ""


def system_from_argv(argv: list[str]) -> str:
    """Return the ``--system`` value from a ``runner.loop`` argv, if present."""
    for index, arg in enumerate(argv):
        if arg == "--system" and index + 1 < len(argv):
            return argv[index + 1].strip()
        if arg.startswith("--system="):
            return arg.split("=", 1)[1].strip()
    return ""


def main(argv: list[str] | None = None) -> int:
    from pathlib import Path

    from agents_workspace import Workspace

    from .gating import apply_approval_env

    # Per-turn context: resolve the workspace this process was spawned for and
    # point the harness at its module overlay. Never mutates a parent process.
    os.environ.setdefault("AGENTS_MODULES_DIR", str(Workspace.from_env().modules))
    args = list(sys.argv[1:] if argv is None else argv)
    # runner.loop keeps a non-file --system value as the literal prompt text, so a
    # stale path would silently become the system prompt. Refuse instead.
    system = system_from_argv(args)
    if system and not Path(system).is_file():
        print(f"Error: --system is not a readable file: {system}", file=sys.stderr)
        return 2
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
        from .hooks import register_harness_hooks

        register_harness_hooks()
    except Exception:
        log.warning("harness hooks were not registered", exc_info=True)
    try:
        from .shim import install_argv_shim

        install_argv_shim()
    except Exception:
        pass
    return loop_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
