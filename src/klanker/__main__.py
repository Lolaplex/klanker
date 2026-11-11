"""Klanker CLI."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .nucleus import Nucleus
from .sensing import probe_host

log = logging.getLogger("klanker")


def note_custom_loop_cmd() -> None:
    """A pre-set LOOP_CMD skips Klanker's prompt file and ``klanker.turn`` shims."""
    custom = os.environ.get("LOOP_CMD", "").strip()
    if not custom:
        return
    log.warning(
        "LOOP_CMD=%s bypasses Klanker's system prompt and argv shims (klanker.turn)",
        custom,
    )


def apply_workdir(raw: str | None) -> int | None:
    """Point this process and its spawned turns at a working directory.

    ``--workdir`` is the session cwd/jail (``AGENTS_WORKDIR``). Returns an
    exit code when the path is unusable, otherwise ``None``.
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        resolved = Path(text).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        print(f"Error: workdir does not exist: {text}", file=sys.stderr)
        return 2
    if not resolved.is_dir():
        print(f"Error: workdir is not a directory: {text}", file=sys.stderr)
        return 2
    os.environ["AGENTS_WORKDIR"] = str(resolved)
    os.environ["AGENTS_WORKDIR_LOCK"] = "1"
    return None


def apply_workspace(raw: str | None) -> int | None:
    """Select the data workspace by id (``AGENTS_WORKSPACE=<id>``).

    An existing directory is accepted one release as the old workdir meaning
    (``--workdir`` now), with a deprecation warning.
    """
    text = (raw or "").strip()
    if not text:
        return None
    import warnings

    from agents_workspace import Host

    host = Host.from_env()
    if host.workspace_exists(text):
        os.environ["AGENTS_WORKSPACE"] = text
        return None
    candidate = Path(text).expanduser()
    if candidate.is_dir():
        warnings.warn(
            "--workspace <dir> is deprecated as a workdir; "
            "use --workdir for a directory and --workspace <id> for a "
            "data workspace (alias removed after one release)",
            DeprecationWarning,
        )
        os.environ["AGENTS_WORKDIR"] = str(candidate.resolve())
        os.environ["AGENTS_WORKDIR_LOCK"] = "1"
        return None
    print(f"Error: unknown workspace id: {text}", file=sys.stderr)
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="klanker",
        description="Klanker — Adaptive Agent Shell",
    )
    parser.add_argument("--user", type=str, default="user", help="User alias")
    parser.add_argument("--provider", type=str, default=None, help="LLM provider")
    parser.add_argument("--seal", action="store_true", help="Cryptographically seal tool trace records")
    parser.add_argument(
        "--workspace",
        default=None,
        help="Data workspace id (AGENTS_WORKSPACE); a directory is accepted once as deprecated --workdir alias",
    )
    parser.add_argument(
        "--workdir",
        default=None,
        help="Working directory for this session and spawned turns (AGENTS_WORKDIR)",
    )

    sub = parser.add_subparsers(dest="command")

    # 1. Sense host capabilities
    sense_p = sub.add_parser("sense", help="Probe host environment and available feelers")
    sense_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 1b. Dump system prompt
    prompt_p = sub.add_parser("prompt", help="Print the dynamic Klanker system prompt")
    prompt_p.add_argument(
        "--workspace",
        default=None,
        help="Data workspace id (AGENTS_WORKSPACE)",
    )

    # 1c. Audit trace integrity & replay
    audit_p = sub.add_parser("audit", help="Audit trace integrity and replay verification via agents-traces")
    audit_p.add_argument("target", type=str, nargs="?", default="", help="Session ID, trace file path, or empty for all")
    audit_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 2. Interactive or one-turn chat (alias)
    chat_p = sub.add_parser("chat", help="Chat with Klanker (spawns harness turn)")
    chat_p.add_argument("message", type=str, nargs="?", default="", help="Message content")
    chat_p.add_argument("--user", type=str, default="user", help="User alias")
    chat_p.add_argument("--provider", type=str, default=None, help="LLM provider")
    chat_p.add_argument("--seal", action="store_true", help="Cryptographically seal tool trace records")
    chat_p.add_argument(
        "--workspace",
        default=None,
        help="Data workspace id (AGENTS_WORKSPACE)",
    )
    chat_p.add_argument(
        "--workdir",
        default=None,
        help="Working directory for the spawned turn (AGENTS_WORKDIR)",
    )
    chat_p.add_argument(
        "--persona",
        default="",
        help="Persona id for this turn (<ws>/personas/<id> or package; default: AGENTS_PERSONA or ws default_persona)",
    )

    # 3. Serve gateway
    serve_p = sub.add_parser("serve", help="Start I/O Gateway (HTTP /v1/turn & Telegram)")
    serve_p.add_argument("--no-telegram", action="store_true", help="Disable Telegram polling")

    # 3b. Interactive agent shell (client of a running relay)
    shell_p = sub.add_parser("shell", help="Interactive shell — builtins, exec, agent tier via relay")
    shell_p.add_argument("--plain", action="store_true", help="Force line-based UI (no TUI)")
    shell_p.add_argument("--stream", action="store_true", help="Stream agent replies (SSE /v1/stream)")
    shell_p.add_argument("--url", default="http://127.0.0.1:8787", help="Relay base URL")
    shell_p.add_argument("--secret", default="", help="Relay secret (X-Gateway-Secret)")
    shell_p.add_argument("--user", type=str, default="local", help="User alias")
    shell_p.add_argument("--project", type=str, default="", help="Project name")
    shell_p.add_argument("--provider", type=str, default="", help="LLM provider")
    shell_p.add_argument("--persona", type=str, default="default", help="Persona")
    shell_p.add_argument("--session", type=str, default="", help="Resume session id")
    shell_p.add_argument("--workspace", type=str, default="", help="Data workspace id (AGENTS_WORKSPACE)")
    shell_p.add_argument("--no-gateway", action="store_true", help="Builtins/exec only, no agent tier")

    # 3c. Stop the local daemon
    sub.add_parser("stop", help="Stop the local klanker daemon (pid file)")

    # 3d. Personas (equal, workspace-scoped)
    persona_p = sub.add_parser("persona", help="List or add personas in a workspace")
    persona_sub = persona_p.add_subparsers(dest="persona_cmd")
    persona_list = persona_sub.add_parser("list", help="List personas in the workspace")
    persona_list.add_argument("--workspace", default="", help="Data workspace id")
    persona_add = persona_sub.add_parser("add", help="Add an equal persona")
    persona_add.add_argument("id", help="Persona id (ids only: no paths, no labels)")
    persona_add.add_argument("--workspace", default="", help="Data workspace id")
    persona_add.add_argument("--role", default="", help="Role description (text, not a layer)")
    persona_add.add_argument("--system-append", default="", dest="system_append", help="System prompt fragment")

    # 4. Run background cron / scheduled flows
    cron_p = sub.add_parser("cron", help="Run scheduled care flows via harness executor")
    cron_p.add_argument("--flow", type=str, default="", help="Run specific flow name")

    # 5. LLM routines (scheduled turns)
    routine_p = sub.add_parser("routine", help="Manage LLM routines (scheduled full turns)")
    routine_sub = routine_p.add_subparsers(dest="routine_cmd")
    routine_add = routine_sub.add_parser("add", help="Add a routine")
    routine_add.add_argument("--name", default="")
    routine_add.add_argument("--prompt", default="")
    routine_add.add_argument("--user", default="")
    routine_add.add_argument("--channel", default="", help="Originating channel (http, telegram, local, …)")
    routine_add.add_argument("--at", default="")
    routine_add.add_argument("--cron", default="")
    routine_add.add_argument("--timezone", default="", dest="timezone_name")
    routine_add.add_argument("--timeout", type=int, default=None, dest="timeout_sec", help="Job timeout in seconds (default: approval wait + 330s)")
    routine_add.add_argument("--workspace", default="", help="Workspace id")
    routine_say = routine_sub.add_parser("say", help="Create a routine from one sentence plus --at or --cron")
    routine_say.add_argument("prompt", help="Prompt sentence")
    routine_say.add_argument("--name", default="")
    routine_say.add_argument("--user", default="", help="Target user (default: KLANKER_USER or local)")
    routine_say.add_argument("--channel", default="", help="Originating channel (http, telegram, local, …)")
    routine_say.add_argument("--at", default="", help="Due time ISO or relative (+10m)")
    routine_say.add_argument("--cron", default="")
    routine_say.add_argument("--timezone", default="", dest="timezone_name")
    routine_say.add_argument("--timeout", type=int, default=None, dest="timeout_sec")
    routine_say.add_argument("--workspace", default="", help="Workspace id")
    routine_sub.add_parser("list", help="List routines")
    routine_pause = routine_sub.add_parser("pause", help="Keep a routine and stop it firing")
    routine_pause.add_argument("name")
    routine_resume = routine_sub.add_parser("resume", help="Let a paused routine fire again")
    routine_resume.add_argument("name")
    routine_rm = routine_sub.add_parser("remove", help="Remove a routine")
    routine_rm.add_argument("name")
    routine_run = routine_sub.add_parser("run", help="Run a routine now")
    routine_run.add_argument("name")
    routine_run.add_argument("--scheduled", action="store_true", help="Respect same-minute dedupe (ticker path)")
    routine_run.add_argument("--force", action="store_true", help="Run even if this minute already ran")

    evidence_p = sub.add_parser(
        "evidence",
        help="List routine outputs and workspace files by day (read-only)",
    )
    evidence_p.add_argument("--from", dest="date_from", required=True, help="First day YYYY-MM-DD (inclusive)")
    evidence_p.add_argument("--to", dest="date_to", required=True, help="Last day YYYY-MM-DD (inclusive)")
    evidence_p.add_argument("--json", action="store_true", help="Print the coverage report as JSON")
    evidence_p.add_argument(
        "--root",
        action="append",
        default=[],
        help="Extra directory to scan (repeatable). Does not search memory or traces.",
    )

    return parser


KNOWN_SUBCOMMANDS = {
    "sense",
    "prompt",
    "serve",
    "shell",
    "stop",
    "cron",
    "chat",
    "remind",
    "audit",
    "routine",
    "evidence",
    "persona",
    "-h",
    "--help",
}


def parse_cli_args(argv: list[str] | None = None) -> tuple[argparse.Namespace, str]:
    """Parse CLI arguments allowing both subcommands and direct prompts."""
    raw_args = list(sys.argv[1:] if argv is None else argv)
    direct_prompt = ""

    # If first positional argument is not a known subcommand or flag, treat it as direct prompt
    if raw_args and not raw_args[0].startswith("-") and raw_args[0] not in KNOWN_SUBCOMMANDS:
        direct_prompt = raw_args.pop(0)

    parser = build_parser()
    parsed = parser.parse_args(raw_args)
    return parsed, direct_prompt


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] == "remind":
        from .overlay import install_overlay
        from . import remind
        install_overlay(generate=False)
        return remind.main(raw[1:])
    args, direct_prompt = parse_cli_args(argv)
    workspace_error = apply_workspace(getattr(args, "workspace", None))
    if workspace_error is not None:
        return workspace_error
    workdir_error = apply_workdir(getattr(args, "workdir", None))
    if workdir_error is not None:
        return workdir_error
    try:
        from . import __version__
        from .updates import check_for_updates
        check_for_updates("klanker", __version__)
    except Exception:
        pass
    nucleus = Nucleus()

    if args.command == "sense":
        summary = nucleus.sense()
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print("Klanker Host Sensing:")
            for k, v in summary.items():
                print(f"  * {k}: {v}")
        return 0

    elif args.command == "prompt":
        from .prompt import build_system_prompt
        print(build_system_prompt(nucleus.caps))
        return 0

    elif args.command == "persona":
        from agents_workspace import Host
        from agents_relay.workspaces import create_persona, list_personas

        host = Host.from_env()
        ws_ref = getattr(args, "workspace", "") or ""
        if ws_ref and not host.workspace_exists(ws_ref):
            print(f"Error: unknown workspace: {ws_ref}", file=sys.stderr)
            return 2
        try:
            ws = host.workspace(ws_ref) if ws_ref else host.select_workspace()
        except (KeyError, ValueError, RuntimeError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2
        if getattr(args, "persona_cmd", "") == "add":
            pid = args.id.strip()
            from agents_relay.turn import valid_id
            if not valid_id(pid):
                print(f"Error: invalid persona id: {pid!r}", file=sys.stderr)
                return 2
            row = create_persona(ws, pid, {
                "role": getattr(args, "role", "") or "",
                "system_append": getattr(args, "system_append", "") or "",
            })
            print(f"persona {pid} added to workspace {ws.id}")
            return 0
        rows = list_personas(ws)
        for row in rows:
            rid = row.get("id", "?")
            role = row.get("role") or ""
            suffix = f" — {role}" if role else ""
            print(f"{rid}{suffix}")
        return 0

    elif args.command == "audit":
        if not nucleus.caps.has_traces:
            print("Error: agents-traces is not installed. Install via pip install agents-traces", file=sys.stderr)
            return 1
        from agents_traces.__main__ import main as traces_main
        sub_argv = ["audit"]
        if getattr(args, "target", ""):
            sub_argv.append(args.target)
        if getattr(args, "json", False):
            sub_argv.append("--json")
        return traces_main(sub_argv)

    elif args.command == "serve":
        if not (nucleus.caps.has_relay or nucleus.caps.has_gateway):
            print("Error: agents-relay is not installed. Install via pip install agents-relay", file=sys.stderr)
            return 1

        from agents_workspace import Host, Workspace

        from .gating import apply_approval_env, telegram_refusal, telegram_would_poll
        from .overlay import ensure_workspace_overlay

        refusal = telegram_refusal(no_telegram=bool(getattr(args, "no_telegram", False)))
        if refusal:
            print(f"Error: {refusal}", file=sys.stderr)
            return 1

        host = Host.from_env()
        if host.has_legacy_layout():
            print(
                "Error: legacy host layout detected. Run "
                "`agents-workspace migrate` first (explicit, one-shot).",
                file=sys.stderr,
            )
            return 1

        entry_ws = Workspace.from_env()
        entry_ws.ensure()
        for _ws in Workspace.list_all():
            ensure_workspace_overlay(_ws)
        # Children spawned without an explicit workspace inherit this
        # workspace's context; per-request turns override it via ws.env().
        os.environ.update(entry_ws.env())
        telegram_on = telegram_would_poll(no_telegram=bool(getattr(args, "no_telegram", False)))
        apply_approval_env(telegram=telegram_on)

        # If LOOP_CMD is default and harness is present, inject Klanker's dynamic system prompt.
        # klanker.turn installs argv shims, then runs runner.loop.
        note_custom_loop_cmd()
        if "LOOP_CMD" not in os.environ and nucleus.caps.has_harness:
            from .prompt import save_system_prompt

            prompt_file = save_system_prompt(nucleus.caps, workspace=entry_ws)
            os.environ["LOOP_CMD"] = f"{sys.executable} -m klanker.turn --system {prompt_file.as_posix()}"

        if nucleus.caps.has_harness:
            from .routine import start_ticker

            start_ticker()

        try:
            from agents_relay.__main__ import main as relay_main
        except ImportError:
            from agents_gateway.__main__ import main as relay_main
        sub_argv = ["serve"]
        if getattr(args, "no_telegram", False):
            sub_argv.append("--no-telegram")

        from . import daemon as _daemon

        pid_path = _daemon.daemon_pid_path()
        pid_path.parent.mkdir(parents=True, exist_ok=True)
        pid_path.write_text(str(os.getpid()), encoding="utf-8")
        try:
            return relay_main(sub_argv)
        finally:
            _daemon.release_pid_file(pid_path, os.getpid())

    elif args.command == "routine":
        from .routine import dispatch

        return dispatch(args)

    elif args.command == "evidence":
        from .evidence import run_evidence

        return run_evidence(args)

    elif args.command == "stop":
        from . import daemon as _daemon

        return _daemon.stop_daemon()

    elif args.command == "shell":
        from . import daemon as _daemon
        from .shell.repl.loop import run_interactive_shell

        url = getattr(args, "url", "http://127.0.0.1:8787") or "http://127.0.0.1:8787"
        if not getattr(args, "no_gateway", False) and _daemon._is_loopback(url):
            if not _daemon.relay_health(url) and _daemon.ensure_daemon(url):
                print(f"klanker daemon started at {url}")
            elif not _daemon.relay_health(url):
                print(
                    f"warning: no relay at {url} — agent tier unavailable",
                    file=sys.stderr,
                )
        return run_interactive_shell(
            plain=bool(getattr(args, "plain", False)),
            stream=bool(getattr(args, "stream", False)),
            url=url,
            secret=getattr(args, "secret", "") or "",
            user=getattr(args, "user", "local") or "local",
            project=getattr(args, "project", "") or "",
            provider=getattr(args, "provider", "") or "",
            persona=getattr(args, "persona", "default") or "default",
            session=getattr(args, "session", "") or "",
            workspace=getattr(args, "workspace", "") or "",
            no_gateway=bool(getattr(args, "no_gateway", False)),
        )

    elif args.command == "cron":
        if not nucleus.caps.has_harness:
            print("Error: agents-harness is not installed. Install via pip install agents-harness", file=sys.stderr)
            return 1
        from runner.executor import main as executor_main
        if args.flow:
            return executor_main(["--run", args.flow])
        return executor_main(["--all"])

    else:
        # Chat mode: either explicit 'chat', direct prompt argument, stdin pipe, or interactive REPL
        msg = direct_prompt or getattr(args, "message", None) or ""
        user = getattr(args, "user", "user")
        provider = getattr(args, "provider", None)
        seal = getattr(args, "seal", False)

        if msg:
            from .overlay import ensure_default_overlay

            ensure_default_overlay()
            cli_workdir = os.environ.get("AGENTS_WORKDIR", "") or os.getcwd()
            return nucleus.run_turn(
                message=msg, user=user, provider=provider, seal=seal,
                workdir=cli_workdir,
                persona=getattr(args, "persona", "") or "",
            )

        # If piped input via stdin (e.g. echo "hi" | klanker)
        if not sys.stdin.isatty():
            piped_msg = sys.stdin.read().strip()
            if piped_msg:
                from .overlay import ensure_default_overlay

                ensure_default_overlay()
                cli_workdir = os.environ.get("AGENTS_WORKDIR", "") or os.getcwd()
                return nucleus.run_turn(
                    message=piped_msg, user=user, provider=provider, seal=seal,
                    workdir=cli_workdir,
                )
            return 0

        # Interactive shell: ensure local daemon, then agent shell client
        from . import daemon as _daemon
        from .overlay import ensure_default_overlay
        from .shell.repl.loop import run_interactive_shell

        ensure_default_overlay()
        url = _daemon.DEFAULT_RELAY_URL
        if not _daemon.relay_health(url):
            if _daemon.ensure_daemon(url):
                print(f"klanker daemon started at {url}")
            else:
                print(
                    f"warning: no relay at {url} — agent tier unavailable",
                    file=sys.stderr,
                )
        elif getattr(args, "workspace", None):
            print(
                "warning: the running daemon keeps its own workspace settings; "
                "`klanker stop` then retry to apply --workspace",
                file=sys.stderr,
            )
        rc = run_interactive_shell(
            user=user,
            provider=provider or "",
            workspace=getattr(args, "workspace", "") or "",
        )
        if _daemon.relay_health(url):
            print(f"\ndaemon still running at {url} — `klanker stop` to halt")
        return rc


if __name__ == "__main__":
    raise SystemExit(main())
