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


def approver_configured() -> bool:
    """True when some command can ask a person before a mutating tool runs.

    CLI with no bot token, no ``AGENTS_RELAY_APPROVER``, and no
    ``AGENTS_APPROVAL_CMD`` stays ungated.
    """
    if os.environ.get("AGENTS_APPROVAL_CMD", "").strip():
        return True
    if not os.environ.get("TELEGRAM_BOT_TOKEN", "").strip():
        return False
    if os.environ.get("AGENTS_RELAY_APPROVER", "").strip():
        return True
    return allowlist_configured() or env_flag("KLANKER_TELEGRAM_OPEN")


def apply_approval_env(*, telegram: bool = False) -> None:
    """Default ask-mode approvals when an approver path exists.

    Telegram polling is one such path. A configured relay approver or an
    existing ``AGENTS_APPROVAL_CMD`` is another, including HTTP-only serve.
    Existing exports win. Harness substitutes ``{user}`` in the command.
    """
    if env_flag("KLANKER_TELEGRAM_OPEN"):
        # Relay denies an empty allowlist unless this is set. Do not override an export.
        os.environ.setdefault("AGENTS_RELAY_ALLOW_ANYONE", "1")
    if not telegram and not approver_configured():
        return
    os.environ.setdefault("AGENTS_APPROVAL_CMD", APPROVAL_CMD)
    os.environ.setdefault("AGENTS_APPROVAL_MODE", "ask")
