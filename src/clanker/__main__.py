"""Clanker CLI — Entry point for the Slimemold Agent."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys

from .nucleus import Nucleus
from .sensing import probe_host

log = logging.getLogger("clanker")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="clanker", description="Clanker — Universal Adaptive Slimemold AI Agent")
    sub = parser.add_subparsers(dest="command")

    # 1. Sense host capabilities
    sense_p = sub.add_parser("sense", help="Probe host environment and available plugs")
    sense_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 2. Interactive or one-turn chat
    chat_p = sub.add_parser("chat", help="Chat with Clanker (spawns harness turn)")
    chat_p.add_argument("message", type=str, nargs="?", default="", help="Message content (or interactive if omitted)")
    chat_p.add_argument("--user", type=str, default="user", help="User alias")
    chat_p.add_argument("--provider", type=str, default=None, help="LLM provider")

    # 3. Serve gateway
    serve_p = sub.add_parser("serve", help="Start I/O Gateway (HTTP /v1/turn & Telegram)")
    serve_p.add_argument("--no-telegram", action="store_true", help="Disable Telegram polling")

    # 4. Run background cron / scheduled flows
    cron_p = sub.add_parser("cron", help="Run scheduled care flows via harness executor")
    cron_p.add_argument("--flow", type=str, default="", help="Run specific flow name")

    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = build_parser().parse_args(argv)
    nucleus = Nucleus()

    if args.command == "sense":
        summary = nucleus.sense()
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print("Clanker Host Sensing:")
            for k, v in summary.items():
                print(f"  * {k}: {v}")
        return 0

    elif args.command == "chat":
        msg = args.message
        if not msg:
            if not sys.stdin.isatty():
                msg = sys.stdin.read().strip()
            else:
                try:
                    msg = input("clanker> ").strip()
                except (EOFError, KeyboardInterrupt):
                    return 0
        if not msg:
            return 0
        return nucleus.run_turn(message=msg, user=args.user, provider=args.provider)

    elif args.command == "serve":
        if not nucleus.caps.has_gateway:
            print("Error: agents-gateway is not installed. Install via pip install agents-gateway", file=sys.stderr)
            return 1
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
        build_parser().print_help()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
