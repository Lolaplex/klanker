#!/usr/bin/env python3
"""Phone-equivalent remote gate (klanker#29).

Proves a non-loopback client can drive the serve surface end to end:

    POST /v1/workspaces                       -> 201 workspace
    POST /v1/workspaces/<ws>/personas         -> 201 persona
    POST .../personas/<p>/sessions            -> 201 session id
    POST /v1/turn                             -> 200 turn reply (echo provider)
    GET  .../personas/<p>/sessions            -> session listed

Usage: python scripts/gate-remote.py [--keep]
Exit: 0 PASS, 1 step failure, 2 no non-loopback address.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

SECRET = f"gate-{secrets.token_hex(8)}"
SUFFIX = secrets.token_hex(3)


def lan_ip() -> str | None:
    """Best-effort primary non-loopback address (no traffic sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("0.0.0.0", 0))
        return s.getsockname()[1]


class Client:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.failures: list[str] = []

    def req(self, method: str, path: str, body: dict | None = None,
            expect: int = 200) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {SECRET}",
            })
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode())
                status = resp.status
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                payload = json.loads(exc.read().decode() or "{}")
            except json.JSONDecodeError:
                payload = {}
        except Exception as exc:
            self.failures.append(f"{method} {path}: transport {exc}")
            return {}
        if status != expect:
            self.failures.append(f"{method} {path}: HTTP {status} (want {expect}) {payload!r}")
            return {}
        return payload


def step(name: str, ok: bool) -> bool:
    print(f"  {'ok' if ok else 'FAIL'}  {name}")
    return ok


def main() -> int:
    keep = "--keep" in sys.argv
    ip = lan_ip()
    if not ip:
        print("gate-remote: SKIP — no non-loopback address on this host")
        return 2
    port = free_port()
    base = f"http://{ip}:{port}"

    tmp = tempfile.TemporaryDirectory(prefix="klanker-gate-")
    host_dir = Path(tmp.name) / "host"
    env = dict(os.environ)
    env.update({
        "AGENTS_HOST_DIR": str(host_dir),
        "RELAY_SECRET": SECRET,
        "RELAY_HOST": "0.0.0.0",
        "RELAY_PORT": str(port),
        "LOOP_PROVIDER": "echo",
        "LOOP_CMD": f"{sys.executable} -m runner.loop",
        "TELEGRAM_BOT_TOKEN": "",
    })
    for var in ("AGENTS_WORKSPACE", "AGENTS_RELAY_WEB_DIR", "AGENTS_WEB_TOKEN"):
        env.pop(var, None)

    proc = subprocess.Popen(
        [sys.executable, "-m", "agents_relay", "serve", "--no-telegram"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        client = Client(base)
        # wait for the listener (remote IP, not loopback)
        deadline = time.monotonic() + 20
        up = False
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"{base}/health", timeout=2).read()
                up = True
                break
            except Exception:
                if proc.poll() is not None:
                    print("gate-remote: FAIL — serve exited during boot")
                    return 1
                time.sleep(0.3)
        if not up:
            print("gate-remote: FAIL — no /health on remote address")
            return 1

        ws_id = f"gate{SUFFIX}"
        persona = "gate"
        ok = True
        r = client.req("POST", "/v1/workspaces", {"id": ws_id, "label": "gate"}, 201)
        ok &= step("POST /v1/workspaces", bool(r.get("workspace")))
        r = client.req("POST", f"/v1/workspaces/{ws_id}/personas",
                       {"id": persona, "accepts_messages": True}, 201)
        ok &= step("POST personas", bool(r.get("persona")))
        r = client.req("POST",
                       f"/v1/workspaces/{ws_id}/personas/{persona}/sessions",
                       {"user": "gate", "channel": "remote"}, 201)
        sid = str((r.get("session") or {}).get("id") or "")
        ok &= step("POST sessions", bool(sid))
        r = client.req("POST", "/v1/turn", {
            "message": "ping", "workspace": ws_id, "persona": persona,
            "user": "gate", "channel": "remote", "session": sid,
        })
        ok &= step("POST /v1/turn", r.get("ok") is True or "reply" in r)
        r = client.req("GET",
                       f"/v1/workspaces/{ws_id}/personas/{persona}/sessions")
        ids = [str(s.get("id")) for s in (r.get("sessions") or [])]
        ok &= step("session listed", sid in ids)
        for f in client.failures:
            print(f"  -- {f}")
        print("gate-remote:", "PASS" if ok and not client.failures else "FAIL")
        return 0 if ok and not client.failures else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if not keep:
            tmp.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
