"""Detached background runner: `klanker bg`, `ps`, `logs`, `kill`.

Each `klanker bg "<task>"` spawns a detached `klanker _bg-run` child that runs
one non-interactive harness turn. Session bookkeeping is two flat files under
``~/.agents/bg-sessions/`` — ``<id>.json`` (pid, task, status) and ``<id>.log``
(merged child output). No daemon, no broker: subprocess + file descriptors.
"""

from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BG_DIR = Path.home() / ".agents" / "bg-sessions"


def _dir() -> Path:
    BG_DIR.mkdir(parents=True, exist_ok=True)
    return BG_DIR


def _meta_path(bid: str) -> Path:
    return _dir() / f"{bid}.json"


def _log_path(bid: str) -> Path:
    return _dir() / f"{bid}.log"


def _read_meta(bid: str) -> dict[str, Any]:
    try:
        data = json.loads(_meta_path(bid).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_meta(meta: dict[str, Any]) -> None:
    path = _meta_path(str(meta.get("id") or ""))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return f'"{pid}"' in (out.stdout or "")
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _kill_tree(pid: int) -> None:
    """Kill `pid` and its children. Never signals our own process group."""
    if pid <= 0:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True, check=False,
        )
        return
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return
    if pgid == os.getpgrp():
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        time.sleep(0.3)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _status(meta: dict[str, Any]) -> str:
    state = str(meta.get("status") or "")
    if state in ("running", "spawned"):
        return "running" if _pid_alive(int(meta.get("pid") or 0)) else "exited"
    return state or "exited"


def spawn(task: str, *, user: str = "user", provider: str = "") -> dict[str, Any]:
    """Detach one background turn. Returns the session row."""
    task = (task or "").strip()
    if not task:
        raise ValueError("task is required")
    bid = "bg_" + secrets.token_hex(4)
    meta: dict[str, Any] = {
        "id": bid,
        "session": f"ses_{bid}",
        "task": task,
        "user": user,
        "pid": 0,
        "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "spawned",
        "log": str(_log_path(bid)),
    }
    cmd = [sys.executable, "-m", "klanker", "_bg-run", bid]
    if user:
        cmd += ["--user", user]
    if provider:
        cmd += ["--provider", provider]
    log_fh = open(meta["log"], "ab")  # noqa: SIM115 — handed to the child
    kwargs: dict[str, Any] = {
        "stdout": log_fh,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.CREATE_NO_WINDOW
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0)
        )
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(cmd, **kwargs)
    log_fh.close()
    meta["pid"] = proc.pid
    _write_meta(meta)
    return meta


def list_sessions() -> list[dict[str, Any]]:
    rows = []
    for path in sorted(_dir().glob("bg_*.json")):
        meta = _read_meta(path.stem)
        if not meta:
            continue
        meta["status"] = _status(meta)
        rows.append(meta)
    rows.sort(key=lambda m: str(m.get("started") or ""), reverse=True)
    return rows


def find(bid: str) -> dict[str, Any]:
    meta = _read_meta(bid)
    if meta:
        meta["status"] = _status(meta)
    return meta


def kill(bid: str) -> dict[str, Any]:
    meta = _read_meta(bid)
    if not meta:
        raise ValueError(f"unknown session: {bid}")
    if _status(meta) == "running":
        _kill_tree(int(meta.get("pid") or 0))
        meta["status"] = "killed"
        meta["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _write_meta(meta)
    return meta


def log_tail(bid: str, lines: int = 0) -> str:
    try:
        text = _log_path(bid).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if lines and lines > 0:
        return "\n".join(text.splitlines()[-lines:])
    return text


def follow(bid: str, interval: float = 0.5) -> None:
    """Print new log lines until the child exits or Ctrl-C."""
    path = _log_path(bid)
    try:
        fh = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return
    with fh:
        while True:
            chunk = fh.read()
            if chunk:
                print(chunk, end="", flush=True)
                continue
            if _status(find(bid)) != "running":
                break
            time.sleep(interval)


def _fmt_rows(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "No background sessions."
    lines = [f"{'id':<12} {'pid':<8} {'status':<8} {'started':<21} task"]
    for m in rows:
        preview = str(m.get("task") or "")[:60]
        lines.append(
            f"{m.get('id',''):<12} {m.get('pid',''):<8} {m.get('status',''):<8} "
            f"{str(m.get('started') or ''):<21} {preview}"
        )
    return "\n".join(lines)


def run_child(bid: str, *, user: str, provider: str) -> int:
    """Entry point of the detached child: run the task, then record the rc."""
    meta = _read_meta(bid)
    if not meta:
        print(f"unknown bg session: {bid}", file=sys.stderr)
        return 2
    meta["status"] = "running"
    _write_meta(meta)
    try:
        from .nucleus import Nucleus

        rc = Nucleus().run_turn(
            message=str(meta.get("task") or ""),
            user=user or "user",
            session=str(meta.get("session") or f"ses_{bid}"),
            channel="bg",
            provider=provider or None,
        )
    except Exception as exc:  # child must always write its end state
        print(f"bg run failed: {exc}", file=sys.stderr)
        rc = 1
    meta = _read_meta(bid) or meta
    if meta.get("status") != "killed":
        meta["status"] = "exited"
        meta["rc"] = rc
        meta["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        _write_meta(meta)
    return rc


def dispatch(args) -> int:
    """CLI dispatch for bg / ps / logs / kill / _bg-run."""
    command = args.command
    if command == "bg":
        try:
            meta = spawn(
                getattr(args, "task", "") or "",
                user=getattr(args, "user", "user") or "user",
                provider=getattr(args, "provider", "") or "",
            )
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2
        print(f"{meta['id']} pid {meta['pid']} — logs: klanker logs {meta['id']}")
        return 0
    if command == "ps":
        print(_fmt_rows(list_sessions()))
        return 0
    if command == "logs":
        bid = getattr(args, "id", "") or ""
        meta = _read_meta(bid)
        if not meta:
            print(f"Error: unknown session: {bid}", file=sys.stderr)
            return 2
        if getattr(args, "follow", False):
            print(log_tail(bid), end="", flush=True)
            try:
                follow(bid)
            except KeyboardInterrupt:
                pass
        else:
            print(log_tail(bid, lines=int(getattr(args, "lines", 0) or 0)), end="")
            print()
        return 0
    if command == "kill":
        bid = getattr(args, "id", "") or ""
        try:
            meta = kill(bid)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2
        print(f"{meta['id']} {meta['status']}")
        return 0
    if command == "_bg-run":
        return run_child(
            getattr(args, "id", "") or "",
            user=getattr(args, "user", "user") or "user",
            provider=getattr(args, "provider", "") or "",
        )
    return 2
