"""Serve-time Telegram allowlist and opt-in approval command."""

from __future__ import annotations

import math
import os
import shlex

APPROVAL_TIMEOUT_SEC = 300
APPROVAL_CMD = f"agents-relay approve --user {{user}} --timeout {APPROVAL_TIMEOUT_SEC}"
# runner.approval waits the command's ``--timeout`` plus this grace, or a fixed
# fallback when the command has no ``--timeout``. ``AGENTS_APPROVAL_TIMEOUT`` overrides both.
HARNESS_APPROVAL_GRACE_SEC = 15
HARNESS_APPROVAL_FALLBACK_SEC = 330


def approval_wait_sec() -> int:
    """Longest time the harness may block a turn on one approval."""
    raw = os.environ.get("AGENTS_APPROVAL_TIMEOUT", "").strip()
    if raw:
        try:
            return max(1, math.ceil(float(raw)))
        except ValueError:
            pass
    cmd = os.environ.get("AGENTS_APPROVAL_CMD", "").strip() or APPROVAL_CMD
    try:
        parts = shlex.split(cmd)
    except ValueError:
        parts = cmd.split()
    if "--timeout" in parts:
        idx = parts.index("--timeout")
        if idx + 1 < len(parts):
            try:
                return max(1, math.ceil(float(parts[idx + 1]) + HARNESS_APPROVAL_GRACE_SEC))
            except ValueError:
                pass
    return HARNESS_APPROVAL_FALLBACK_SEC


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def telegram_would_poll(*, no_telegram: bool) -> bool:
    if no_telegram:
        return False
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN", "").strip())


def allowlist_configured() -> bool:
    return bool(os.environ.get("TELEGRAM_ALLOWED_CHAT_IDS", "").strip())


def telegram_refusal(*, no_telegram: bool) -> str | None:
    """Error text when Telegram would start without an allowlist or opt-in."""
    if not telegram_would_poll(no_telegram=no_telegram):
        return None
    if allowlist_configured() or env_flag("KLANKER_TELEGRAM_OPEN"):
        return None
    return (
        "Refusing Telegram: TELEGRAM_ALLOWED_CHAT_IDS is empty. "
        "Set an allowlist, or KLANKER_TELEGRAM_OPEN=1 to opt in."
    )


_OPT_IN_APPROVAL_MODES = frozenset({"ask", "strict"})


def approval_opt_in() -> bool:
    """True when the user exported ask or strict. Unset mode stays ungated."""
    mode = os.environ.get("AGENTS_APPROVAL_MODE", "").strip().lower()
    return mode in _OPT_IN_APPROVAL_MODES


def apply_approval_env(*, telegram: bool = False) -> None:
    """Fill the default approve command only for an explicit ask/strict opt-in.

    Unset ``AGENTS_APPROVAL_MODE`` is left unset, which the harness treats as
    off: mutating tools run with no Telegram gate. Serve never writes the mode.
    ``telegram`` does not opt in; a poll or a configured approver is not enough.
    ``KLANKER_TELEGRAM_OPEN`` still sets ``AGENTS_RELAY_ALLOW_ANYONE`` when it
    is unset, which relay needs before it will poll an empty allowlist.
    An exported ``AGENTS_APPROVAL_CMD`` wins. Harness substitutes ``{user}``.
    """
    del telegram
    if env_flag("KLANKER_TELEGRAM_OPEN"):
        # Relay denies an empty allowlist unless this is set. Do not override an export.
        os.environ.setdefault("AGENTS_RELAY_ALLOW_ANYONE", "1")
    if not approval_opt_in():
        return
    os.environ.setdefault("AGENTS_APPROVAL_CMD", APPROVAL_CMD)
