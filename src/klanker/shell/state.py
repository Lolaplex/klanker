"""Shell session state — cwd, env, optional gateway client."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agents_gateway.client import GatewayClient


@dataclass
class ShellState:
    cwd: Path
    env: dict[str, str] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)
    gateway: GatewayClient | None = None
    stream: bool = False
    pending_new_session: bool = False
    last_status: int = 0

    @classmethod
    def from_os(cls, *, gateway: GatewayClient | None = None) -> ShellState:
        return cls(
            cwd=Path.cwd(),
            env=dict(os.environ),
            gateway=gateway,
        )

    def prompt_label(self) -> str:
        try:
            home = Path.home()
            cwd = self.cwd.resolve()
            if cwd == home:
                tail = "~"
            elif home in cwd.parents:
                tail = f"~/{cwd.relative_to(home)}"
            else:
                tail = str(cwd)
        except OSError:
            tail = str(self.cwd)
        return f"klanker {tail}> "

    def status_line(self) -> str:
        parts = [f"cwd={self.cwd}"]
        if self.gateway is not None:
            sess = self.gateway.session or "—"
            parts.append(f"session={sess}")
            parts.append(f"project={self.gateway.project}")
            if self.pending_new_session:
                parts.append("fork")
        parts.append(f"status={self.last_status}")
        return "  ".join(parts)

    def gateway_snapshot(self) -> dict[str, Any]:
        if self.gateway is None:
            return {}
        return {
            "session": self.gateway.session,
            "user_id": self.gateway.user_id,
            "channel": self.gateway.channel,
            "user": self.gateway.user,
            "project": self.gateway.project,
        }
