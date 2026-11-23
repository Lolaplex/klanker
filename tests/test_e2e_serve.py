"""serve↔serve E2E: two real `klanker serve` processes, real pairing +
ws share, datoms flowing over the hub channel (klanker#145 proof).

Skipped when agents-relay/agents-store are unavailable or the ports are
taken. Runtime ~20-40s (sync tick shortened via KLANKER_SYNC_TICK_SEC).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

PORT_A = 18871
PORT_B = 18872
TICK = "4"
# spawned serve/CLI subprocesses must import THIS checkout, not the
# editable-install path (worktrees shadow the install site)
_SRC = str(__import__("pathlib").Path(__file__).resolve().parents[1] / "src")


def _test_env(extra: dict) -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env.update(extra)
    return env


def _post(url: str, body: dict, token: str = "",
          device_id: str = "") -> dict:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if device_id:
        headers["X-Device-Id"] = device_id
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers=headers,
        method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=15).read())


def _wait_http(url: str, timeout: float = 25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return True
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    return False


def _serve(host_dir, port: int, token: str, env_extra: dict | None = None):
    env = _test_env({
        "AGENTS_HOST_DIR": str(host_dir),
        "RELAY_HOST": "127.0.0.1",
        "RELAY_PORT": str(port),
        "RELAY_WEB_TOKEN": token,
        "KLANKER_SYNC_TICK_SEC": TICK,
    })
    if env_extra:
        env.update(env_extra)
    return subprocess.Popen(
        [sys.executable, "-m", "klanker", "serve"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True)


def _klanker(args: list[str], host_dir, timeout: float = 30.0):
    env = _test_env({"AGENTS_HOST_DIR": str(host_dir)})
    return subprocess.run(
        [sys.executable, "-m", "klanker", *args], env=env,
        capture_output=True, text=True, timeout=timeout)


@pytest.fixture
def e2e(tmp_path):
    hosts = {"A": tmp_path / "hostA", "B": tmp_path / "hostB"}
    procs = []
    yield hosts, procs
    for p in procs:
        p.terminate()
    for p in procs:
        try:
            p.wait(timeout=10)
        except Exception:  # noqa: BLE001
            p.kill()


def test_ws_share_two_serves_end_to_end(e2e):
    pytest.importorskip("agents_relay.channel_client")
    pytest.importorskip("agents_store.db")
    hosts, procs = e2e
    base_a = f"http://127.0.0.1:{PORT_A}"

    # --- host A: hub serve --------------------------------------------------
    procs.append(_serve(hosts["A"], PORT_A, "tokA"))
    assert _wait_http(f"{base_a}/v1/auth/status"), "serve A did not boot"

    # --- host B: pair as a device against hub A -----------------------------
    res = _post(f"{base_a}/v1/pair/create",
                {"mode": "remote", "ttl_sec": 120}, token="tokA")
    code = res.get("code") or res.get("pair_url", "").split("=")[-1]
    assert code, f"pair create returned no code: {res}"
    env_b = _test_env({"AGENTS_HOST_DIR": str(hosts["B"])})
    join = subprocess.run(
        [sys.executable, "-c",
         "from agents_relay.channel_client import connect_hub;"
         f"print(connect_hub('http://127.0.0.1:{PORT_A}',"
         f" '{code}', label='B')['device_id'])"],
        env=env_b, capture_output=True, text=True, timeout=30)
    assert join.returncode == 0, join.stderr[-500:]
    dev_b = join.stdout.strip()
    assert dev_b

    # --- ws on A + share to B ------------------------------------------------
    mk = _klanker(["workspace", "create", "e2ews", "--label", "E2E"],
                  hosts["A"])
    assert mk.returncode == 0, mk.stderr[-300:]
    sh = _klanker(["workspace", "share", "e2ews", "--to", dev_b],
                  hosts["A"])
    assert sh.returncode == 0, sh.stderr[-300:]

    # --- write a datom into A's ws store ------------------------------------
    env_a = _test_env({"AGENTS_HOST_DIR": str(hosts["A"])})
    wr = subprocess.run(
        [sys.executable, "-c",
         "from agents_store.db import connect\n"
         "from agents_store.ingest import ingest\n"
         "from agents_workspace import Host\n"
         "ws = Host.from_env().workspace('e2ews')\n"
         "c = connect(ws.dir / 'store.db')\n"
         "ingest(c, 'test@e2e', 1, 'e2e.1',"
         "        [('e2e:probe', 'e2e:val', 'sync-ok', True)])\n"
         "c.close()"],
        env=env_a, capture_output=True, text=True, timeout=30)
    assert wr.returncode == 0, wr.stderr[-500:]

    # --- host B: spoke serve picks up announce, provisions ws, syncs --------
    procs.append(_serve(hosts["B"], PORT_B, "tokB"))
    assert _wait_http(f"http://127.0.0.1:{PORT_B}/v1/auth/status"), \
        "serve B did not boot"

    # poll: ws provisioned + datom arrived (a few ticks)
    got = ""
    for _ in range(45):
        time.sleep(2)
        probe = subprocess.run(
            [sys.executable, "-c",
             "from agents_store.db import connect\n"
             "from agents_workspace import Host\n"
             "try:\n"
             "    ws = Host.from_env().workspace('e2ews')\n"
             "    c = connect(ws.dir / 'store.db')\n"
             "    rows = list(c.execute(\n"
             "        \"SELECT v FROM v_current WHERE e='e2e:probe' AND"
             "         a='e2e:val'\"))\n"
             "    print(rows[0][0] if rows else '')\n"
             "except Exception:\n"
             "    print('')"],
            env=env_b, capture_output=True, text=True, timeout=15)
        got = probe.stdout.strip()
        if got == "sync-ok":
            break
    assert got == "sync-ok", \
        f"datom never arrived on B (ws provisioned={bool(got or '')})"

    # B's workspace.json carries the share policy
    meta = json.loads(
        (hosts["B"] / "workspaces" / "e2ews" / "workspace.json")
        .read_text())
    assert "e2ews" == meta.get("id")
    assert dev_b in (meta.get("sync_hosts") or [])
