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
    return Path.home() / ".klanker" / "daemon.pid"


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


def _read_pid() -> int | None:
    try:
        return int(daemon_pid_path().read_text(encoding="utf-8").strip())
    except Exception:
        return None


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
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    path = daemon_pid_path()
    release_pid_file(path, pid)
    time.sleep(0.5)
    if relay_health(url):
        print(f"warning: {url} still healthy after kill", file=sys.stderr)
        return 1
    print(f"daemon stopped (pid {pid})")
    return 0
