"""Run external programs — foreground, inherit TTY, optional UI handoff."""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING, Sequence

if TYPE_CHECKING:
    from .repl.ui import UiSession
    from .state import ShellState


def run_argv(
    argv: Sequence[str],
    state: ShellState,
    *,
    ui: UiSession | None = None,
) -> int:
    if not argv:
        return 0
    if ui is not None:
        ui.before_foreground_child()
    try:
        proc = subprocess.run(
            list(argv),
            cwd=str(state.cwd),
            env=state.env,
        )
        return int(proc.returncode)
    finally:
        if ui is not None:
            ui.after_foreground_child()


def run_pipeline(
    segments: tuple[tuple[str, ...], ...],
    state: ShellState,
    *,
    ui: UiSession | None = None,
) -> int:
    if len(segments) == 1:
        return run_argv(segments[0], state, ui=ui)
    if ui is not None:
        ui.before_foreground_child()
    try:
        procs: list[subprocess.Popen[bytes]] = []
        prev_stdout = None
        for i, argv in enumerate(segments):
            if not argv:
                return 1
            stdin = prev_stdout
            stdout = None if i == len(segments) - 1 else subprocess.PIPE
            proc = subprocess.Popen(
                list(argv),
                cwd=str(state.cwd),
                env=state.env,
                stdin=stdin,
                stdout=stdout,
                stderr=None,
            )
            if prev_stdout is not None:
                prev_stdout.close()
            prev_stdout = proc.stdout
            procs.append(proc)
        code = 0
        for proc in procs:
            rc = proc.wait()
            if proc is procs[-1]:
                code = rc
        return int(code)
    finally:
        if ui is not None:
            ui.after_foreground_child()
