"""Local relay daemon lifecycle for bare ``klanker``.

``klanker`` on a TTY ensures a healthy relay before opening the agent
shell: spawn ``klanker serve`` detached when ``/health`` is down, only
for loopback URLs — remote daemons are managed on their host. The
daemon is a shared entity (routines, Telegram, other clients), so it
is never killed when the shell exits; ``klanker stop`` owns shutdown.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_RELAY_URL = "http://127.0.0.1:8787"


def _is_loopback(url: str) -> bool:
    host = urlparse(url if "://" in url else f"http://{url}").hostname or ""
    return host in {"127.0.0.1", "localhost", "::1"}


def daemon_pid_path() -> Path:
    """Per-host pid file: ``<host>/run/serve.pid``."""
    from agents_workspace import Host

    return Host.from_env().run / "serve.pid"


def _legacy_pid_path() -> Path:
    return Path.home() / ".klanker" / "daemon.pid"


def _pid_path_candidates() -> list[Path]:
    path = daemon_pid_path()
    legacy = _legacy_pid_path()
    return [path, legacy] if legacy != path else [path]


_legacy_pid_warned = False


def _read_pid() -> int | None:
    global _legacy_pid_warned
    for path in _pid_path_candidates():
        try:
            pid = int(path.read_text(encoding="utf-8").strip())
        except Exception:
            continue
        if path == _legacy_pid_path() and not _legacy_pid_warned:
            _legacy_pid_warned = True
            import warnings

            warnings.warn(
                f"legacy daemon pid file {path} read once; run "
                "`agents-workspace migrate`",
                DeprecationWarning,
                stacklevel=3,
            )
        return pid
    return None


def relay_health(url: str, *, timeout: float = 1.5) -> bool:
    try:
        with urllib.request.urlopen(
            f"{url.rstrip('/')}/health", timeout=timeout
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


def _spawn_detached(argv: list[str]) -> subprocess.Popen:
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | subprocess.CREATE_NO_WINDOW
        )
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0
        kwargs["startupinfo"] = si
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **kwargs,
    )


def ensure_daemon(url: str = DEFAULT_RELAY_URL, *, wait: float = 20.0) -> bool:
    """Spawn ``klanker serve`` detached when the relay is down.

    Returns True once ``/health`` answers. Remote (non-loopback) URLs
    are never spawned — they are managed on their own host.
    """
    base = url.rstrip("/")
    if relay_health(base):
        return True
    if not _is_loopback(base):
        return False
    proc = _spawn_detached([sys.executable, "-m", "klanker", "serve"])
    path = daemon_pid_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(proc.pid), encoding="utf-8")
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if relay_health(base):
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.4)
    return relay_health(base)


def release_pid_file(path: Path, pid: int) -> None:
    """Remove the pid file only if it still names this process."""
    try:
        if path.read_text(encoding="utf-8").strip() == str(pid):
            path.unlink()
    except OSError:
        pass


def stop_daemon(url: str = DEFAULT_RELAY_URL) -> int:
    """Kill the pid-file daemon. Returns 0 on success, 1 otherwise."""
    pid = _read_pid()
    if pid is None:
        print("no daemon pid file — nothing to stop", file=sys.stderr)
        return 1
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
        )
    else:
        # The daemon is its own process-group leader (start_new_session);
        # signalling the group takes in-flight loop children down too.
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    for path in _pid_path_candidates():
        release_pid_file(path, pid)
    time.sleep(0.5)
    if relay_health(url):
        print(f"warning: {url} still healthy after kill", file=sys.stderr)
        return 1
    print(f"daemon stopped (pid {pid})")
    return 0
