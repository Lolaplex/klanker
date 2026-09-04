"""Clanker Nucleus — The adaptive core coordinator."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from typing import Any


from .sensing import HostCapabilities, probe_host

log = logging.getLogger("clanker.nucleus")


class Nucleus:
    def __init__(self, caps: HostCapabilities | None = None) -> None:
        self.caps = caps or probe_host()

    def sense(self) -> dict[str, Any]:
        """Return environment topology summary."""
        return self.caps.summary()

    def run_turn(
        self,
        *,
        message: str,
        user: str = "default",
        session: str | None = None,
        channel: str = "local",
        provider: str | None = None,
        deliver: str = "buffered",
    ) -> int:
        """Execute one conversational turn using available runner or fallback."""
        selected_provider = provider or os.environ.get("LOOP_PROVIDER", "openai.default")

        # If agents-harness is installed, invoke runner.loop directly
        if self.caps.has_harness:
            from .prompt import build_system_prompt

            system_prompt = build_system_prompt(self.caps)

            cmd = [
                "python",
                "-m",
                "runner.loop",
                "--channel",
                channel,
                "--user",
                user,
                "--message",
                message,
                "--system",
                system_prompt,
                "--complete",
                "--provider",
                selected_provider,
                "--deliver",
                deliver,
            ]
            if session:
                cmd.extend(["--session", session])

            res = subprocess.run(cmd)
            return res.returncode
        else:
            print(
                "Error: agents-harness is required for conversational turns.\n"
                "Install it via: pip install -e ../agents-harness (or pip install clanker)",
                file=sys.stderr,
            )
            return 1

