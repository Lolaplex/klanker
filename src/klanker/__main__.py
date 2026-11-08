"""Klanker CLI."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="klanker",
        description="Klanker — Adaptive Agent Shell",
    )
    parser.add_argument("--user", type=str, default="user", help="User alias")
    parser.add_argument("--provider", type=str, default=None, help="LLM provider")
    parser.add_argument("--seal", action="store_true", help="Cryptographically seal tool trace records")

    sub = parser.add_subparsers(dest="command")

    # 1. Sense host capabilities
    sense_p = sub.add_parser("sense", help="Probe host environment and available feelers")
    sense_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 1b. Dump system prompt
    sub.add_parser("prompt", help="Print the dynamic Klanker system prompt")

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
    shell_p.add_argument("--no-gateway", action="store_true", help="Builtins/exec only, no agent tier")

    # 3c. Stop the local daemon
    sub.add_parser("stop", help="Stop the local klanker daemon (pid file)")

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
    routine_say = routine_sub.add_parser("say", help="Create a routine from one sentence plus --at or --cron")
    routine_say.add_argument("prompt", help="Prompt sentence")
    routine_say.add_argument("--name", default="")
    routine_say.add_argument("--user", default="", help="Target user (default: KLANKER_USER or local)")
    routine_say.add_argument("--channel", default="", help="Originating channel (http, telegram, local, …)")
    routine_say.add_argument("--at", default="", help="Due time ISO or relative (+10m)")
    routine_say.add_argument("--cron", default="")
    routine_say.add_argument("--timezone", default="", dest="timezone_name")
    routine_say.add_argument("--timeout", type=int, default=None, dest="timeout_sec")
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

        from .gating import apply_approval_env, telegram_refusal, telegram_would_poll
        from .overlay import ensure_default_overlay, publish_modules_dir

        refusal = telegram_refusal(no_telegram=bool(getattr(args, "no_telegram", False)))
        if refusal:
            print(f"Error: {refusal}", file=sys.stderr)
            return 1

        publish_modules_dir()
        ensure_default_overlay()
        telegram_on = telegram_would_poll(no_telegram=bool(getattr(args, "no_telegram", False)))
        apply_approval_env(telegram=telegram_on)
        # HTTP is always on under serve. A turn overwrites KLANKER_CHANNEL from --channel.
        os.environ.setdefault("KLANKER_CHANNEL", "http")

        # If LOOP_CMD is default and harness is present, inject Klanker's dynamic system prompt.
        # klanker.turn installs argv shims, then runs runner.loop.
        note_custom_loop_cmd()
        if "LOOP_CMD" not in os.environ and nucleus.caps.has_harness:
            from .prompt import save_system_prompt

            prompt_file = save_system_prompt(nucleus.caps)
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
            return nucleus.run_turn(message=msg, user=user, provider=provider, seal=seal)

        # If piped input via stdin (e.g. echo "hi" | klanker)
        if not sys.stdin.isatty():
            piped_msg = sys.stdin.read().strip()
            if piped_msg:
                from .overlay import ensure_default_overlay

                ensure_default_overlay()
                return nucleus.run_turn(message=piped_msg, user=user, provider=provider, seal=seal)
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
        rc = run_interactive_shell(
            user=user,
            provider=provider or "",
        )
        if _daemon.relay_health(url):
            print(f"\ndaemon still running at {url} — `klanker stop` to halt")
        return rc


if __name__ == "__main__":
    raise SystemExit(main())
