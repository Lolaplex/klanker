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
        description="Klanker — Adaptive Agent Shell on the Lolaplex Suite",
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
    routine_add.add_argument("--timeout", type=int, default=300, dest="timeout_sec")
    routine_sub.add_parser("list", help="List routines")
    routine_rm = routine_sub.add_parser("remove", help="Remove a routine")
    routine_rm.add_argument("name")
    routine_run = routine_sub.add_parser("run", help="Run a routine now")
    routine_run.add_argument("name")
    routine_run.add_argument("--scheduled", action="store_true", help="Respect same-minute dedupe (ticker path)")
    routine_run.add_argument("--force", action="store_true", help="Run even if this minute already ran")

    return parser


def run_repl(
    nucleus: Nucleus,
    *,
    user: str = "user",
    provider: str | None = None,
    seal: bool = False,
) -> int:
    """Run an interactive multi-turn REPL loop retaining conversation session."""
    import uuid
    from . import __version__
    session_id = f"ses_{uuid.uuid4().hex[:12]}"
    print(f"klanker (v{__version__}) — interactive chat. Type 'exit' or Ctrl+C to quit.\n")

    while True:
        try:
            prompt = input("klanker> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not prompt:
            continue
        if prompt.lower() in ("exit", "quit", ":q"):
            break

        nucleus.run_turn(
            message=prompt,
            user=user,
            session=session_id,
            provider=provider,
            seal=seal,
        )
        print()

    return 0


KNOWN_SUBCOMMANDS = {"sense", "prompt", "serve", "cron", "chat", "remind", "audit", "routine", "-h", "--help"}


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
            os.environ["LOOP_CMD"] = f"python -m klanker.turn --system {prompt_file.as_posix()}"

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
        return relay_main(sub_argv)

    elif args.command == "routine":
        from .routine import dispatch

        return dispatch(args)

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

        # Interactive REPL
        from .overlay import ensure_default_overlay

        ensure_default_overlay()
        return run_repl(nucleus, user=user, provider=provider, seal=seal)


if __name__ == "__main__":
    raise SystemExit(main())
