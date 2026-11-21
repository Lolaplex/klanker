"""Local relay daemon lifecycle for bare ``klanker``.

``klanker`` on a TTY ensures a healthy relay before opening the agent
shell: spawn ``klanker serve`` detached when ``/health`` is down, only
for loopback URLs — remote daemons are managed on their host. The
daemon is a shared entity (routines, Telegram, other clients), so it
is never killed when the shell exits; ``klanker stop`` owns shutdown.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_RELAY_URL = "http://127.0.0.1:8787"
DEFAULT_RELAY_PORT = 8787


def _is_loopback(url: str) -> bool:
    host = urlparse(url if "://" in url else f"http://{url}").hostname or ""
    return host in {"127.0.0.1", "localhost", "::1"}


def serve_state_path() -> Path:
    """Per-host serve state file: ``<host>/run/serve.json``."""
    from agents_workspace import Host

    return Host.from_env().run / "serve.json"


def daemon_pid_path() -> Path:
    """Alias for :func:`serve_state_path` (``<host>/run/serve.json``)."""
    return serve_state_path()


def serve_log_path() -> Path:
    """Per-host serve log file: ``<host>/logs/serve.log``."""
    from agents_workspace import Host

    return Host.from_env().logs / "serve.log"


def _legacy_host_pid_path() -> Path:
    from agents_workspace import Host

    return Host.from_env().run / "serve.pid"


def _legacy_pid_path() -> Path:
    return Path.home() / ".klanker" / "daemon.pid"


def _pid_path_candidates() -> list[Path]:
    candidates: list[Path] = []
    for path in (serve_state_path(), _legacy_host_pid_path(), _legacy_pid_path()):
        if path not in candidates:
            candidates.append(path)
    return candidates


def _parse_pid(raw: str) -> int | None:
    text = raw.strip()
    if not text:
        return None
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None
        val = data.get("pid")
        if isinstance(val, bool):
            return None
        if isinstance(val, int):
            return val if val > 0 else None
        if isinstance(val, str):
            try:
                parsed = int(val.strip())
                return parsed if parsed > 0 else None
            except ValueError:
                return None
        return None
    try:
        parsed = int(text)
        return parsed if parsed > 0 else None
    except ValueError:
        return None


def _port_from_url(url: str, default: int = DEFAULT_RELAY_PORT) -> int:
    parsed = urlparse(url if "://" in url else f"http://{url}")
    try:
        return int(parsed.port) if parsed.port is not None else default
    except ValueError:
        return default


def write_serve_state(path: Path, pid: int, port: int, url: str) -> None:
    """Persist serve state JSON ``{"pid", "port", "url"}`` atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"pid": int(pid), "port": int(port), "url": url}, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)


_legacy_pid_warned = False


def _read_pid() -> int | None:
    global _legacy_pid_warned
    legacy_klanker = _legacy_pid_path()
    for path in _pid_path_candidates():
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            continue
        pid = _parse_pid(raw)
        if pid is None:
            continue
        if path == legacy_klanker and not _legacy_pid_warned:
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
    log_fh = None
    try:
        log_path = serve_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_fh = open(log_path, "ab")
    except OSError:
        log_fh = None
    stream = log_fh if log_fh is not None else subprocess.DEVNULL
    try:
        return subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=stream,
            stderr=stream,
            **kwargs,
        )
    finally:
        if log_fh is not None:
            log_fh.close()


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
    write_serve_state(serve_state_path(), proc.pid, _port_from_url(base), base)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if relay_health(base):
            return True
        if proc.poll() is not None:
            return False
        time.sleep(0.4)
    return relay_health(base)


def release_pid_file(path: Path, pid: int) -> None:
    """Remove the pid/state file only if it still names this process."""
    try:
        parsed = _parse_pid(path.read_text(encoding="utf-8"))
        if parsed is not None and parsed == pid:
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
