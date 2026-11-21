"""Serve-time Telegram allowlist, host approval paths, and opt-in approval command."""

from __future__ import annotations

import math
import os
import shlex
from pathlib import Path
from typing import Any

APPROVAL_TIMEOUT_SEC = 300
APPROVAL_CMD = f"agents-relay approve --user {{user}} --timeout {APPROVAL_TIMEOUT_SEC}"
# runner.approval waits the command's ``--timeout`` plus this grace, or a fixed
# fallback when the command has no ``--timeout``. ``AGENTS_APPROVAL_TIMEOUT`` overrides both.
HARNESS_APPROVAL_GRACE_SEC = 15
HARNESS_APPROVAL_FALLBACK_SEC = 330
_ALLOWLIST_OFF = frozenset({"0", "off", "none", "false", "no"})


def approval_dir() -> Path:
    """Host-owned approval dir ``<host>/run/approvals``."""
    from agents_workspace import Host

    return Host.from_env().run / "approvals"


def approval_tokens_dir() -> Path:
    """Host-owned ephemeral approval token dir ``<host>/run/approvals/tokens``."""
    return approval_dir() / "tokens"


def _is_inside_workspace(path: Path, host: Any) -> bool:
    try:
        resolved = path.expanduser().resolve(strict=False)
        ws_root = Path(host.workspaces_dir).expanduser().resolve(strict=False)
    except OSError:
        return False
    return resolved == ws_root or resolved.is_relative_to(ws_root)


def approval_allowlist_path() -> Path | None:
    """Host-owned tool approval allowlist path, or None when disabled.

    Never resolves inside ``<host>/workspaces/`` so approval allowlists cannot
    be planted or leaked inside a workspace tree.
    """
    from agents_workspace import Host

    host = Host.from_env()
    default = host.dir / "approval-allowlist.json"
    raw = os.environ.get("AGENTS_APPROVAL_ALLOWLIST", "").strip()
    if not raw:
        return default
    if raw.lower() in _ALLOWLIST_OFF:
        return None
    cand = Path(raw).expanduser()
    if _is_inside_workspace(cand, host):
        return default
    return cand


def approval_http_configured() -> bool:
    """True when turn env carries both ``AGENTS_RELAY_URL`` and ``AGENTS_APPROVAL_TOKEN``."""
    return bool(
        os.environ.get("AGENTS_RELAY_URL", "").strip()
        and os.environ.get("AGENTS_APPROVAL_TOKEN", "").strip()
    )


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


def _secret(key: str) -> str:
    """Host secrets vault > env (``scope='host'``); never reads workspace secrets."""
    try:
        from agents_workspace import resolve_secret

        try:
            return resolve_secret(key, scope="host")
        except TypeError:
            return resolve_secret(key)
    except Exception:
        return os.environ.get(key, "")


def telegram_would_poll(*, no_telegram: bool) -> bool:
    if no_telegram:
        return False
    return bool(_secret("TELEGRAM_BOT_TOKEN").strip())


def allowlist_configured() -> bool:
    if "TELEGRAM_ALLOWED_CHAT_IDS" in os.environ:
        return bool(os.environ.get("TELEGRAM_ALLOWED_CHAT_IDS", "").strip())
    if _secret("TELEGRAM_ALLOWED_CHAT_IDS").strip():
        return True
    try:
        from agents_workspace import host_config

        cfg = host_config()
        for key in ("telegram_allowed_chat_ids", "allowed_chat_ids"):
            val = cfg.get(key)
            if isinstance(val, (list, tuple)) and any(str(v).strip() for v in val):
                return True
            if isinstance(val, str) and val.strip():
                return True
    except Exception:
        pass
    return False


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
    Host-only ``AGENTS_APPROVAL_ALLOWLIST`` is enforced if pointed into ``<ws>/``.
    """
    del telegram
    if env_flag("KLANKER_TELEGRAM_OPEN"):
        # Relay denies an empty allowlist unless this is set. Do not override an export.
        os.environ.setdefault("AGENTS_RELAY_ALLOW_ANYONE", "1")
    raw_allowlist = os.environ.get("AGENTS_APPROVAL_ALLOWLIST", "").strip()
    if raw_allowlist and raw_allowlist.lower() not in _ALLOWLIST_OFF:
        try:
            from agents_workspace import Host

            host = Host.from_env()
            if _is_inside_workspace(Path(raw_allowlist).expanduser(), host):
                os.environ["AGENTS_APPROVAL_ALLOWLIST"] = str(host.dir / "approval-allowlist.json")
        except Exception:
            pass
    if not approval_opt_in():
        return
    os.environ.setdefault("AGENTS_APPROVAL_CMD", APPROVAL_CMD)
