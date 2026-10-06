"""Terminal UI session — suspend/resume around foreground TUI children."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class UiSession:
    """Tracks whether the shell REPL owns a full-screen UI."""

    mode: str = "plain"  # plain | tui
    _suspended: bool = field(default=False, init=False)
    _suspend_hooks: list = field(default_factory=list, repr=False)
    _resume_hooks: list = field(default_factory=list, repr=False)

    def is_tui_active(self) -> bool:
        return self.mode == "tui" and not self._suspended

    def register_handoff(self, suspend, resume) -> None:
        self._suspend_hooks.append(suspend)
        self._resume_hooks.append(resume)

    def before_foreground_child(self) -> None:
        if self.mode != "tui" or self._suspended:
            return
        for hook in self._suspend_hooks:
            hook()
        self._suspended = True

    def after_foreground_child(self) -> None:
        if self.mode != "tui" or not self._suspended:
            return
        for hook in reversed(self._resume_hooks):
            hook()
        self._suspended = False
