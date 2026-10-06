"""Optional gateway / harness agent tier."""

from __future__ import annotations

import json
import subprocess
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .state import ShellState


def harness_flag(flag: str) -> str:
    proc = subprocess.run(
        [sys.executable, "-m", "runner.loop", flag],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "harness failed").strip()
        return f"harness error: {err}"
    return (proc.stdout or "").strip()


def agent_turn(state: ShellState, message: str) -> list[str]:
    gw = state.gateway
    if gw is None:
        return ["agent tier unavailable (install agents-gateway and pass --url)"]
    new_session = state.pending_new_session
    state.pending_new_session = False
    if state.stream:
        buf: list[str] = []
        try:
            for event in gw.stream(message, new_session=new_session):
                if event.get("type") == "delta":
                    buf.append(str(event.get("text", "")))
                elif event.get("type") == "trailer":
                    break
        except Exception as exc:
            return [f"stream error: {exc}"]
        text = "".join(buf).strip()
        return [text] if text else ["(empty reply)"]
    try:
        data = gw.turn(message, new_session=new_session)
    except Exception as exc:
        return [f"turn error: {exc}"]
    reply = str(data.get("reply", "")).strip()
    return [reply] if reply else ["(empty reply)"]


def handle_meta_builtin(state: ShellState, intent: str, payload: str = "", message: str = "") -> list[str]:
    gw = state.gateway
    if intent == "help":
        rows = [
            "cd <dir>  pwd  exit  |  external commands on PATH",
            ":session :new-session :health :provider <name>",
            ":modules :providers :tools  (harness)",
            ":turn <msg> | bare text → agent (needs gateway)",
        ]
        return rows
    if intent == "error":
        return [message]
    if intent == "unknown":
        return [message]
    if intent == "session":
        if gw is None:
            return ["no gateway session"]
        return [json.dumps(state.gateway_snapshot(), indent=2)]
    if intent == "new_session":
        if gw is None:
            return ["no gateway session"]
        gw.session = ""
        gw.user_id = ""
        state.pending_new_session = True
        return ["new thread on next agent message"]
    if intent == "provider":
        if gw is None:
            return ["no gateway session"]
        gw.provider = payload
        gw._save_prefs()
        return [f"provider={gw.provider}"]
    if intent == "health":
        if gw is None:
            return ["no gateway session"]
        try:
            return [json.dumps(gw.health(), indent=2)]
        except Exception as exc:
            return [f"health error: {exc}"]
    if intent == "modules":
        return [harness_flag("--list-modules")]
    if intent == "providers":
        return [harness_flag("--list-providers")]
    if intent == "tools":
        return [harness_flag("--list-tools")]
    return []
