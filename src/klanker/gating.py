"""Serve-time Telegram allowlist and approval-env defaults."""

from __future__ import annotations

import os

APPROVAL_CMD = "agents-relay approve --user {user} --timeout 300"


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


def apply_approval_env(*, telegram: bool) -> None:
    """Default ask-mode approvals when a Telegram bot is being served.

    Existing ``AGENTS_APPROVAL_CMD`` / ``AGENTS_APPROVAL_MODE`` win.
    Harness substitutes ``{user}`` in the command.
    """
    if not telegram:
        return
    os.environ.setdefault("AGENTS_APPROVAL_CMD", APPROVAL_CMD)
    os.environ.setdefault("AGENTS_APPROVAL_MODE", "ask")
