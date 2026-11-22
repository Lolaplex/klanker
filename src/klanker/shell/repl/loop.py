"""Interactive shell entry — plain or TUI."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from ..state import ShellState
from .plain import run_plain
from .tui import run_tui

if TYPE_CHECKING:
    from agents_relay.client import GatewayClient


def _default_project() -> str:
    return Path.cwd().name


def _repl_prefs_path() -> Path:
    from agents_workspace import Host
    new = Host.from_env().clients / "shell" / "prefs.json"
    if not new.exists():
        legacy = Path.cwd() / ".agents" / "repl" / "prefs.json"
        if legacy.is_file():
            return legacy  # one-time read; next save lands on the host path
    return new


def _gateway_client(
    *,
    url: str,
    secret: str,
    user: str,
    project: str,
    provider: str,
    persona: str,
    session: str,
    workspace: str = "",
    workdir: str = "",
) -> GatewayClient:
    from agents_relay.client import GatewayClient

    explicit: set[str] = {"channel"}
    if url and url != "http://127.0.0.1:8787":
        explicit.add("base_url")
    if user and user != "local":
        explicit.add("user")
    if provider:
        explicit.add("provider")
    if persona and persona != "default":
        explicit.add("persona")
    if (project or "").strip():
        explicit.add("project")
    if (workspace or "").strip():
        explicit.add("workspace")

    client = GatewayClient(
        base_url=url,
        secret=secret,
        channel="repl",
        user=user,
        provider=provider,
        persona=persona if "persona" in explicit else "",
        project=project.strip() if "project" in explicit else "",
        workspace=workspace,
        workdir=(workdir or "").strip(),
        prefs_path=_repl_prefs_path(),
    )
    if session:
        client.session = session
    client.load_prefs(explicit=explicit)
    if not client.persona:
        client.persona = persona
    if project or not client.project:
        client.project = (project or "").strip() or _default_project()
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
    workspace: str = "",
    workdir: str = "",
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
                workspace=workspace,
                workdir=workdir,
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
