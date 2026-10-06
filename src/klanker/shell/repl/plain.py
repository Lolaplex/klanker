"""Stdin/stdout interactive shell loop."""

from __future__ import annotations

from ..dispatch import process_line
from ..state import ShellState
from .ui import UiSession


def run_plain(state: ShellState) -> int:
    ui = UiSession(mode="plain")
    print(state.status_line())
    print("builtins + exec + agent — :help")
    while True:
        try:
            line = input(state.prompt_label()).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        cont, lines = process_line(state, line, ui=ui)
        for row in lines:
            print(row)
        if not cont:
            return 0
