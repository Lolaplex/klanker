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


PLAN_INSTRUCTION = (
    "PLAN MODE — inspect the context read-only: no file edits, no mutating "
    "commands. Write a markdown implementation plan to plans/<slug>.md "
    "(create the directory if needed) and reply with the plan path plus a "
    "short summary.\n\n"
)


def agent_turn(state: ShellState, message: str) -> list[str]:
    gw = state.gateway
    if gw is None:
        return ["agent tier unavailable (install agents-relay and pass --url)"]
    if state.plan_mode and not message.startswith(PLAN_INSTRUCTION):
        message = PLAN_INSTRUCTION + message
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
            ":usage :insights [days]  (traces; /usage /insights)",
            ":plan [goal]  plan-mode toggle or one-shot plan (/plan)",
            ":persona [id]  show or switch persona (saved per channel)",
            ":workspace [id]  list or switch workspace (saved per channel)",
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
    if intent == "usage":
        from ..stats import usage_lines

        session = gw.session if gw is not None else ""
        return usage_lines(session)
    if intent == "insights":
        from ..stats import insights_lines

        try:
            days = int(payload) if payload else 7
        except ValueError:
            return [f"insights: invalid days: {payload!r}"]
        return insights_lines(days)
    if intent == "plan":
        if not payload:
            state.plan_mode = not state.plan_mode
            return [f"plan mode {'on' if state.plan_mode else 'off'}"]
        if state.plan_mode:
            return agent_turn(state, payload)
        return agent_turn(state, PLAN_INSTRUCTION + payload)
    if intent == "workspace":
        if gw is None:
            return ["no gateway session"]
        try:
            rows = gw.workspaces()
        except Exception as exc:
            return [f"workspaces error: {exc}"]
        if not payload:
            active = gw.workspace or ""
            out = [f"workspace={active or '(env default)'}"]
            for row in rows:
                rid = str(row.get("id") or "?")
                mark = "*" if rid == active else " "
                wd = str(row.get("workdir") or "")
                out.append(f" {mark} {rid}{f' — {wd}' if wd else ''}")
            if not rows:
                out.append("  (relay returned no workspace rows)")
            return out
        match = next(
            (r for r in rows if str(r.get("id") or "") == payload), None
        )
        if match is None:
            known = ", ".join(str(r.get("id") or "?") for r in rows) or "none"
            return [f"unknown workspace: {payload} (known: {known})"]
        gw.workspace = payload
        wd = str(match.get("workdir") or "").strip()
        if wd:
            gw.workdir = wd
        gw._save_prefs()
        out = [f"workspace={gw.workspace} (channel default saved)"]
        if wd:
            out.append(f"workdir={gw.workdir}")
        return out
    if intent == "persona":
        if gw is None:
            return ["no gateway session"]
        if not payload:
            rows = [f"persona={gw.persona or '(default)'}"]
            try:
                from agents_relay.workspaces import list_personas
                from agents_workspace import Workspace

                for row in list_personas(Workspace.from_env()):
                    rid = row.get("id", "?")
                    role = row.get("role") or ""
                    rows.append(f"  {rid}{f' — {role}' if role else ''}")
            except Exception:
                pass
            return rows
        gw.persona = payload
        gw._save_prefs()
        return [f"persona={gw.persona} (channel default saved)"]
    return []
