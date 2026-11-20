"""Route a line: builtin → exec → agent."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from .parse import ParsedLine, parse_line


@dataclass(frozen=True)
class ResolveResult:
    route: str  # empty | builtin | exec | agent
    intent: str = ""
    argv: tuple[str, ...] = ()
    segments: tuple[tuple[str, ...], ...] = ()
    payload: str = ""
    message: str = ""


def _looks_like_path(token: str) -> bool:
    return "/" in token or "\\" in token or token.startswith(".")


def _executable(argv: tuple[str, ...], env: dict[str, str]) -> bool:
    if not argv:
        return False
    head = argv[0]
    if _looks_like_path(head):
        p = Path(head)
        return p.is_file() or (p.suffix.lower() in {".exe", ".cmd", ".bat", ".com"} and p.exists())
    path = env.get("PATH", os.environ.get("PATH", ""))
    return shutil.which(head, path=path) is not None


def resolve_line(line: str, *, env: dict[str, str]) -> ResolveResult:
    text = line.strip()
    if not text:
        return ResolveResult(route="empty")

    # Klanker meta commands (colon namespace; slash alias for known names)
    if text.startswith(":"):
        return _resolve_meta(text)
    if text.startswith("/"):
        head, _, rest = text[1:].partition(" ")
        if head in SLASH_COMMANDS:
            return _resolve_meta(":" + head + (" " + rest if rest else ""))

    try:
        parsed = parse_line(text)
    except ValueError as exc:
        return ResolveResult(route="builtin", intent="error", message=str(exc))

    if not parsed.segments:
        return ResolveResult(route="empty")

    if len(parsed.segments) > 1:
        if all(_executable(seg, env) for seg in parsed.segments):
            return ResolveResult(route="exec", segments=parsed.segments)
        return ResolveResult(
            route="builtin",
            intent="error",
            message="pipeline requires every command to exist on PATH",
        )

    argv = parsed.segments[0]
    head = argv[0].lower() if argv else ""

    if head in {"cd", "pwd", "exit", "quit", "help", "?"}:
        return ResolveResult(route="builtin", intent=head, argv=argv, payload=text)

    if _executable(argv, env):
        return ResolveResult(route="exec", argv=argv, segments=parsed.segments)

    return ResolveResult(route="agent", payload=text)


SLASH_COMMANDS = frozenset({
    "usage",
    "insights",
    "plan",
    "persona",
    "session",
    "new-session",
    "provider",
    "health",
    "modules",
    "providers",
    "tools",
    "turn",
    "help",
    "quit",
    "q",
})


def _resolve_meta(text: str) -> ResolveResult:
    if text in (":quit", ":q", "exit"):
        return ResolveResult(route="builtin", intent="exit")
    if text in (":help", ":h", "?"):
        return ResolveResult(route="builtin", intent="help")
    if text == ":session":
        return ResolveResult(route="builtin", intent="session")
    if text == ":new-session":
        return ResolveResult(route="builtin", intent="new_session")
    if text.startswith(":provider "):
        return ResolveResult(route="builtin", intent="provider", payload=text.split(" ", 1)[1].strip())
    if text.startswith(":health"):
        return ResolveResult(route="builtin", intent="health")
    if text == ":modules":
        return ResolveResult(route="builtin", intent="modules")
    if text == ":providers":
        return ResolveResult(route="builtin", intent="providers")
    if text == ":tools":
        return ResolveResult(route="builtin", intent="tools")
    if text == ":usage":
        return ResolveResult(route="builtin", intent="usage")
    if text == ":insights" or text.startswith(":insights "):
        return ResolveResult(route="builtin", intent="insights", payload=text.split(" ", 1)[1].strip() if " " in text else "")
    if text == ":plan" or text.startswith(":plan "):
        return ResolveResult(route="builtin", intent="plan", payload=text.split(" ", 1)[1].strip() if " " in text else "")
    if text == ":persona" or text.startswith(":persona "):
        return ResolveResult(route="builtin", intent="persona", payload=text.split(" ", 1)[1].strip() if " " in text else "")
    if text.startswith(":turn "):
        return ResolveResult(route="agent", payload=text.split(" ", 1)[1].strip())
    if text.startswith(":"):
        return ResolveResult(route="builtin", intent="unknown", message=f"unknown command: {text}")
    return ResolveResult(route="agent", payload=text)
