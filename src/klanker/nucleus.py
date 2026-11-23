"""Klanker Nucleus — The adaptive core coordinator."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from typing import Any


from .sensing import HostCapabilities, probe_host

log = logging.getLogger("klanker.nucleus")


def _provider_key_env(provider: str) -> str:
    """Resolve the active provider's key env var from its manifest."""
    name = (provider or "").strip()
    if not name:
        return ""
    try:
        from runner.providers import find_provider

        manifest = find_provider(name)
    except Exception:
        manifest = None
    if not isinstance(manifest, dict):
        try:
            import json
            from agents_workspace import Host

            candidate = Host.from_env().dir / "providers" / f"{name}.json"
            if candidate.is_file():
                raw = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    manifest = raw
        except Exception:
            manifest = None
    if isinstance(manifest, dict):
        key_env = str(manifest.get("key_env") or "").strip()
        if key_env:
            return key_env
        if manifest.get("kind", "openai_compat") == "openai_compat":
            return "LLM_API_KEY"
    return ""


class Nucleus:
    def __init__(self, caps: HostCapabilities | None = None) -> None:
        self.caps = caps or probe_host()

    def sense(self) -> dict[str, Any]:
        """Return environment topology summary, MCP servers, and skills."""
        from .config_sense import mcp_report, skills_report

        summary = self.caps.summary()
        summary.update(mcp_report())
        summary.update(skills_report())
        return summary

    def run_turn(
        self,
        *,
        message: str,
        user: str = "default",
        session: str | None = None,
        channel: str = "local",
        provider: str | None = None,
        deliver: str = "buffered",
        seal: bool = False,
        workspace: "Workspace | None" = None,
        workdir: str = "",
        persona: str = "",
        detached: bool = False,
    ) -> int:
        """Execute one conversational turn using available runner or fallback."""
        from agents_workspace import Workspace

        selected_provider = provider or os.environ.get("LOOP_PROVIDER", "openai.default")

        # If agents-harness is installed, invoke runner.loop directly
        if self.caps.has_harness:
            from .overlay import ensure_default_overlay
            from .prompt import build_system_prompt

            ws = workspace or Workspace.from_env()
            self.caps = probe_host()
            ensure_default_overlay(ws, generate=False)

            system_prompt = build_system_prompt(self.caps)

            cmd = [
                sys.executable,
                "-m",
                "klanker.turn",
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
            if detached:
                cmd.append("--detached-session")
            if persona:
                cmd.extend(["--persona", persona])
            if seal:
                cmd.append("--seal")

            from agents_workspace.runtime import (
                isolation_of,
                run as ws_run,
                to_container_argv,
                to_container_env,
            )

            isolation = isolation_of(ws)
            role = "container" if isolation == "container" else "turn"
            key_env = _provider_key_env(selected_provider)
            env = (
                ws.env(
                    persona=persona,
                    workdir=workdir,
                    role=role,
                    provider_key_env=key_env,
                )
                if workdir
                else ws.env(
                    persona=persona,
                    role=role,
                    provider_key_env=key_env,
                )
            )
            if session:
                env.setdefault(
                    "AGENTS_SESSION_BIND_CMD",
                    f'"{sys.executable}" -m klanker _session-gate '
                    "{session} {tool}")
            if isolation == "container":
                cmd = to_container_argv(ws, cmd)
                env = to_container_env(ws, env)
            res = ws_run(ws, cmd, env, capture=False)
            return int(res.returncode)
        else:
            print(
                "Error: agents-harness is required for conversational turns.\n"
                "Install it via: pip install -e ../agents-harness (or pip install klanker)",
                file=sys.stderr,
            )
            return 1

