"""Klanker CLI — Entry point for the Slimemold Agent."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

from .nucleus import Nucleus
from .sensing import probe_host

log = logging.getLogger("klanker")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="klanker",
        description="Klanker — Adaptive Agent Shell on the Lolaplex Suite",
    )
    parser.add_argument("--user", type=str, default="user", help="User alias")
    parser.add_argument("--provider", type=str, default=None, help="LLM provider")

    sub = parser.add_subparsers(dest="command")

    # 1. Sense host capabilities
    sense_p = sub.add_parser("sense", help="Probe host environment and available feelers")
    sense_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 1b. Dump system prompt
    sub.add_parser("prompt", help="Print the dynamic Klanker system prompt")

    # 2. Interactive or one-turn chat (alias)
    chat_p = sub.add_parser("chat", help="Chat with Klanker (spawns harness turn)")
    chat_p.add_argument("message", type=str, nargs="?", default="", help="Message content")
    chat_p.add_argument("--user", type=str, default="user", help="User alias")
    chat_p.add_argument("--provider", type=str, default=None, help="LLM provider")

    # 3. Serve gateway
    serve_p = sub.add_parser("serve", help="Start I/O Gateway (HTTP /v1/turn & Telegram)")
    serve_p.add_argument("--no-telegram", action="store_true", help="Disable Telegram polling")

    # 4. Run background cron / scheduled flows
    cron_p = sub.add_parser("cron", help="Run scheduled care flows via harness executor")
    cron_p.add_argument("--flow", type=str, default="", help="Run specific flow name")

    return parser


def run_repl(nucleus: Nucleus, *, user: str = "user", provider: str | None = None) -> int:
    """Run an interactive multi-turn REPL loop retaining conversation session."""
    import uuid
    session_id = f"ses_{uuid.uuid4().hex[:12]}"
    print("klanker (v0.0.1) — interactive chat. Type 'exit' or Ctrl+C to quit.\n")

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

        nucleus.run_turn(message=prompt, user=user, session=session_id, provider=provider)
        print()

    return 0


KNOWN_SUBCOMMANDS = {"sense", "prompt", "serve", "cron", "chat", "-h", "--help"}


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
    args, direct_prompt = parse_cli_args(argv)
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

    elif args.command == "serve":
        if not nucleus.caps.has_gateway:
            print("Error: agents-gateway is not installed. Install via pip install agents-gateway", file=sys.stderr)
            return 1

        # If LOOP_CMD is default and harness is present, inject Klanker's dynamic system prompt
        if "LOOP_CMD" not in os.environ and nucleus.caps.has_harness:
            from .prompt import save_system_prompt
            prompt_file = save_system_prompt(nucleus.caps)
            os.environ["LOOP_CMD"] = f"python -m runner.loop --system {prompt_file.as_posix()}"

        from agents_gateway.__main__ import main as gateway_main
        sub_argv = ["serve"]
        if getattr(args, "no_telegram", False):
            sub_argv.append("--no-telegram")
        return gateway_main(sub_argv)

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

        if msg:
            return nucleus.run_turn(message=msg, user=user, provider=provider)

        # If piped input via stdin (e.g. echo "hi" | klanker)
        if not sys.stdin.isatty():
            piped_msg = sys.stdin.read().strip()
            if piped_msg:
                return nucleus.run_turn(message=piped_msg, user=user, provider=provider)
            return 0

        # Interactive REPL
        return run_repl(nucleus, user=user, provider=provider)


if __name__ == "__main__":
    raise SystemExit(main())
