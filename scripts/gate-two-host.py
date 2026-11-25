#!/usr/bin/env python3
"""3-node klanker E2E gate (klanker#154 / W22).

Real-process topology on one machine (loopback, free ports):

    hub   -- `klanker serve` with no paired hubs (channel hub role)
    A     -- `klanker serve` paired to hub (role=host device)
    B     -- `klanker serve` joined via ws invite (role=ws_member device)

Scenarios (order matters — 2..5 build on the shared ws "alpha"):

    pair-isolation    fresh-pair A->hub; hub/local ws never leak (W01)
    share-sync        invite->join only; turns on A+B; mem/cfg converge;
                      a 3rd non-member device probes every ACL (W02)
    divergence-scrub  B offline -> concurrent LWW + entity/attr scrubs ->
                      rejoin merges; forged frames + late datoms refused (W03)
    bind-switch       mutating tool binds host; approval mirror roundtrip;
                      409 lease_held / wip_unpushed; hub-routed switch (W04)
    revocation        DELETE device while leased -> 401s, link revoked,
                      zero rows propagate afterwards (W05)

Every check prints measured evidence. A FAIL line = a real refusal —
nothing is skipped, faked, or simulated.

Usage:
    python scripts/gate-two-host.py [--scenario NAME]... [--keep] [-v]
Exit: 0 all PASS, 1 any FAIL, 2 environment refuse (no agents-relay/store).

Env overrides (all optional, no hardcoded topology):
    KLANKER_GATE_DIR      scratch root (default: fresh tempdir)
    KLANKER_GATE_TICK     sync tick seconds for the serves (default "4")
    KLANKER_GATE_TIMEOUT  per-assertion poll budget, seconds (default 120)
    KLANKER_GATE_LOG_DIR  serve log dir (default: <gate dir>/logs)
    KLANKER_GATE_KEEP     "1" keeps the scratch dir (same as --keep)
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SRC = str(Path(__file__).resolve().parents[1] / "src")
PY = sys.executable
SUFFIX = secrets.token_hex(4)
TICK = os.environ.get("KLANKER_GATE_TICK", "4")
TIMEOUT = float(os.environ.get("KLANKER_GATE_TIMEOUT", "120"))
KEEP = os.environ.get("KLANKER_GATE_KEEP", "") == "1"

HUB = "hub"
A = "spokeA"
B = "spokeB"
ALPHA = f"alpha{SUFFIX}"


# --------------------------------------------------------------------------
# small process/http helpers
# --------------------------------------------------------------------------

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def base_env(extra: dict | None = None) -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = SRC + os.pathsep + env.get("PYTHONPATH", "")
    for var in (
        "AGENTS_WORKSPACE", "AGENTS_WORKDIR", "AGENTS_WORKDIR_LOCK",
        "AGENTS_STORE_DB", "AGENTS_RELAY_DIR", "AGENTS_RELAY_STATE",
        "AGENTS_SESSION_BIND_CMD", "AGENTS_PARENT_SESSION",
        "AGENTS_ACTOR_DID", "AGENTS_TOOLSET",
        "AGENTS_MCP_CONFIG_FILE", "AGENTS_MCP_CONFIG",
        "AGENTS_APPROVAL_MODE", "AGENTS_APPROVAL_CMD",
        "AGENTS_APPROVAL_TOKEN", "AGENTS_APPROVAL_TIMEOUT",
        "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHAT_IDS",
        "RELAY_SECRET", "GATEWAY_SECRET",
    ):
        env.pop(var, None)
    env["AGENTS_NO_AUTOSPAWN"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    if extra:
        env.update({k: str(v) for k, v in extra.items()})
    return env


def node_env(node: dict, extra: dict | None = None) -> dict:
    return base_env({"AGENTS_HOST_DIR": str(node["host_dir"]), **(extra or {})})


def req(method: str, url: str, body: dict | None = None, *,
        token: str = "", device_id: str = "",
        timeout: float = 30.0) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if device_id:
        headers["X-Device-Id"] = device_id
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode() or "{}")
        except Exception:  # noqa: BLE001
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return -1, {"error": str(exc)}


def api(node: dict, method: str, path: str, body: dict | None = None, **kw):
    return req(method, node["base"] + path, body,
               token=kw.pop("token", node["token"]), **kw)


def wait_http(url: str, timeout: float = 30.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return True
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    return False


def klanker_cli(node: dict, *args: str,
                timeout: float = 45.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        [PY, "-m", "klanker", *args], env=node_env(node),
        capture_output=True, text=True, timeout=timeout)


def probe(node: dict, code: str,
          timeout: float = 30.0) -> subprocess.CompletedProcess:
    """python -c <code> with the node's host env — store probes only."""
    return subprocess.run(
        [PY, "-c", code], env=node_env(node),
        capture_output=True, text=True, timeout=timeout)


def git(*args: str, cwd: Path | None = None,
        timeout: float = 30.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=str(cwd) if cwd else None,
        capture_output=True, text=True, timeout=timeout,
        env=base_env())


def poll(fn, timeout: float = TIMEOUT, every: float = 2.0):
    """Call fn() until it returns truthy; returns the last value."""
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = fn()
        except Exception:  # noqa: BLE001
            last = None
        if last:
            return last
        time.sleep(every)
    return last


# --------------------------------------------------------------------------
# node lifecycle
# --------------------------------------------------------------------------

def start_serve(node: dict) -> bool:
    node["log"].parent.mkdir(parents=True, exist_ok=True)
    node["log_handle"] = open(node["log"], "a", encoding="utf-8")
    node["proc"] = subprocess.Popen(
        [PY, "-m", "klanker", "serve"],
        env=node_env(node, {
            "RELAY_HOST": "127.0.0.1",
            "RELAY_PORT": str(node["port"]),
            "RELAY_WEB_TOKEN": node["token"],
            "KLANKER_SYNC_TICK_SEC": TICK,
            "LOOP_PROVIDER": "echo",
            "AGENTS_RELAY_URL": node["base"],
            **node.get("serve_env", {}),
        }),
        stdout=node["log_handle"], stderr=subprocess.STDOUT, text=True)
    if not wait_http(node["base"] + "/v1/auth/status"):
        node["proc"].terminate()
        return False
    return True


def stop_serve(node: dict) -> None:
    proc = node.get("proc")
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    node["proc"] = None
    if node.get("log_handle"):
        node["log_handle"].close()
        node["log_handle"] = None


# --------------------------------------------------------------------------
# store probes (run in the node's env, inside the real ws store.db)
# --------------------------------------------------------------------------

_PY_STORE = (
    "import json,sys\n"
    "from agents_store.db import connect\n"
    "from agents_workspace import Host\n"
    "ws = Host.from_env().workspace(sys.argv[1])\n"
    "c = connect(ws.dir / 'store.db', check_same_thread=False)\n"
)


