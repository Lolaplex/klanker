"""Klanker reminder add: Telegram delivery via agents-relay send."""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from typing import Any


def build_send_verb(user: str, text: str) -> str:
    return (
        "python -m agents_relay send "
        f"--user {shlex.quote(str(user))} --text {shlex.quote(str(text))}"
    )


def add_reminder(
    *,
    at: str | None = None,
    text: str = "",
    user: str = "",
    name: str = "",
    cron: str = "",
    timezone_name: str = "",
    one_shot: bool | None = None,
) -> dict[str, Any]:
    if not (text or "").strip():
        raise ValueError("text is required")
    if not (user or "").strip():
        raise ValueError("user is required")
    from runner.schedule import add_schedule

    shot = True if at and one_shot is None else bool(one_shot)
    return add_schedule(
        name=name or None,
        at=at,
        cron=cron or None,
        text=text,
        channel="telegram",
        user=user,
        timezone_name=timezone_name,
        verb=build_send_verb(user, text),
        one_shot=shot,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="klanker remind")
    sub = parser.add_subparsers(dest="remind_cmd")
    add_p = sub.add_parser("add", help="Add a Telegram one-shot or cron reminder")
    add_p.add_argument("--at", default="", help="Due time ISO or relative (+10m)")
    add_p.add_argument("--text", default="", help="Message body")
    add_p.add_argument("--user", default="", help="Telegram chat id")
    add_p.add_argument("--name", default="", help="Optional slug")
    add_p.add_argument("--cron", default="", help="Optional 5-part cron")
    add_p.add_argument("--timezone", default="", dest="timezone_name")
    add_p.add_argument("--prompt", default="", help="Routine prompt (full LLM turn) instead of fixed text")
    add_p.add_argument("--timeout", type=int, default=300, dest="timeout_sec")
    add_p.add_argument("--one-shot", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.remind_cmd != "add":
        parser.print_help()
        return 2
    try:
        if (args.prompt or "").strip():
            if (args.text or "").strip():
                print("Error: pass either --text or --prompt", file=sys.stderr)
                return 2
            from .routine import add_routine

            row = add_routine(
                name=args.name,
                prompt=args.prompt,
                user=args.user,
                at=args.at or None,
                cron=args.cron or None,
                timezone_name=args.timezone_name,
                timeout_sec=args.timeout_sec,
            )
        else:
            row = add_reminder(
                at=args.at or None,
                text=args.text,
                user=args.user,
                name=args.name,
                cron=args.cron,
                timezone_name=args.timezone_name,
                one_shot=True if args.one_shot else None,
            )
    except Exception as exc:
        print(f"Error adding reminder: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(row, indent=2, ensure_ascii=False))
    return 0
