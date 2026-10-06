"""Interactive shell entry — plain or TUI."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from ..state import ShellState
from .plain import run_plain
from .tui import run_tui

if TYPE_CHECKING:
    from agents_gateway.client import GatewayClient


def _default_project() -> str:
    return Path.cwd().name


def _repl_prefs_path() -> Path:
    return Path.cwd() / ".agents" / "repl" / "prefs.json"


def _gateway_client(
    *,
    url: str,
    secret: str,
    user: str,
    project: str,
    provider: str,
    persona: str,
    session: str,
) -> GatewayClient:
    from agents_gateway.client import GatewayClient

    proj = (project or "").strip() or _default_project()
    client = GatewayClient(
        base_url=url,
        secret=secret,
        channel="repl",
        user=user,
        provider=provider,
        persona=persona,
        project=proj,
        prefs_path=_repl_prefs_path(),
    )
    if session:
        client.session = session
    client.load_prefs()
    if project:
        client.project = proj
    return client


def run_interactive_shell(
    *,
    plain: bool = False,
    stream: bool = False,
    url: str = "http://127.0.0.1:8787",
    secret: str = "",
    user: str = "local",
    project: str = "",
    provider: str = "",
    persona: str = "default",
    session: str = "",
    no_gateway: bool = False,
) -> int:
    gateway = None
    if not no_gateway:
        try:
            gateway = _gateway_client(
                url=url,
                secret=secret,
                user=user,
                project=project,
                provider=provider,
                persona=persona,
                session=session,
            )
        except ImportError:
            pass

    state = ShellState.from_os(gateway=gateway)
    state.stream = stream
    if plain:
        return run_plain(state)
    try:
        import pyratatui  # noqa: F401
    except ImportError:
        return run_plain(state)
    return run_tui(state)