def _sql(node: dict, ws_id: str, query: str, params: tuple) -> list:
    """One-shot SELECT against <ws>/store.db; returns rows as lists."""
    code = _PY_STORE + (
        "rows = [list(r) for r in c.execute(sys.argv[2], sys.argv[3:])]\n"
        "print(json.dumps(rows))\n")
    argv = [ws_id, query, *[str(p) for p in params]]
    out = subprocess.run(
        [PY, "-c", code, *argv], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    if out.returncode != 0:
        return []
    try:
        return json.loads(out.stdout.strip() or "[]")
    except Exception:  # noqa: BLE001
        return []


def v_current(node: dict, ws_id: str, prefix: str = "") -> list:
    """Sorted (e,a,v) view rows — the convergence oracle."""
    q = "SELECT e, a, v FROM v_current"
    params: tuple = ()
    if prefix:
        q += " WHERE e LIKE ?"
        params = (prefix + "%",)
    q += " ORDER BY e, a"
    return _sql(node, ws_id, q, params)


def session_view(node: dict, ws_id: str, sid: str) -> dict:
    code = (
        "import json,sys\n"
        "from agents_store.db import connect\n"
        "from agents_workspace import Host\n"
        "from klanker.session import session_view\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db', check_same_thread=False)\n"
        "print(json.dumps(session_view(c, sys.argv[2])))\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, sid], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    if out.returncode != 0:
        return {}
    try:
        return json.loads(out.stdout.strip() or "{}")
    except Exception:  # noqa: BLE001
        return {}


def session_msgs(node: dict, ws_id: str, sid: str) -> list:
    code = (
        "import json,sys\n"
        "from agents_store.db import connect\n"
        "from agents_workspace import Host\n"
        "from klanker.msgsync import session_messages\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db', check_same_thread=False)\n"
        "print(json.dumps(session_messages(c, sys.argv[2])))\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, sid], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    if out.returncode != 0:
        return []
    try:
        return json.loads(out.stdout.strip() or "[]")
    except Exception:  # noqa: BLE001
        return []


def host_id(node: dict) -> str:
    out = probe(
        node,
        "from agents_workspace import Host\n"
        "print(Host.from_env().host_id())")
    return out.stdout.strip() if out.returncode == 0 else ""


def workspaces(node: dict) -> list:
    return sorted(
        p.name for p in (node["host_dir"] / "workspaces").glob("*")
        if p.is_dir()) if (node["host_dir"] / "workspaces").is_dir() else []


def ws_meta(node: dict, ws_id: str) -> dict:
    p = node["host_dir"] / "workspaces" / ws_id / "workspace.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def hubs_rows(node: dict) -> dict:
    try:
        return dict(
            (json.loads(
                (node["host_dir"] / "clients" / "hubs.json")
                .read_text(encoding="utf-8")) or {}).get("hubs") or {})
    except Exception:  # noqa: BLE001
        return {}


def ingest_datoms(node: dict, ws_id: str, datoms: list,
                  kind: str = "proj") -> int:
    """Direct ingest write — minted under a LOCAL origin prefix
    (proj@<node>:gate) so the spoke's origin_only drain actually ships
    it. Returns datoms applied (-1 on probe failure)."""
    code = (
        "import sys\n"
        "from agents_store.db import connect\n"
        "from agents_store.ingest import ingest\n"
        "from agents_store.store import Store\n"
        "from agents_workspace import Host\n"
        "from klanker.msgsync import actor, ensure_domain, local_node_id\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db')\n"
        "ensure_domain(c)\n"
        "s = Store(c)\n"
        "a = actor(sys.argv[2], local_node_id(), 'gate')\n"
        "from klanker.msgsync import next_seq\n"
        "r = ingest(c, a, next_seq(c, a), s._clock.tick(),"
        "       [(e, at, v, True) for e, at, v in __import__('json')"
        ".loads(sys.argv[3])])\n"
        "c.close()\n"
        "print(r.applied)\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, kind, json.dumps(datoms)],
        env=node_env(node), capture_output=True, text=True, timeout=30.0)
    try:
        return int(out.stdout.strip())
    except ValueError:
        return -1


def trace_msg(node: dict, ws_id: str, sid: str, role: str, text: str,
              ts: str = "") -> Path:
    """Append one trace `message` event — the live projection source."""
    tdir = node["host_dir"] / "workspaces" / ws_id / "traces"
    tdir.mkdir(parents=True, exist_ok=True)
    line = json.dumps({
        "ts": ts or time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
              + f".{int(time.time()*1000)%1000:03d}Z",
        "session": sid, "type": "message",
        "metadata": {"role": role, "content": text}})
    path = tdir / f"gate{SUFFIX}.jsonl"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    return path


def project_traces(node: dict, ws_id: str) -> dict:
    """Run the serve tick's own projection on a stopped/offline node."""
    code = (
        "import json,sys\n"
        "from agents_store.db import connect\n"
        "from agents_workspace import Host\n"
        "from klanker.msgsync import project_traces\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db', check_same_thread=False)\n"
        "print(json.dumps(project_traces(c, ws.dir)))\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    try:
        return json.loads(out.stdout.strip() or "{}")
    except Exception:  # noqa: BLE001
        return {"error": out.stderr[-200:]}


def scrub(node: dict, ws_id: str, entity: str) -> bool:
    code = (
        "import sys\n"
        "from agents_store.db import connect\n"
        "from agents_store.scrub import scrub_entity\n"
        "from agents_workspace import Host\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db')\n"
        "r = scrub_entity(c, sys.argv[2], reason='gate scrub')\n"
        "print(r.tx, r.datoms_removed)\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, entity], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    return out.returncode == 0


def scrub_value(node: dict, ws_id: str, attr: str, value: str) -> int:
    """Attribute/value scrub (scrub_datoms): tombstone note carries a
    value hash, never the plaintext. Returns datoms removed."""
    code = (
        "import sys\n"
        "from agents_store.db import connect\n"
        "from agents_store.scrub import scrub_datoms\n"
        "from agents_workspace import Host\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db')\n"
        "n = scrub_datoms(c, a=sys.argv[2], v=sys.argv[3],"
        "                 reason='gate attr scrub')\n"
        "print(n)\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, attr, value], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    try:
        return int(out.stdout.strip())
    except ValueError:
        return -1


def ingest_hlc(node: dict, ws_id: str, datoms: list, *, hlc: str,
               rest: str = "gate", kind: str = "proj",
               seq: int = 1) -> int:
    """Direct ingest with an explicit HLC under a local-origin actor —
    deterministic LWW probes that still ship over origin_only drains.
    `hlc` must satisfy the strict wire shape: <13-digit ms>.<5-digit
    ctr>.<node>. Returns datoms applied (-1 on probe failure)."""
    code = (
        "import sys\n"
        "from agents_store.db import connect\n"
        "from agents_store.ingest import ingest\n"
        "from agents_workspace import Host\n"
        "from klanker.msgsync import actor, ensure_domain, local_node_id\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db')\n"
        "ensure_domain(c)\n"
        "import json\n"
        "d = json.loads(sys.argv[4])\n"
        "a = actor(sys.argv[6], local_node_id(), sys.argv[7])\n"
        "r = ingest(c, a, int(sys.argv[5]), sys.argv[3],\n"
        "       [(x['e'], x['a'], x['v'], bool(x.get('added', True)))"
        "        for x in d])\n"
        "c.close()\n"
        "print(r.applied)\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, "", hlc, json.dumps(datoms),
         str(seq), kind, rest],
        env=node_env(node), capture_output=True, text=True, timeout=30.0)
    try:
        return int(out.stdout.strip())
    except ValueError:
        return -1


def project_memory(node: dict, ws_id: str) -> dict:
    """Fold <ws>/memory files into mem:* datoms (files -> store leg)."""
    code = (
        "import json,sys\n"
        "from agents_store.db import connect\n"
        "from agents_workspace import Host\n"
        "from klanker.migrate import project_memory\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db', check_same_thread=False)\n"
        "print(json.dumps(project_memory(c, ws.dir)))\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    try:
        return json.loads(out.stdout.strip() or "{}")
    except Exception:  # noqa: BLE001
        return {"error": out.stderr[-200:]}


def render_memory(node: dict, ws_id: str) -> dict:
    """Render mem:* datoms to memory/projection/ (store -> files leg)."""
    code = (
        "import json,sys\n"
        "from agents_store.db import connect\n"
        "from agents_workspace import Host\n"
        "from klanker.migrate import render_memory_projection\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db', check_same_thread=False)\n"
        "print(json.dumps(render_memory_projection(c, ws.dir)))\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    try:
        return json.loads(out.stdout.strip() or "{}")
    except Exception:  # noqa: BLE001
        return {"error": out.stderr[-200:]}


def update_ws(node: dict, ws_id: str, **fields) -> bool:
    """host.update_workspace — same workspace.json mutation the CLI
    performs (invite pre-flip, member lists, owner)."""
    code = (
        "import json,sys\n"
        "from agents_workspace import Host\n"
        "h = Host.from_env()\n"
        "kw = json.loads(sys.argv[2])\n"
        "h.update_workspace(sys.argv[1], **kw)\n"
        "print('ok')\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, json.dumps(fields)], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    return out.returncode == 0 and out.stdout.strip() == "ok"


def write_provider(node: dict, name: str, tool_name: str,
                   tool_args: dict, timeout_sec: int = 60) -> Path:
    """Drop a scripted provider manifest into <host>/providers/."""
    pdir = node["host_dir"] / "providers"
    pdir.mkdir(parents=True, exist_ok=True)
    path = pdir / f"{name}.json"
    path.write_text(json.dumps({
        "name": name, "kind": "scripted", "verb": "true",
        "cadence": "on_request", "rests_on": [],
        "tool_name": tool_name, "tool_arguments": tool_args,
        "expected_exit": 0, "timeout_sec": timeout_sec}),
        encoding="utf-8")
    return path


def frame_send(hub_node: dict, device_id: str, token: str,
               msgs: list) -> tuple[int, dict]:
    """POST /v1/hub/send — the upstream channel frame endpoint."""
    return req("POST", hub_node["base"] + "/v1/hub/send",
               {"msgs": msgs}, token=token, device_id=device_id)


def op_frame(ws_id: str, envelopes: list, batch_cursor: int = 1) -> dict:
    return {"v": 1, "kind": "op",
            "payload": {"ws": ws_id, "envelopes": envelopes,
                        "batch_cursor": batch_cursor}}


def make_envelope(actor: str, seq: int, hlc: str, datoms: list,
                  *, op: str = "assert", note: str = "") -> dict:
    """One wire envelope in opdist pack_ops shape (v=1, actor, seq)."""
    return {"v": 1, "actor": actor, "seq": seq, "hlc": hlc,
            "op": op, "note": note, "datoms": datoms}


def leases(node_h: dict) -> list:
    st, res = api(node_h, "GET", "/v1/hub/leases")
    return res.get("leases") or [] if st == 200 else []


def lease_free(node_h: dict, ws_id: str = "", session: str = "",
               timeout: float = 30.0):
    """Wait until no lease row matches (ws[, session])."""
    def free():
        rows = leases(node_h)
        return not any(
            (not ws_id or l.get("ws") == ws_id)
            and (not session or l.get("session") == session)
            for l in rows)
    return poll(free, timeout=timeout, every=0.5)


def hub_links(node: dict) -> dict:
    st, res = api(node, "GET", "/v1/hub/links")
    return res if st == 200 else {}


def sse_open(node: dict, path: str, body: dict,
             timeout: float = 120.0):
    """POST and keep the SSE response open: (status, resp, t0)."""
    data = json.dumps(body).encode()
    r = urllib.request.Request(
        node["base"] + path, data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {node['token']}"})
    t0 = time.monotonic()
    try:
        resp = urllib.request.urlopen(r, timeout=timeout)
        return 200, resp, t0
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode() or "{}")
        except Exception:  # noqa: BLE001
            payload = {}
        return exc.code, payload, t0
    except Exception as exc:  # noqa: BLE001
        return -1, {"error": str(exc)}, t0


def sse_read(resp, timeout: float = 60.0) -> tuple[float, list]:
    """Drain an SSE response: (seconds-to-first-data-line, events)."""
    first = -1.0
    t0 = time.monotonic()
    events: list[dict] = []
    try:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            if first < 0:
                first = time.monotonic() - t0
            try:
                events.append(json.loads(line[5:].strip()))
            except Exception:  # noqa: BLE001
                pass
            if time.monotonic() - t0 > timeout:
                break
    except Exception:  # noqa: BLE001
        pass
    try:
        resp.close()
    except Exception:  # noqa: BLE001
        pass
    return first, events


def approvals(node: dict, ws_id: str = "") -> list:
    path = "/v1/approvals" + (f"?workspace={ws_id}" if ws_id else "")
    st, res = api(node, "GET", path)
    rows = res.get("approvals") or res.get("items") or []
    return rows if st == 200 else []


# --------------------------------------------------------------------------
# gate state
# --------------------------------------------------------------------------

class Gate:
    def __init__(self, root: Path):
        self.root = root
        self.failures: list[str] = []
        self.checks = 0
        self.nodes: dict[str, dict] = {}
        self.dev_a = ""
        self.dev_b = ""
        self.host_ids: dict[str, str] = {}
        self.alpha_ready = False
        self.sid_main = f"ses_g{SUFFIX}"

    def check(self, name: str, ok: bool, evidence: str = "") -> bool:
        self.checks += 1
        tag = "ok" if ok else "FAIL"
        line = f"  {tag}  {name}"
        if evidence:
            line += f"  — {evidence}"
        print(line, flush=True)
        if not ok:
            self.failures.append(name + (f" ({evidence})" if evidence else ""))
        return ok

    def section(self, title: str) -> None:
        print(f"\n== {title} ==", flush=True)

    # -- topology --------------------------------------------------------

    def make_nodes(self) -> None:
        log_dir = Path(
            os.environ.get("KLANKER_GATE_LOG_DIR") or self.root / "logs")
        for name in (HUB, A, B):
            host_dir = self.root / f"host-{name}"
            token = f"gate-{name}-{secrets.token_hex(6)}"
            port = free_port()
            self.nodes[name] = {
                "name": name, "host_dir": host_dir, "port": port,
                "token": token, "base": f"http://127.0.0.1:{port}",
                "log": log_dir / f"serve-{name}.log",
                "proc": None, "log_handle": None,
            }
        # B asks on mutating tool calls; the approve cmd rides the turn's
        # HTTP approval surface (AGENTS_RELAY_URL + per-turn token), so a
        # pending ask mirrors upstream to the hub.
        py_fwd = PY.replace("\\", "/")
        self.nodes[B]["serve_env"] = {
            "AGENTS_APPROVAL_MODE": "ask",
            "AGENTS_APPROVAL_CMD":
                f'"{py_fwd}" -m agents_relay approve --timeout 90',
        }

    def bootstrap(self) -> bool:
        self.section("bootstrap — 3 klanker serve nodes")
        for n in (HUB, A, B):
            ok = start_serve(self.nodes[n])
            self.check(f"serve {n} boots", ok,
                       self.nodes[n]["base"])
            if not ok:
                return False
        # A pairs to hub as a compute device (role=host) over the live
        # mgmt route — same path `klanker remote pair` drives.
        st, res = api(self.nodes[HUB], "POST", "/v1/pair/create",
                      {"mode": "remote", "ttl_sec": 120})
        code = str(res.get("code") or "")
        self.check("hub mints remote pair code", st == 200 and bool(code),
                   f"code len={len(code)}")
        if not code:
            return False
        st, res = api(self.nodes[A], "POST", "/v1/hub/connect",
                      {"url": self.nodes[HUB]["base"], "code": code,
                       "label": "gate-A"})
        self.dev_a = str(res.get("device_id") or "")
        self.check("A pairs via /v1/hub/connect",
                   st == 200 and bool(self.dev_a),
                   f"device_id={self.dev_a}")
        if not self.dev_a:
            return False
        row = poll(lambda: next(
            (d for d in (api(self.nodes[HUB], "GET",
                             "/v1/hub/devices")[1].get("devices") or [])
             if d.get("id") == self.dev_a and d.get("connected")), None),
            timeout=60)
        self.check("hub sees A connected", bool(row),
                   f"devices={api(self.nodes[HUB], 'GET', '/v1/hub/devices')[1].get('devices')}")
        for n in (HUB, A, B):
            self.host_ids[n] = host_id(self.nodes[n])
        return bool(row)

    # -- shared ws lifecycle ----------------------------------------------

    def ensure_alpha(self) -> bool:
        """Create + announce + invite + join: ALPHA on all three nodes.

        Membership comes only from invite->join (ws_grant_apply), never
        `share --to`. The invite POST needs the hub to already know the
        owner — it lands via A's ws:announce, so the gate waits for that
        announce BEFORE minting: exactly one invite attempt, no retries.
        """
        if self.alpha_ready:
            return True
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if ws_meta(node_a, ALPHA).get("id") != ALPHA:
            mk = klanker_cli(node_a, "workspace", "create", ALPHA,
                             "--label", "gate alpha")
            self.check("setup: create shared ws on A", mk.returncode == 0,
                       (mk.stderr or mk.stdout).strip()[-160:])

        # The same workspace.json mutation `workspace invite` performs
        # before POSTing — done up front so the announce it triggers can
        # reach the hub first (announce -> owner visible -> invite 200).
        flipped = update_ws(
            node_a, ALPHA, sync_policy="synced",
            sync_hosts=[self.dev_a],
            execution={"owner": self.dev_a, "failover": "none"})
        self.check("setup: ws flipped synced+owner on A", flipped,
                   f"meta={ws_meta(node_a, ALPHA)}")
        owner_seen = poll(lambda: str(
            (ws_meta(node_h, ALPHA).get("execution") or {})
            .get("owner") or "") == self.dev_a or None, timeout=90)
        self.check("setup: hub ingested ws:announce (owner known)",
                   bool(owner_seen),
                   f"hub meta={ws_meta(node_h, ALPHA)}")

        inv = klanker_cli(node_a, "workspace", "invite", ALPHA,
                          "--json", timeout=30)
        pair_url, code = "", ""
        if inv.returncode == 0:
            try:
                res = json.loads(inv.stdout.strip())
                pair_url, code = res.get("pair_url") or "", \
                    res.get("code") or ""
            except Exception:  # noqa: BLE001
                pass
        self.check("setup: ws invite minted on hub (single attempt)",
                   inv.returncode == 0 and bool(code),
                   f"rc={inv.returncode} {(inv.stderr or inv.stdout).strip()[-140:]}")
        if not code:
            return False

        join = klanker_cli(node_b, "workspace", "join", pair_url,
                           "--label", "gate-B", timeout=45)
        self.check("setup: B joined via invite url",
                   join.returncode == 0,
                   (join.stderr or join.stdout).strip()[-160:])
        if join.returncode != 0:
            return False
        self.dev_b = next(
            (str(r.get("device_id") or "")
             for r in hubs_rows(node_b).values() if r.get("device_id")), "")
        self.check("setup: B device id recorded", bool(self.dev_b),
                   f"device_id={self.dev_b}")
        dev_row = poll(lambda: next(
            (d for d in (api(node_h, "GET", "/v1/hub/devices")[1]
                         .get("devices") or [])
             if d.get("id") == self.dev_b and d.get("connected")), None),
            timeout=60)
        self.check("setup: hub sees B connected", bool(dev_row),
                   f"role={dev_row.get('role') if dev_row else '?'}")
        if dev_row:
            self.check("setup: B role is ws_member",
                       dev_row.get("role") == "ws_member",
                       f"allowlist={dev_row.get('allowlist')}")
        # invite->join is the ONLY membership path: hub ws_grant_apply
        # adds B; the announce fan-out provisions ALPHA on B.
        meta_h = poll(lambda: (lambda m: m
                               if self.dev_b in (m.get("sync_hosts") or [])
                               else None)(ws_meta(node_h, ALPHA)),
                      timeout=60)
        self.check("setup: hub member set grew via ws grant (A+B)",
                   bool(meta_h),
                   f"hub sync_hosts={(meta_h or {}).get('sync_hosts')}")
        meta_b = poll(lambda: (lambda m: m
                               if m.get("sync_policy") == "synced"
                               and self.dev_b in (m.get("sync_hosts") or [])
                               else None)(ws_meta(node_b, ALPHA)),
                      timeout=90)
        self.check("setup: ws:announce provisioned + membered B",
                   bool(meta_b), f"B meta={meta_b}")
        self.alpha_ready = bool(
            self.dev_b and dev_row and meta_h and meta_b)
        return self.alpha_ready

    # -- scenarios --------------------------------------------------------

    def s_pair_isolation(self) -> None:
        self.section("scenario 1 — pair-once isolation")
        node_a, node_h = self.nodes[A], self.nodes[HUB]
        only_hub = f"hubonly{SUFFIX}"
        solo = f"solo{SUFFIX}"
        klanker_cli(node_h, "workspace", "create", only_hub,
                    "--label", "hub only")
        klanker_cli(node_a, "workspace", "create", solo,
                    "--label", "A local")
        wrote = ingest_datoms(
            node_a, solo,
            [(f"solo:{SUFFIX}", "msg:text", "local-only")])
        self.check("datom written into A local ws", wrote >= 1)
        # let several ticks pass — enough time for an illicit sync to run
        deadline = time.monotonic() + 2.5 * float(TICK) + 3
        while time.monotonic() < deadline:
            time.sleep(1.0)
        ws_a = workspaces(node_a)
        self.check("A sees ZERO hub workspaces",
                   only_hub not in ws_a and "default" in ws_a,
                   f"A ws={ws_a}")
        self.check("hub never provisions A local ws",
                   solo not in workspaces(node_h),
                   f"hub ws={workspaces(node_h)}")
        self.check("local ws never got a sync worker (zero op frames)",
                   not (node_a["host_dir"] / "workspaces" / solo
                        / "sync_peers.json").exists(),
                   "sync_peers.json absent")
        rows = _sql(node_a, solo,
                    "SELECT v FROM v_current WHERE e=? AND a='msg:text'",
                    (f"solo:{SUFFIX}",))
        self.check("local ws datom intact on A",
                   rows and rows[0] == ["local-only"], f"rows={rows}")
        devices = api(node_h, "GET", "/v1/hub/devices")[1].get("devices") or []
        self.check("hub device registry has only A",
                   [d.get("id") for d in devices] == [self.dev_a],
                   f"devices={[d.get('id') for d in devices]}")

    def s_share_sync(self) -> None:
        self.section("scenario 2 — share/invite + convergence")
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if not self.ensure_alpha():
            self.check("alpha shared on all three nodes", False,
                       "prereq failed")
            return
        sid = self.sid_main
        sid_b = f"ses_b{SUFFIX}"

        # --- turns on BOTH members: two on A, one on B -------------------
        for i, node in ((1, node_a), (2, node_a), (3, node_b)):
            use_sid = sid_b if node is node_b else sid
            msg = f"gate turn {i} {SUFFIX}"
            st, res = api(node, "POST", "/v1/turn", {
                "message": msg, "session": use_sid,
                "workspace": ALPHA, "provider": "echo",
                "user": "gate", "channel": "gate"},
                timeout=180)
            self.check(f"turn {i} on {node['name']} executes",
                       st == 200 and res.get("reply") == msg,
                       f"session={res.get('session')} rc={st}")
            # a finished turn releases its (ws, session) lease before the
            # next turn starts — lease_held 409s belong to live runs only
            lease_free(node_h, ALPHA, use_sid, timeout=30)

        # convergence: B's copy must hold the messages even though its
        # ws has no trace files — store.db IS the history on B.
        got = poll(lambda: len([
            m for m in session_msgs(node_b, ALPHA, sid)
            if m.get("role") in ("user", "assistant")]) >= 4,
            timeout=90)
        self.check("B reads turn history from store.db", bool(got),
                   f"msgs={len(session_msgs(node_b, ALPHA, sid))}")
        # A's session history on B is store.db-only — B's traces carry
        # only B's OWN session (the projection source), never A's.
        b_traces = node_b["host_dir"] / "workspaces" / ALPHA / "traces"
        leaked = []
        for f in (b_traces.glob("*.jsonl") if b_traces.is_dir() else []):
            try:
                if sid in f.read_text(encoding="utf-8", errors="replace"):
                    leaked.append(f.name)
            except OSError:
                pass
        self.check("B trace files carry only B's own session",
                   not leaked, f"leaked={leaked}")
        got_h = poll(lambda: len([
            m for m in session_msgs(node_h, ALPHA, sid)
            if m.get("role") in ("user", "assistant")]) >= 4,
            timeout=90)
        self.check("hub holds the same 4+ msgs", bool(got_h),
                   f"msgs={len(session_msgs(node_h, ALPHA, sid))}")
        # B's own turn evidence reaches A + hub over the same channel
        for n in (A, HUB):
            rows = poll(lambda n=n: (lambda r: r if r[0][0] >= 1
                                     else None)(_sql(
                self.nodes[n], ALPHA,
                "SELECT COUNT(*) FROM v_current WHERE a='msg:text' "
                "AND v=?", (f"gate turn 3 {SUFFIX}",))),
                timeout=150)
            self.check(f"turn 3 evidence synced to {n}", bool(rows))

        # --- memory: file -> mem:* datoms on A -> datoms land on B -------
        mem_body = f"gate memory recall {SUFFIX}\n"
        mem_dir = node_a["host_dir"] / "workspaces" / ALPHA / "memory"
        mem_dir.mkdir(parents=True, exist_ok=True)
        (mem_dir / f"gate-mem-{SUFFIX}.md").write_text(
            mem_body, encoding="utf-8")
        proj = project_memory(node_a, ALPHA)
        self.check("A projected memory file into mem:* datoms",
                   int(proj.get("projected") or 0) >= 1, f"{proj}")
        mem_ok = poll(lambda: _sql(
            node_b, ALPHA,
            "SELECT COUNT(*) FROM v_current WHERE e LIKE 'mem:%' "
            "AND a='mem:text' AND v LIKE ?",
            (f"%{SUFFIX}%",)) == [[1]] or None, timeout=90)
        self.check("mem:* datom synced to B", bool(mem_ok))
        # store->files leg on B renders the recall surface
        ren = render_memory(node_b, ALPHA)
        gen = node_b["host_dir"] / "workspaces" / ALPHA / "memory" \
            / "projection" / f"gate-mem-{SUFFIX}.md"
        # the sync ingest may have auto-rendered already (unchanged>0);
        # the contract is the projection file carrying the synced text
        self.check("B renders synced memory to projection",
                   gen.is_file()
                   and SUFFIX in gen.read_text(encoding="utf-8"),
                   f"render={ren} file={gen.name if gen.is_file() else '-'}")

        # --- cfg domain convergence (second syncable domain) -------------
        cfg_ok = ingest_datoms(
            node_a, ALPHA,
            [(f"cfg:gate{SUFFIX}", "cfg:value", f"cfg-{SUFFIX}")]) >= 1
        cfg_ok = cfg_ok and poll(lambda: _sql(
            node_b, ALPHA,
            "SELECT v FROM v_current WHERE e=? AND a='cfg:value'",
            (f"cfg:gate{SUFFIX}",)) == [[f"cfg-{SUFFIX}"]] or None,
            timeout=90)
        self.check("cfg:* datom converges A -> B", bool(cfg_ok))

        # --- a paired non-member device (dev_c) probes every ACL ---------
        dev_c, tok_c = self._pair_dev_c(node_h)
        self.check("dev_c pairs (role=host, no ws grant)", bool(tok_c),
                   f"device_id={dev_c}")
        if tok_c:
            probes = [
                ("dev_c ws lease refused 403",
                 req("POST", node_h["base"] + "/v1/hub/lease",
                     {"action": "acquire", "ws": ALPHA,
                      "session": "ses_c", "run_id": "gate"},
                     token=tok_c, device_id=dev_c), (403,)),
                ("dev_c device registry read refused 401",
                 req("GET", node_h["base"] + "/v1/hub/devices",
                     token=tok_c, device_id=dev_c), (401,)),
                ("dev_c device delete refused 401",
                 req("DELETE",
                     node_h["base"] + f"/v1/hub/devices/{dev_c}",
                     token=tok_c, device_id=dev_c), (401,)),
                ("dev_c workspace create refused 403",
                 req("POST", node_h["base"] + "/v1/workspaces",
                     {"id": "rogue", "label": "rogue"},
                     token=tok_c, device_id=dev_c), (403,)),
                ("dev_c send refused 403",
                 req("POST", node_h["base"] + "/v1/send",
                     {"chat_id": "1", "text": "x"},
                     token=tok_c, device_id=dev_c), (403,)),
                ("dev_c approval decide refused 403",
                 req("POST",
                     node_h["base"] + "/v1/approvals/ap_deadbeef",
                     {"allow": True},
                     token=tok_c, device_id=dev_c), (403,)),
            ]
            for name, (st, res), want in probes:
                self.check(name, st in want,
                           f"http={st} body={res}")
            # ws-scoped lease listing is member-filtered: dev_c sees none
            st, res = req("GET", node_h["base"] + "/v1/hub/leases",
                          token=tok_c, device_id=dev_c)
            self.check("dev_c lease view hides alpha",
                       st == 200 and not any(
                           l.get("ws") == ALPHA
                           for l in res.get("leases") or []),
                           f"http={st} leases={res.get('leases')}")

            # forged upstream op frame: well-formed but from a non-member
            # — the hub must drop it before ingest (zero rows anywhere).
            forged_e = f"msg:forged{SUFFIX}"
            st, res = frame_send(node_h, dev_c, tok_c, [op_frame(ALPHA, [
                make_envelope("forge@c", 1,
                              f"{int(time.time()*1000):013d}.00000.forgeC",
                              [{"e": forged_e, "a": "msg:text",
                                "v": "forged-by-dev_c", "added": True}])])])
            self.check("dev_c ws:op frame accepted by transport",
                       st == 200, f"resp={res}")
            time.sleep(max(2.0, float(TICK)))
            rows = _sql(node_h, ALPHA,
                        "SELECT COUNT(*) FROM v_current WHERE e=?",
                        (forged_e,))
            rows_b = _sql(node_b, ALPHA,
                          "SELECT COUNT(*) FROM v_current WHERE e=?",
                          (forged_e,))
            self.check("forged op never ingested (hub+B stay clean)",
                       rows == [[0]] and rows_b == [[0]],
                       f"hub={rows} B={rows_b}")

            # forged ws:announce from a non-owner is dropped — member
            # set must not gain dev_c.
            members_before = set(
                (ws_meta(node_h, ALPHA).get("sync_hosts") or []))
            frame_send(node_h, dev_c, tok_c, [
                {"v": 1, "kind": "ws:announce",
                 "payload": {"ws": ALPHA, "label": "rogue",
                             "owner": dev_c, "sync_hosts": [dev_c]}}])
            time.sleep(max(2.0, float(TICK)))
            members_after = set(
                (ws_meta(node_h, ALPHA).get("sync_hosts") or []))
            self.check("forged ws:announce cannot join the member set",
                       dev_c not in members_after
                       and members_after == members_before,
                       f"members={sorted(members_after)}")

            # forged terminal approval-res from a host device is dropped
            st, res = frame_send(node_h, dev_c, tok_c, [
                {"v": 1, "kind": "approval-res",
                 "payload": {"id": f"ap_{SUFFIX}", "ws": ALPHA,
                             "device": dev_c, "status": "approved"}}])
            self.check("forged approval-res malformed at the hub",
                       st == 200
                       and int(res.get("malformed") or 0) >= 1,
                       f"resp={res}")
        # cleanup: dev_c's credential must not outlive the scenario
        api(node_h, "DELETE", f"/v1/hub/devices/{dev_c}")

        # v_current equality across all three (msg/session/frame domain)
        want = None
        va = vh = vb = []
        for _ in range(40):
            va = v_current(node_a, ALPHA, "msg:") \
                + v_current(node_a, ALPHA, "session:") \
                + v_current(node_a, ALPHA, "frame:")
            vh = v_current(node_h, ALPHA, "msg:") \
                + v_current(node_h, ALPHA, "session:") \
                + v_current(node_h, ALPHA, "frame:")
            vb = v_current(node_b, ALPHA, "msg:") \
                + v_current(node_b, ALPHA, "session:") \
                + v_current(node_b, ALPHA, "frame:")
            if va and va == vh == vb:
                want = va
                break
            time.sleep(2.5)
        self.check("v_current identical on A, hub, B",
                   want is not None,
                   f"rows A/hub/B="
                   f"{len(va)}/{len(vh)}/{len(vb)}")

    def _pair_dev_c(self, node_h: dict) -> tuple[str, str]:
        """Pair a third device over the live pair route WITHOUT a ws
        grant — role=host, empty allowlist. Returns (device_id, token)."""
        st, res = api(node_h, "POST", "/v1/pair/create",
                      {"mode": "remote", "ttl_sec": 120})
        code = str(res.get("code") or "")
        if st != 200 or not code:
            return "", ""
        st, res = req("POST", node_h["base"] + "/v1/pair/redeem",
                      {"token": code, "code": code, "label": "gate-C"})
        if st != 200 or not res.get("device_id"):
            return "", ""
        return str(res.get("device_id")), str(res.get("token") or "")

    def s_divergence_scrub(self) -> None:
        self.section("scenario 3 — offline divergence + scrub replay")
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if not self.ensure_alpha():
            self.check("alpha shared on all three nodes", False)
            return
        ms = int(time.time() * 1000)
        # deterministic clocks in strict HLC shape (<13ms>.<5ctr>.<node>):
        # B's write is LATER, so B wins the merge.
        h_early, h_late = (f"{ms:013d}.00000.gateA",
                           f"{ms + 1:013d}.00000.gateB")
        ent_lww = f"msg:lww{SUFFIX}"
        ent_ord = f"msg:ord{SUFFIX}"
        ent_dead = f"msg:dead{SUFFIX}"
        ent_scrubbed = f"msg:victim{SUFFIX}"

        # --- B goes offline; A + B write the SAME entity/attr ------------
        stop_serve(node_b)
        wrote_a = ingest_hlc(node_a, ALPHA, [
            {"e": ent_lww, "a": "msg:text", "v": f"online A {SUFFIX}"},
            {"e": ent_scrubbed, "a": "msg:text",
             "v": f"SECRET-{SUFFIX}"}],
            hlc=h_early, rest="gateA")
        self.check("A wrote divergent+scrub-target datoms",
                   wrote_a == 2, f"applied={wrote_a}")
        # the secret must actually reach the hub before the scrub —
        # otherwise "physically removed on hub/B" measures nothing
        sec_seen = poll(lambda: _sql(
            node_h, ALPHA,
            "SELECT COUNT(*) FROM v_current WHERE v LIKE ?",
            (f"SECRET-{SUFFIX}",)) == [[1]] or None, timeout=90)
        self.check("secret datom reached the hub pre-scrub",
                   bool(sec_seen))
        wrote_b = ingest_hlc(node_b, ALPHA, [
            {"e": ent_lww, "a": "msg:text", "v": f"offline B {SUFFIX}"},
            {"e": ent_dead, "a": "msg:text",
             "v": f"offline-only {SUFFIX}"}],
            hlc=h_late, rest="gateB")
        self.check("B wrote concurrent datoms while offline",
                   wrote_b == 2, f"applied={wrote_b}")

        # --- scrubs on A: entity tombstone + attr-value (hashed) ---------
        ok_s1 = scrub(node_a, ALPHA, ent_scrubbed)
        self.check("scrub_entity on A", ok_s1, f"entity={ent_scrubbed}")
        n_rm = scrub_value(node_a, ALPHA, "msg:text",
                           f"online A {SUFFIX}")
        self.check("scrub_datoms attr+value on A", n_rm >= 1,
                   f"removed={n_rm}")
        # hub replays both tombstones while B is still down
        gone_hub = poll(lambda: (
            _sql(node_h, ALPHA,
                 "SELECT COUNT(*) FROM scrubbed WHERE e=?",
                 (ent_scrubbed,)) == [[1]]
            and _sql(node_h, ALPHA,
                     "SELECT COUNT(*) FROM v_current WHERE e=?",
                     (ent_scrubbed,)) == [[0]]
            and _sql(node_h, ALPHA,
                     "SELECT COUNT(*) FROM v_current WHERE v=?",
                     (f"online A {SUFFIX}",)) == [[0]]) or None,
            timeout=90)
        self.check("hub replayed entity + attr scrub tombstones",
                   bool(gone_hub),
                   f"scrubbed={_sql(node_h, ALPHA, 'SELECT COUNT(*) FROM scrubbed WHERE e=?', (ent_scrubbed,))}")
        # tx.note preserves the audit trail — and never the plaintext
        notes = _sql(node_h, ALPHA,
                     "SELECT note FROM tx WHERE op='scrub'", ())
        self.check("scrub tx.note lands on the wire",
                   any(ent_scrubbed in str(n) for n in notes)
                   and any("attr-hash:msg:text:" in str(n) for n in notes)
                   and not any(f"online A {SUFFIX}" in str(n)
                               for n in notes),
                   f"notes={notes}")

        # --- B rejoins: concurrent LWW + tombstones merge ----------------
        ok = start_serve(node_b)
        self.check("B serve restarts", ok)
        if not ok:
            return
        rejoined = poll(lambda: next(
            (d for d in (api(node_h, "GET", "/v1/hub/devices")[1]
                         .get("devices") or [])
             if d.get("id") == self.dev_b and d.get("connected")), None),
            timeout=60)
        self.check("B channel reconnected", bool(rejoined))

        def converged():
            va = v_current(node_a, ALPHA)
            vh = v_current(node_h, ALPHA)
            vb = v_current(node_b, ALPHA)
            return va and va == vh == vb
        self.check("v_current identical on A, hub, B after rejoin",
                   bool(poll(converged, timeout=150, every=3)),
                   "full-store view equality")
        for n in (A, B, HUB):
            nn = self.nodes[n]
            rows = _sql(nn, ALPHA,
                        "SELECT v FROM v_current WHERE e=? "
                        "AND a='msg:text'", (ent_lww,))
            self.check(f"LWW winner on {n} is the later write (B)",
                       rows == [[f"offline B {SUFFIX}"]],
                       f"rows={rows}")
            rows = _sql(nn, ALPHA,
                        "SELECT COUNT(*) FROM v_current WHERE e=?",
                        (ent_scrubbed,))
            self.check(f"scrubbed entity absent on {n}",
                       rows == [[0]], f"v_current rows={rows}")
            tomb = poll(lambda nn=nn: _sql(
                nn, ALPHA,
                "SELECT COUNT(*) FROM scrubbed WHERE e=?",
                (ent_scrubbed,)) == [[1]] or None, timeout=90)
            self.check(f"scrub tombstone held on {n}", bool(tomb),
                       f"scrubbed={_sql(nn, ALPHA, 'SELECT COUNT(*) FROM scrubbed WHERE e=?', (ent_scrubbed,))}")
        # the attr-scrubbed value is gone everywhere — including the
        # copy B never saw (tombstone beats a datom it never ingested)
        for n in (A, B, HUB):
            rows = _sql(self.nodes[n], ALPHA,
                        "SELECT COUNT(*) FROM v_current WHERE v=?",
                        (f"online A {SUFFIX}",))
            self.check(f"attr-scrubbed value absent on {n}",
                       rows == [[0]], f"rows={rows}")

        # --- no echo storm: one scrub tx, identical on every node --------
        time.sleep(max(2.0, float(TICK)))
        for n in (A, B, HUB):
            rows = _sql(self.nodes[n], ALPHA,
                        "SELECT COUNT(*) FROM tx WHERE op='scrub' "
                        "AND note=?", (ent_scrubbed,))
            self.check(f"no scrub echo storm on {n} (exactly 1 tx)",
                       rows == [[1]], f"tx={rows}")

        # --- same-ord card_one conflict: one batch, two values -----------
        # Forged member frame with two distinct values at the SAME
        # (e,a,ord) — ingest canonicalizes to max(v) and refusals-log the
        # loser (card_one_same_ord).
        tok_a, _ = _hub_token(node_a)
        st, res = frame_send(node_h, self.dev_a, tok_a, [op_frame(ALPHA, [
            make_envelope("gateA-forge", 98, f"{ms + 2:013d}.00000.gateA",
                          [{"e": ent_ord, "a": "msg:text", "v": "aaa-low",
                            "added": True},
                           {"e": ent_ord, "a": "msg:text", "v": "zzz-high",
                            "added": True}])])])
        self.check("same-ord conflict frame POSTs", st == 200,
                   f"resp={res}")
        refused = poll(lambda: _sql(
            node_h, ALPHA,
            "SELECT COUNT(*) FROM refusal WHERE reason=?",
            ("card_one_same_ord",)) == [[1]] or None, timeout=30)
        self.check("hub logs card_one_same_ord refusal",
                   bool(refused))
        ord_row = poll(lambda: _sql(
            node_b, ALPHA,
            "SELECT v FROM v_current WHERE e=? AND a='msg:text'",
            (ent_ord,)) == [["zzz-high"]] or None, timeout=60)
        self.check("same-ord winner max(v) converged to B",
                   bool(ord_row))

        # --- late datom for a scrubbed entity is refused -----------------
        # forged upstream op frame from MEMBER dev_a carrying a backdated
        # hlc (ord <= scrub cutoff): ingest must drop it physically.
        zombie = f"zombie-{SUFFIX}"
        st, res = frame_send(node_h, self.dev_a, tok_a, [op_frame(ALPHA, [
            make_envelope("gateA-forge", 99, "0000000000001.00000.gateforge",
                          [{"e": ent_scrubbed, "a": "msg:text", "v": zombie,
                            "added": True}])])])
        self.check("backdated op frame POSTs (member device)",
                   st == 200, f"resp={res}")
        time.sleep(max(3.0, float(TICK)))
        dead_h = _sql(node_h, ALPHA,
                      "SELECT COUNT(*) FROM v_current WHERE e=? AND v=?",
                      (ent_scrubbed, zombie))
        dead_b = _sql(node_b, ALPHA,
                      "SELECT COUNT(*) FROM v_current WHERE e=? AND v=?",
                      (ent_scrubbed, zombie))
        self.check("late datom below scrub cutoff never resurrected",
                   dead_h == [[0]] and dead_b == [[0]],
                   f"hub={dead_h} B={dead_b}")

        # attr scrub of a never-syncable domain refuses loudly
        st, res = frame_send(node_h, self.dev_a, tok_a, [op_frame(ALPHA, [
            make_envelope("gateA-forge", 100, f"{ms + 3:013d}.00000.gateA",
                          [], op="scrub", note="attr:local:gate")])])
        self.check("forbidden attr scrub frame POSTs", st == 200,
                   f"resp={res}")
        refused = poll(lambda: _sql(
            node_h, ALPHA,
            "SELECT COUNT(*) FROM refusal WHERE reason=?",
            ("scrub_forbidden_attr",)) == [[1]] or None, timeout=30)
        self.check("hub records scrub_forbidden_attr refusal",
                   bool(refused))

    def s_bind_switch(self) -> None:
        self.section("scenario 4 — bind / worktree / host switch")
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if not self.ensure_alpha():
            self.check("alpha shared on all three nodes", False)
            return
        # --- git fixture: shared bare origin + same-named clones ---------
        gdir = self.root / "git"
        origin = gdir / "origin.git"
        gdir.mkdir(parents=True, exist_ok=True)
        ok = git("init", "--bare", str(origin)).returncode == 0
        repo_a = gdir / "a" / "gaterepo"
        repo_b = gdir / "b" / "gaterepo"
        ok &= git("clone", str(origin), str(repo_a)).returncode == 0
        ok &= git("config", "user.email", "gate@e2e",
                  cwd=repo_a).returncode == 0
        ok &= git("config", "user.name", "gate", cwd=repo_a).returncode == 0
        (repo_a / "seed.txt").write_text("seed\n", encoding="utf-8")
        ok &= git("add", "-A", cwd=repo_a).returncode == 0
        ok &= git("commit", "-m", "seed", cwd=repo_a).returncode == 0
        ok &= git("push", "-u", "origin", "HEAD",
                  cwd=repo_a).returncode == 0
        ok &= git("clone", str(origin), str(repo_b)).returncode == 0
        ok &= git("config", "user.email", "gate@e2e",
                  cwd=repo_b).returncode == 0
        ok &= git("config", "user.name", "gate", cwd=repo_b).returncode == 0
        self.check("git fixture (bare origin + clones on A and B)",
                   ok, f"repos={repo_a.name},{repo_b.name}")
        # B maps the repo slug to ITS checkout via the repo-paths mgmt
        # route (the same surface the desktop settings modal uses)
        st, res = api(node_b, "PUT",
                      f"/v1/workspaces/{ALPHA}/repo-paths",
                      {"paths": {"gaterepo": str(repo_b)}})
        self.check("B repo-paths route accepts slug->checkout",
                   st == 200 and res.get("ok"), f"rc={st} {res}")

        wip_name = f"gate-wip-{SUFFIX}.txt"
        wip_body = f"wip from gate {SUFFIX}\n"
        # scripted providers: first completion emits the tool call, the
        # second echoes its stdout — a real mutating tool call, no LLM.
        write_provider(node_a, "scripted.wip", "call_job", {
            "name": "mcp.terminal",
            "arguments": {"argv": ["write", wip_name,
                                   "--content", wip_body]}})
        write_provider(node_b, "scripted.slow", "call_job", {
            "name": "mcp.terminal",
            "arguments": {"argv": [
                "run", "--", sys.executable, "-c",
                "import time; time.sleep(15)"]}},
            timeout_sec=120)

        # --- unbound turn keeps session:host empty ------------------------
        sid_ub = f"ses_ub{SUFFIX}"
        st, res = api(node_a, "POST", "/v1/turn", {
            "message": f"unbound chat {SUFFIX}", "session": sid_ub,
            "workspace": ALPHA, "provider": "echo",
            "user": "gate", "channel": "gate"}, timeout=180)
        view = session_view(node_a, ALPHA, sid_ub)
        self.check("unbound chat keeps session:host empty",
                   st == 200 and not view.get("host"),
                   f"view={view}")
        lease_free(node_h, ALPHA, sid_ub, timeout=30)

        # --- first mutating tool call binds host + worktree ---------------
        sid = f"ses_b{SUFFIX}"
        branch = f"klanker/s-{sid}"
        st, res = api(node_a, "POST", "/v1/turn", {
            "message": f"write wip {SUFFIX}", "session": sid,
            "workspace": ALPHA, "workdir": str(repo_a),
            "provider": "scripted.wip",
            "user": "gate", "channel": "gate"}, timeout=240)
        self.check("mutating-tool turn ran on A",
                   st == 200 and bool(res.get("reply")),
                   f"rc={st} reply={str(res.get('reply'))[:80]!r}")
        view = poll(lambda: (lambda v: v
                             if v.get("host") == self.dev_a else None)(
            session_view(node_a, ALPHA, sid)), timeout=60)
        self.check("session:host bound to dev A by the tool gate",
                   bool(view),
                   f"view={session_view(node_a, ALPHA, sid)}"
                   f" gate_audit={_gate_audit(node_a)}")
        view = session_view(node_a, ALPHA, sid)
        self.check("session:branch = klanker/s-<sid>",
                   view.get("branch") == branch, f"{view.get('branch')}")
        wt = poll(lambda: (lambda p: p if p.is_dir() else None)(
            _find_worktree(node_a, repo_a, branch)), timeout=30)
        self.check("session worktree created on A", bool(wt),
                   f"wt={_find_worktree(node_a, repo_a, branch)}")
        self.check("session:repo carries slug only",
                   view.get("repo") == "gaterepo",
                   f"repo={view.get('repo')}")
        # the bind tx itself proves the trigger: actor prefix bind@
        rows = _sql(node_a, ALPHA,
                    "SELECT t.origin_actor FROM datom d JOIN tx t"
                    " ON t.id = d.tx WHERE d.e=? AND d.a='session:host'",
                    (f"session:{sid}",))
        self.check("session:host minted by the bind gate (bind@ actor)",
                   bool(rows) and str(rows[0][0] or "").startswith("bind@"),
                   f"actor={rows[0][0] if rows else None}")
        # the tool ran INSIDE the worktree — the WIP file is real
        wt_path = _find_worktree(node_a, repo_a, branch)
        wip = (wt_path / wip_name) if wt_path else None
        self.check("mutating tool wrote inside the session worktree",
                   bool(wip and wip.is_file()
                        and wip.read_text(encoding="utf-8") == wip_body),
                   f"wip={wip}")
        main_status = git("status", "--porcelain", cwd=repo_a)
        self.check("main checkout on A stays clean while worktree holds WIP",
                   main_status.returncode == 0
                   and main_status.stdout == "",
                   f"rc={main_status.returncode} "
                   f"status={main_status.stdout!r}")
        for n in (HUB, B):
            v = poll(lambda n=n: session_view(
                self.nodes[n], ALPHA, sid).get("host") == self.dev_a
                or None, timeout=90)
            self.check(f"session:host=dev_A synced to {n}", bool(v))
        lease_free(node_h, ALPHA, sid, timeout=30)

        # --- second turn on the bound session still runs (idempotent) ----
        msg2 = f"second turn {SUFFIX}"
        st, res = api(node_a, "POST", "/v1/turn", {
            "message": msg2, "session": sid,
            "workspace": ALPHA, "provider": "echo",
            "user": "gate", "channel": "gate"}, timeout=180)
        self.check("turn 2 on bound session runs (already_bound)",
                   st == 200 and res.get("reply") == msg2,
                   f"rc={st}")
        lease_free(node_h, ALPHA, sid, timeout=30)

        # --- chat/stream: first SSE byte arrives inside 1s ---------------
        sid_s = f"ses_s{SUFFIX}"
        st, resp, _ = sse_open(node_a, "/v1/chat/stream", {
            "text": f"stream {SUFFIX}", "session": sid_s,
            "workspace": ALPHA, "provider": "echo"})
        first, events = sse_read(resp, timeout=60)
        deltas = [e for e in events if e.get("type") == "delta"]
        self.check("chat/stream first delta under 1s",
                   st == 200 and 0 <= first < 1.0 and bool(deltas),
                   f"first_data={first:.3f}s deltas={len(deltas)}")
        lease_free(node_h, ALPHA, sid_s, timeout=30)

        # --- approval mirror roundtrip on B (ask mode + slow tool) -------
        sid_slow = f"ses_slow{SUFFIX}"
        run_slow = f"run{SUFFIX}"
        st, resp, _ = sse_open(node_b, "/v1/chat/stream", {
            "text": f"slow {SUFFIX}", "session": sid_slow,
            "workspace": ALPHA, "provider": "scripted.slow",
            "run": run_slow})
        self.check("scripted slow turn opened on B", st == 200,
                   f"rc={st}")
        # the mutating call asks -> pending on B -> mirrored to the hub
        # (mirror rows carry session+id; status is absent while pending)
        pend = poll(lambda: next(
            (r for r in approvals(node_h, ALPHA)
             if str(r.get("session") or "") == sid_slow
             and str(r.get("status") or "pending") == "pending"), None),
            timeout=60)
        ap_id = str((pend or {}).get("id") or "")
        self.check("approval ask mirrored to the hub",
                   bool(ap_id), f"approvals={approvals(node_h, ALPHA)}")
        b_pending = poll(lambda: (node_b["host_dir"] / "run"
                                  / "approvals" / f"{ap_id}.json").is_file()
                         or None, timeout=30) if ap_id else None
        self.check("pending approval file on executing host B",
                   bool(b_pending))
        # while the ask is pending the turn holds the (ws, session) lease
        held = poll(lambda: next(
            (l for l in leases(node_h)
             if l.get("ws") == ALPHA and l.get("session") == sid_slow),
            None), timeout=60)
        self.check("B run holds the (ws, session) lease",
                   bool(held) and held.get("holder") == self.dev_b,
                   f"leases={leases(node_h)}")
        st2, res2 = api(node_b, "POST", "/v1/turn", {
            "message": f"concurrent {SUFFIX}", "session": sid_slow,
            "workspace": ALPHA, "provider": "echo",
            "user": "gate", "channel": "gate"}, timeout=30)
        self.check("concurrent turn refused 409 lease_held",
                   st2 == 409
                   and str(res2.get("error") or "") == "lease_held",
                   f"rc={st2} {res2}")
        st3, res3 = api(node_h, "POST",
                        f"/v1/workspaces/{ALPHA}/sessions/{sid_slow}/host",
                        {"host": self.dev_a})
        self.check("host switch refused 409 lease_held",
                   st3 == 409
                   and str(res3.get("error") or "") == "lease_held",
                   f"rc={st3} {res3}")
        # operator decision on the HUB mirror routes back to B
        st4, res4 = api(node_h, "POST",
                        f"/v1/approvals/{ap_id}", {"allow": True})
        self.check("approval decided on hub mirror",
                   st4 == 200 and res4.get("ok") is not False,
                   f"rc={st4} {res4}")
        decided = poll(lambda: (lambda r: r
                                if r and r.get("status") == "approved"
                                else None)(
            json.loads((node_b["host_dir"] / "run" / "approvals"
                        / f"{ap_id}.json").read_text(encoding="utf-8"))
            if ap_id and (node_b["host_dir"] / "run" / "approvals"
                          / f"{ap_id}.json").is_file() else None),
            timeout=30)
        self.check("approval-res reached B (record_decision)",
                   bool(decided), f"status={decided}")
        # the tool gate binds host right after allow — before the ~15s
        # ping starts, so the stamp is already durable when we cancel
        v = poll(lambda: session_view(node_b, ALPHA, sid_slow).get("host")
                 == self.dev_b or None, timeout=60)
        self.check("scripted slow turn bound session to dev B", bool(v))
        # the approved tool now executes (~15s ping): cancel it mid-run
        st5, res5 = api(node_b, "POST", "/v1/chat/stop",
                        {"workspace": ALPHA, "run": run_slow})
        self.check("chat/stop cancels the running turn",
                   st5 == 200 and run_slow in (res5.get("stopped") or []),
                   f"rc={st5} {res5}")
        sse_read(resp, timeout=30)
        self.check("lease released after stop",
                   bool(lease_free(node_h, ALPHA, sid_slow, timeout=60)))

        # --- hub-routed host switch: checkpoint -> rebind -> prepare -----
        st, res = api(node_h, "POST",
                      f"/v1/workspaces/{ALPHA}/sessions/{sid}/host",
                      {"host": self.dev_b})
        self.check("hub-routed host switch accepted",
                   st == 200 and res.get("ok"), f"rc={st} resp={res}")
        v = poll(lambda: session_view(node_h, ALPHA, sid).get("host")
                 == self.dev_b or None, timeout=60)
        self.check("session:host rebound to dev_B (hub view)", bool(v),
                   f"view={session_view(node_h, ALPHA, sid)}")
        # checkpoint committed + pushed on A; B's prepare materializes a
        # worktree; the WIP travels by git, fetchable on B's clone
        git("fetch", "origin", cwd=repo_b)
        show = git("show", f"origin/{branch}:{wip_name}", cwd=repo_b)
        self.check("checkpointed WIP exists on new host (via git)",
                   show.returncode == 0 and show.stdout == wip_body,
                   f"rc={show.returncode}")
        wt_b = poll(lambda: (lambda p: p if p.is_dir() else None)(
            _find_worktree(node_b, repo_b, branch)), timeout=60)
        self.check("session worktree materialized on B", bool(wt_b),
                   f"wt={_find_worktree(node_b, repo_b, branch)}")
        # A's orphaned worktree is cleaned up after a pushed checkpoint
        wt_a = _find_worktree(node_a, repo_a, branch)
        self.check("old worktree removed on A after switch",
                   wt_a is None or not wt_a.is_dir(),
                   f"wt_a={wt_a}")
        for n in (A, B):
            v = poll(lambda n=n: session_view(
                self.nodes[n], ALPHA, sid).get("host") == self.dev_b
                or None, timeout=90)
            self.check(f"session:host=dev_B synced to {n}", bool(v))

        # --- remote dispatch: turn on A now runs on B ----------------------
        st, res = api(node_a, "POST", "/v1/turn", {
            "message": f"ping-on-B {SUFFIX}", "session": sid,
            "workspace": ALPHA, "provider": "echo",
            "user": "gate", "channel": "gate"}, timeout=240)
        self.check("turn on A proxied to bound B",
                   st == 200
                   and res.get("reply") == f"ping-on-B {SUFFIX}",
                   f"rc={st} reply={str(res.get('reply'))[:80]!r}")
        rows = poll(lambda: _sql(
            node_b, ALPHA,
            "SELECT v FROM v_current WHERE a='msg:text' AND v=?",
            (f"ping-on-B {SUFFIX}",)) or None, timeout=120)
        self.check("turn evidence lands in B's store (ran on B)",
                   bool(rows))
        hb = self.host_ids.get(B) or host_id(node_b)
        rows = poll(lambda: _sql(
            node_b, ALPHA,
            "SELECT v FROM v_current WHERE a='msg:host' AND v=? AND e IN"
            " (SELECT e FROM v_current WHERE a='msg:text' AND v=?)",
            (hb, f"ping-on-B {SUFFIX}")) or None, timeout=90)
        self.check("B stamped msg:host on the remote turn", bool(rows),
                   f"msg:host={hb}")
        lease_free(node_h, ALPHA, sid, timeout=30)

        # --- 409 wip_unpushed: dirty worktree + dead origin ---------------
        wt_b = _find_worktree(node_b, repo_b, branch)
        dirty_ok = False
        if wt_b and wt_b.is_dir():
            (wt_b / f"wip2-{SUFFIX}.txt").write_text(
                "unpushed\n", encoding="utf-8")
            dirty_ok = git("remote", "set-url", "origin",
                           str(self.root / "git" / "dead.git"),
                           cwd=wt_b).returncode == 0
        self.check("fixture: B worktree dirtied, origin dead",
                   dirty_ok, f"wt_b={wt_b}")
        st, res = api(node_h, "POST",
                      f"/v1/workspaces/{ALPHA}/sessions/{sid}/host",
                      {"host": self.dev_a})
        self.check("switch refused 409 wip_unpushed",
                   st == 409
                   and str(res.get("error") or "") == "wip_unpushed",
                   f"rc={st} resp={res}")
        v = session_view(node_h, ALPHA, sid)
        self.check("session:host untouched by the refused switch",
                   v.get("host") == self.dev_b, f"view={v}")
        self.check("session:wip_unpushed flagged on hub",
                   bool(v.get("wip_unpushed")), f"view={v}")
        # restore the real origin, then force the same switch
        if wt_b and wt_b.is_dir():
            git("remote", "set-url", "origin", str(origin), cwd=wt_b)
        st, res = api(node_h, "POST",
                      f"/v1/workspaces/{ALPHA}/sessions/{sid}/host",
                      {"host": self.dev_a, "force": True})
        self.check("forced switch rebinds to dev_A",
                   st == 200 and res.get("ok"), f"rc={st} resp={res}")
        v = poll(lambda: session_view(node_h, ALPHA, sid).get("host")
                 == self.dev_a or None, timeout=60)
        self.check("session:host=dev_A after forced switch", bool(v))

    def s_revocation(self) -> None:
        self.section("scenario 5 — revocation")
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if not self.ensure_alpha():
            self.check("alpha shared on all three nodes", False)
            return
        # B holds a live lease so release on revoke is exercised
        b_tok, b_hub = _hub_token(node_b)
        self.check("B device token resolvable", bool(b_tok),
                   f"hub_id={b_hub}")
        st, res = req("POST", node_h["base"] + "/v1/hub/lease",
                      {"action": "acquire", "ws": ALPHA,
                       "session": f"ses_lease{SUFFIX}",
                       "run_id": "gate"},
                      token=b_tok, device_id=self.dev_b)
        self.check("B acquires ws lease", st == 200
                   and res.get("granted"), f"resp={res}")
        self.check("hub leases show B as holder",
                   any(l.get("holder") == self.dev_b
                       for l in leases(node_h)),
                   f"leases={leases(node_h)}")

        # pre-revoke snapshot: everything B writes afterwards must stay
        # local, and nothing post-revoke may enter the ws from outside.
        rows_a0 = len(v_current(node_a, ALPHA))
        rows_h0 = len(v_current(node_h, ALPHA))

        # DELETE the device while it is leased — no unshare crutch.
        st, res = api(node_h, "DELETE",
                      f"/v1/hub/devices/{self.dev_b}")
        self.check("DELETE /v1/hub/devices/dev_B", st == 200
                   and res.get("ok"), f"resp={res}")

        # B's channel notices: the link flips revoked and stays detached
        t_rev = time.monotonic()
        link = poll(lambda: next(
            (l for l in (hub_links(node_b).get("links") or [])
             if l.get("revoked") or l.get("last_error")), None),
            timeout=30, every=0.5)
        dt_rev = time.monotonic() - t_rev
        self.check("B link flips revoked promptly (<2s target)",
                   bool(link) and dt_rev < 2.0,
                   f"dt={dt_rev:.2f}s links={hub_links(node_b)}")

        # every device surface now answers 401 — send, stream, lease
        st_send, _ = req("POST", node_h["base"] + "/v1/hub/send",
                         {"msgs": []},
                         token=b_tok, device_id=self.dev_b)
        self.check("revoked /v1/hub/send -> 401", st_send == 401,
                   f"http={st_send}")
        st_stream, _ = req("GET", node_h["base"] + "/v1/hub/stream",
                           token=b_tok, device_id=self.dev_b)
        self.check("revoked /v1/hub/stream -> 401", st_stream == 401,
                   f"http={st_stream}")
        st_lease, _ = req("POST", node_h["base"] + "/v1/hub/lease",
                          {"action": "acquire", "ws": ALPHA,
                           "session": f"ses_lease{SUFFIX}",
                           "run_id": "gate"},
                          token=b_tok, device_id=self.dev_b)
        self.check("revoked /v1/hub/lease -> 401", st_lease == 401,
                   f"http={st_lease}")
        st_rpc, _ = req("POST", node_h["base"] + "/v1/turn",
                        {"message": "x", "session": "x",
                         "workspace": ALPHA, "provider": "echo"},
                        token=b_tok, device_id=self.dev_b)
        self.check("revoked /v1/turn RPC -> 401/403",
                   st_rpc in (401, 403), f"http={st_rpc}")

        # leases held by the revoked device are released
        self.check("leases released on revoke",
                   not any(l.get("holder") == self.dev_b
                           for l in leases(node_h)),
                   f"leases={leases(node_h)}")
        devices = api(node_h, "GET", "/v1/hub/devices")[1].get("devices") or []
        self.check("device registry dropped dev_B",
                   self.dev_b not in [d.get("id") for d in devices],
                   f"devices={[d.get('id') for d in devices]}")

        # zero propagation after the cut — both directions, physical rows:
        # A's post-revoke write syncs to the hub but never reaches B, and
        # B's local write never leaves B's store.
        marker_a = f"post-revoke-A {SUFFIX}"
        marker_b = f"post-revoke-B {SUFFIX}"
        ingest_datoms(node_a, ALPHA,
                      [(f"msg:rvk{SUFFIX}", "msg:text", marker_a)])
        ingest_datoms(node_b, ALPHA,
                      [(f"msg:rvk{SUFFIX}", "msg:text", marker_b)])
        got_h = poll(lambda: _sql(
            node_h, ALPHA,
            "SELECT COUNT(*) FROM v_current WHERE a='msg:text' AND v=?",
            (marker_a,)) == [[1]] or None, timeout=90)
        self.check("A's post-revoke write still reaches the hub",
                   bool(got_h))
        # give the (dead) channel a few ticks to prove silence
        time.sleep(2.5 * float(TICK) + 3)
        rows_b = _sql(node_b, ALPHA,
                      "SELECT COUNT(*) FROM v_current WHERE "
                      "a='msg:text' AND v=?", (marker_a,))
        rows_hb = _sql(node_h, ALPHA,
                       "SELECT COUNT(*) FROM v_current WHERE "
                       "a='msg:text' AND v=?", (marker_b,))
        self.check("B receives nothing after revocation",
                   rows_b == [[0]], f"B rows for A marker={rows_b}")
        self.check("hub receives nothing from revoked B",
                   rows_hb == [[0]], f"hub rows for B marker={rows_hb}")
        # no new rows anywhere but the legit A->hub hop
        rows_a1 = len(v_current(node_a, ALPHA))
        rows_h1 = len(v_current(node_h, ALPHA))
        self.check("only the legit A->hub hop grew the stores",
                   rows_h1 - rows_h0 <= rows_a1 - rows_a0,
                   f"A +{rows_a1 - rows_a0} hub +{rows_h1 - rows_h0}")

    # -- driver ------------------------------------------------------------

    SCENARIOS = {
        "pair-isolation": s_pair_isolation,
        "share-sync": s_share_sync,
        "divergence-scrub": s_divergence_scrub,
        "bind-switch": s_bind_switch,
        "revocation": s_revocation,
    }

    def teardown(self) -> None:
        for node in self.nodes.values():
            stop_serve(node)


def _find_worktree(node: dict, repo: Path, branch: str) -> Path | None:
    """Locate the session worktree via klanker's own listing."""
    code = (
        "import sys\n"
        "from klanker.session import find_worktree\n"
        "from pathlib import Path\n"
        "p = find_worktree(Path(sys.argv[1]), sys.argv[2])\n"
        "print(p or '')\n")
    out = subprocess.run(
        [PY, "-c", code, str(repo), branch], env=node_env(node),
        capture_output=True, text=True, timeout=30.0)
    p = out.stdout.strip()
    return Path(p) if p and out.returncode == 0 else None


def _gate_audit(node: dict) -> str:
    """Tail of <host>/session-gate.jsonl — bind refusal reasons."""
    try:
        lines = (node["host_dir"] / "session-gate.jsonl") \
            .read_text(encoding="utf-8", errors="replace") \
            .splitlines()
        return lines[-1] if lines else ""
    except OSError:
        return ""


def _hub_token(node: dict) -> tuple[str, str]:
    """(device token, hub_id) from the node's vault + hubs.json."""
    rows = hubs_rows(node)
    hid = next(iter(rows), "")
    if not hid:
        return "", ""
    code = (
        "import sys\n"
        "from agents_relay.channel_client import hub_token\n"
        "print(hub_token(sys.argv[1]) or '')\n")
    out = subprocess.run(
        [PY, "-c", code, hid], env=node_env(node),
        capture_output=True, text=True, timeout=15.0)
    return out.stdout.strip(), hid


def main() -> int:
    ap = argparse.ArgumentParser(description="3-node klanker E2E gate")
    ap.add_argument("--scenario", action="append", default=[],
                    help="scenario name (repeatable); default: all")
    ap.add_argument("--keep", action="store_true",
                    help="keep the scratch dir")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    names = list(Gate.SCENARIOS)
    if args.list:
        print("\n".join(names))
        return 0
    wanted = args.scenario or names
    unknown = [s for s in wanted if s not in names]
    if unknown:
        print(f"gate-two-host: unknown scenario(s): {unknown}")
        return 2

    try:
        import agents_relay.channel_client  # noqa: F401
        import agents_store.db  # noqa: F401
    except ImportError as exc:
        print(f"gate-two-host: REFUSE — {exc} "
              "(install agents-relay + agents-store)")
        return 2

    raw_dir = os.environ.get("KLANKER_GATE_DIR", "").strip()
    if raw_dir:
        root = Path(raw_dir)
        root.mkdir(parents=True, exist_ok=True)
        tmp = None
    else:
        tmp = tempfile.TemporaryDirectory(prefix="klanker-gate-2h-")
        root = Path(tmp.name)
    keep = KEEP or args.keep
    print(f"gate-two-host: dir={root} tick={TICK}s "
          f"timeout={TIMEOUT}s scenarios={wanted}")

    gate = Gate(root)
    gate.make_nodes()
    t0 = time.monotonic()
    try:
        if gate.bootstrap():
            for name in names:          # canonical order always
                if name in wanted:
                    Gate.SCENARIOS[name](gate)
        else:
            print("gate-two-host: bootstrap failed — aborting")
    finally:
        gate.teardown()
        if tmp is not None and not keep:
            tmp.cleanup()
        elif keep:
            print(f"gate-two-host: kept {root}")
    dt = time.monotonic() - t0
    for f in gate.failures:
        print(f"  -- {f}")
    status = "PASS" if not gate.failures else "FAIL"
    print(f"gate-two-host: {status} "
          f"({gate.checks - len(gate.failures)}/{gate.checks} checks, "
          f"{dt:.0f}s)")
    return 0 if not gate.failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
