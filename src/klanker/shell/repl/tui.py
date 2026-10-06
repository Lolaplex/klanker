"""Ratatui shell — suspends for foreground child TUIs."""

from __future__ import annotations

from ..dispatch import process_line
from ..state import ShellState
from .ui import UiSession


def run_tui(state: ShellState) -> int:
    try:
        from pyratatui import Block, Color, Constraint, Direction, Layout, Paragraph, Style, Terminal, TextArea
    except ImportError as exc:
        raise SystemExit(
            "pyratatui required for TUI. Install: pip install 'klanker[tui]'"
        ) from exc

    ui = UiSession(mode="tui")
    input_area = TextArea.default()
    input_area.set_block(Block().bordered().title("input"))
    quit_requested = False
    term: Terminal | None = None

    def suspend() -> None:
        fn = getattr(term, "suspend", None) if term is not None else None
        if callable(fn):
            fn()

    def resume() -> None:
        fn = getattr(term, "resume", None) if term is not None else None
        if callable(fn):
            fn()

    ui.register_handoff(suspend, resume)

    def reset_input() -> None:
        nonlocal input_area
        input_area = TextArea.default()
        input_area.set_block(Block().bordered().title("input"))

    def draw(frame) -> None:
        chunks = Layout.split(
            frame.area,
            [
                Layout.c(Constraint.length(1)),
                Layout.c(Constraint.min(3)),
                Layout.c(Constraint.length(3)),
            ],
            Direction.VERTICAL,
        )
        status = Paragraph.from_string(state.status_line()).style(Style().fg(Color.dark_gray))
        frame.render_widget(status, chunks[0])
        body = "\n".join(state.log[-500:]) if state.log else "exec native programs — :help for meta"
        output = (
            Paragraph.from_string(body)
            .block(Block().bordered().title("output"))
            .wrap()
        )
        frame.render_widget(output, chunks[1])
        frame.render_widget(input_area, chunks[2])

    def submit_input() -> None:
        nonlocal quit_requested
        text = "\n".join(input_area.lines()).strip()
        reset_input()
        if not text:
            return
        cont, lines = process_line(state, text, ui=ui)
        if lines:
            state.log.extend(lines)
        if not cont:
            quit_requested = True

    with Terminal() as term_holder:
        term = term_holder
        while not quit_requested:
            term.draw(draw)
            ev = term.poll_event(timeout_ms=50)
            if ev is None:
                continue
            if ev.code in ("c", "C") and ev.ctrl:
                quit_requested = True
                continue
            if ev.code == "Enter":
                submit_input()
                continue
            input_area.input_key(ev)

    return 0
