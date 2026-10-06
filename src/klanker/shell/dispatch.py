"""Dispatch one shell line."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from .agent import agent_turn, handle_meta_builtin
from .exec_ import run_argv, run_pipeline
from .resolve import ResolveResult, resolve_line

if TYPE_CHECKING:
    from .repl.ui import UiSession
    from .state import ShellState


def _builtin_cd(state: ShellState, argv: tuple[str, ...]) -> list[str]:
    target = argv[1] if len(argv) > 1 else str(Path.home())
    if target == "-":
        return ["cd: OLDPWD not implemented yet"]
    p = Path(target)
    if not p.is_absolute():
        p = state.cwd / p
    try:
        state.cwd = p.resolve()
    except OSError as exc:
        return [f"cd: {exc}"]
    return []


def _builtin_pwd(state: ShellState) -> list[str]:
    return [str(state.cwd)]


def process_line(
    state: ShellState,
    line: str,
    *,
    ui: UiSession | None = None,
) -> tuple[bool, list[str]]:
    """Returns (continue_loop, output lines)."""
    result = resolve_line(line, env=state.env)
    if result.route == "empty":
        return True, []
    if result.route == "builtin":
        return _dispatch_builtin(state, result, ui=ui)
    if result.route == "exec":
        if result.segments:
            code = run_pipeline(result.segments, state, ui=ui)
        else:
            code = run_argv(result.argv, state, ui=ui)
        state.last_status = code
        return True, []
    if result.route == "agent":
        state.log.append(f"> {result.payload}")
        out = agent_turn(state, result.payload)
        state.log.extend(out)
        return True, out
    return True, []


def _dispatch_builtin(
    state: ShellState,
    result: ResolveResult,
    *,
    ui: UiSession | None,
) -> tuple[bool, list[str]]:
    intent = result.intent
    if intent in {"exit", "quit"}:
        return False, []
    if intent == "cd":
        return True, _builtin_cd(state, result.argv)
    if intent == "pwd":
        return True, _builtin_pwd(state)
    if intent in {"help", "?"}:
        return True, handle_meta_builtin(state, "help")
    lines = handle_meta_builtin(state, intent, payload=result.payload, message=result.message)
    if lines:
        return True, lines
    return True, []
