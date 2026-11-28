"""Runner entry used by serve, chat, and routines.

Installs harness argv shims, then delegates to ``runner.loop``.
"""

from __future__ import annotations

import importlib.util
import logging
import os
from pathlib import Path
import re
import subprocess
import sys

log = logging.getLogger("klanker.turn")
_SAFE_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def persona_from_argv(argv: list[str]) -> str:
    """Return the active persona slug from argv (``--persona``) or ``KLANKER_PERSONA``."""
    for index, arg in enumerate(argv):
        if arg == "--persona" and index + 1 < len(argv):
            return argv[index + 1].strip()
        if arg.startswith("--persona="):
            return arg.split("=", 1)[1].strip()
    return os.environ.get("KLANKER_PERSONA", "").strip()


def resolve_actor_did(ws: object, *, persona: str = "") -> str:
    """Resolve trusted actor DID for store/persona mutations.

    Reads ``AGENTS_ACTOR_DID`` first, then ``agents-keys did <slug>`` (public
    lookup only — never touches ``.ed25519`` key material), falling back to
    ``host:<host_id>``.
    """
    explicit = os.environ.get("AGENTS_ACTOR_DID", "").strip()
    if explicit:
        return explicit
    host = getattr(ws, "host", None)
    host_dir = str(getattr(host, "dir", "") or "")
    host_keys = getattr(host, "keys", None)
    if importlib.util.find_spec("agents_keys") is not None:
        env = {**os.environ, "AGENTS_HOST_DIR": host_dir} if host_dir else dict(os.environ)
        candidates: list[str] = []
        p_clean = (persona or "").strip()
        if p_clean and _SAFE_SLUG.fullmatch(p_clean):
            candidates.append(p_clean)
        candidates.append("host")
        for slug in candidates:
            if host_keys is not None and not (Path(host_keys) / f"{slug}.ed25519").is_file():
                continue
            try:
                proc = subprocess.run(
                    [sys.executable, "-m", "agents_keys", "did", slug],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    env=env,
                )
            except Exception:
                continue
            out = proc.stdout.strip().splitlines()[0].strip() if proc.stdout.strip() else ""
            if proc.returncode == 0 and out.startswith("did:key:"):
                return out
    hid = host.host_id() if host is not None and callable(getattr(host, "host_id", None)) else "local"
    return f"host:{hid}"


def channel_from_argv(argv: list[str]) -> str:
    """Return the ``--channel`` value from a ``runner.loop`` argv, if present."""
    for index, arg in enumerate(argv):
        if arg == "--channel" and index + 1 < len(argv):
            return argv[index + 1].strip()
        if arg.startswith("--channel="):
            return arg.split("=", 1)[1].strip()
    return ""


def system_from_argv(argv: list[str]) -> str:
    """Return the ``--system`` value from a ``runner.loop`` argv, if present."""
    for index, arg in enumerate(argv):
        if arg == "--system" and index + 1 < len(argv):
            return argv[index + 1].strip()
        if arg.startswith("--system="):
            return arg.split("=", 1)[1].strip()
    return ""


def session_from_argv(argv: list[str]) -> str:
    """Return the ``--session`` value from a ``runner.loop`` argv, if present."""
    for index, arg in enumerate(argv):
        if arg == "--session" and index + 1 < len(argv):
            return argv[index + 1].strip()
        if arg.startswith("--session="):
            return arg.split("=", 1)[1].strip()
    return ""


def main(argv: list[str] | None = None) -> int:
    from pathlib import Path

    from agents_workspace import Workspace

    from .gating import apply_approval_env

    # Per-turn context: resolve the workspace this process was spawned for and
    # point the harness at its module overlay. Never mutates a parent process.
    ws = Workspace.from_env()
    os.environ.setdefault("AGENTS_MODULES_DIR", str(ws.modules))
    args = list(sys.argv[1:] if argv is None else argv)
    os.environ["AGENTS_STORE_DB"] = str(ws.store_db)
    if not os.environ.get("AGENTS_ACTOR_DID", "").strip():
        os.environ["AGENTS_ACTOR_DID"] = resolve_actor_did(
            ws, persona=persona_from_argv(args)
        )
    # runner.loop keeps a non-file --system value as the literal prompt text.
    # Klanker passes the built prompt inline, so only refuse values that look
    # like a path (single line, short) whose file does not exist.
    system = system_from_argv(args)
    if not system:
        # Dynamic per-turn prompt: built for THIS workspace, never a frozen
        # entry-workspace prompt baked into LOOP_CMD at serve boot.
        try:
            from .prompt import system_prompt_file

            prompt_file = system_prompt_file(workspace=ws)
            args = ["--system", str(prompt_file)] + args
        except Exception:
            log.warning("dynamic system prompt unavailable", exc_info=True)
    elif "\n" not in system and len(system) < 500 and not Path(system).is_file():
        print(f"Error: --system is not a readable file: {system}", file=sys.stderr)
        return 2
    channel = channel_from_argv(args)
    if channel:
        os.environ["KLANKER_CHANNEL"] = channel
    # Gate env is armed unconditionally: the in-process hook covers this
    # process, and delegate/persona children read the env template — a
    # missing var runs their first host-local tool unbound (klanker#155).
    os.environ.setdefault(
        "AGENTS_SESSION_BIND_CMD",
        f'"{sys.executable}" -m klanker _session-gate '
        "{session} {tool}")
    _sess = session_from_argv(args)
    if _sess:
        os.environ.setdefault("AGENTS_PARENT_SESSION", _sess)
    apply_approval_env(telegram=False)
    try:
        from runner.loop import main as loop_main
    except ImportError:
        print("Error: agents-harness is not installed.", file=sys.stderr)
        return 1
    try:
        from .hooks import register_harness_hooks

        register_harness_hooks()
    except Exception:
        log.warning("harness hooks were not registered", exc_info=True)
    try:
        from .shim import install_argv_shim

        install_argv_shim()
    except Exception:
        pass
    return loop_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
