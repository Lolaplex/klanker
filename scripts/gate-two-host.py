#!/usr/bin/env python3
"""3-node klanker E2E gate (klanker#154 / W22).

Real-process topology on one machine (loopback, free ports):

    hub   -- `klanker serve` with no paired hubs (channel hub role)
    A     -- `klanker serve` paired to hub (role=host device)
    B     -- `klanker serve` joined via ws invite (role=ws_member device)

Scenarios (order matters — 2..5 build on the shared ws "alpha"):

    pair-isolation    fresh-pair A->hub; hub/local ws never leak (W01)
    share-sync        ws share + invite -> B joins -> turn msgs converge (W02)
    divergence-scrub  B offline -> divergent writes + scrub on A -> rejoin (W03)
    bind-switch       session:host bind + worktree + checkpoint switch (W04)
    revocation        unshare freezes ws on B; DELETE device -> 401 (W05)

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
        "AGENTS_SESSION_BIND_CMD", "AGENTS_ACTOR_DID", "AGENTS_TOOLSET",
        "AGENTS_MCP_CONFIG_FILE", "AGENTS_MCP_CONFIG",
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
                  actor: str = "gate@e2e") -> bool:
    """Direct ingest write — the e2e-probe path (test_e2e_serve.py)."""
    code = (
        "import sys\n"
        "from agents_store.db import connect\n"
        "from agents_store.ingest import ingest\n"
        "from agents_store.store import Store\n"
        "from agents_workspace import Host\n"
        "from klanker.msgsync import ensure_domain\n"
        "ws = Host.from_env().workspace(sys.argv[1])\n"
        "c = connect(ws.dir / 'store.db')\n"
        "ensure_domain(c)\n"
        "s = Store(c)\n"
        "ingest(c, sys.argv[2], 1, s._clock.tick(),"
        "       [(e, a, v, True) for e, a, v in __import__('json')"
        ".loads(sys.argv[3])])\n"
        "c.close()\n"
        "print('ok')\n")
    out = subprocess.run(
        [PY, "-c", code, ws_id, actor, json.dumps(datoms)],
        env=node_env(node), capture_output=True, text=True, timeout=30.0)
    return out.returncode == 0 and out.stdout.strip() == "ok"


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
        for name, port_seed in ((HUB, 0), (A, 1), (B, 2)):
            host_dir = self.root / f"host-{name}"
            token = f"gate-{name}-{secrets.token_hex(6)}"
            port = free_port()
            self.nodes[name] = {
                "name": name, "host_dir": host_dir, "port": port,
                "token": token, "base": f"http://127.0.0.1:{port}",
                "log": log_dir / f"serve-{name}.log",
                "proc": None, "log_handle": None,
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
        """Create + invite + join: puts ALPHA on all three nodes."""
        if self.alpha_ready:
            return True
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if ws_meta(node_a, ALPHA).get("id") != ALPHA:
            mk = klanker_cli(node_a, "workspace", "create", ALPHA,
                             "--label", "gate alpha")
            self.check("setup: create shared ws on A", mk.returncode == 0,
                       (mk.stderr or mk.stdout).strip()[-160:])

        # invite path: `klanker workspace invite` flips the ws to synced
        # + owner locally, then mints the code on the hub. The hub learns
        # the ws via A's reconcile announce — first invite may race it.
        pair_url, code = "", ""
        for attempt in range(4):
            inv = klanker_cli(node_a, "workspace", "invite", ALPHA,
                              "--json", timeout=30)
            if inv.returncode == 0:
                try:
                    res = json.loads(inv.stdout.strip())
                    pair_url, code = res.get("pair_url") or "", \
                        res.get("code") or ""
                except Exception:  # noqa: BLE001
                    pass
                if code:
                    break
            # hub has not seen the ownership announce yet — wait a tick
            time.sleep(max(2.0, float(TICK)))
        self.check("setup: ws invite minted on hub", bool(code),
                   f"attempts={attempt + 1}")
        if not code:
            return False
        hub_has = poll(
            lambda: ws_meta(node_h, ALPHA).get("id") == ALPHA)
        self.check("setup: hub provisioned ws via announce", bool(hub_has),
                   f"hub meta={ws_meta(node_h, ALPHA)}")

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
        self.alpha_ready = bool(self.dev_b) and bool(dev_row)
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
        self.check("datom written into A local ws", wrote)
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
        # explicit member add after join (the `workspace share --to` path)
        sh = klanker_cli(node_a, "workspace", "share", ALPHA,
                         "--to", self.dev_b)
        self.check("workspace share --to device",
                   sh.returncode == 0,
                   (sh.stderr or sh.stdout).strip()[-160:])
        meta_b = poll(
            lambda: (lambda m: m if m.get("sync_policy") == "synced"
                     and self.dev_b in (m.get("sync_hosts") or [])
                     else None)(ws_meta(node_b, ALPHA)),
            timeout=60)
        self.check("ws announce provisioned + membered on B",
                   bool(meta_b), f"B meta={meta_b}")
        meta_h = ws_meta(node_h, ALPHA)
        self.check("hub member set covers A+B",
                   self.dev_a in (meta_h.get("sync_hosts") or [])
                   and self.dev_b in (meta_h.get("sync_hosts") or []),
                   f"hub sync_hosts={meta_h.get('sync_hosts')}")

        # two real turns on A in the shared ws (echo provider)
        for i in (1, 2):
            msg = f"gate turn {i} {SUFFIX}"
            st, res = api(node_a, "POST", "/v1/turn", {
                "message": msg, "session": self.sid_main,
                "workspace": ALPHA, "provider": "echo",
                "user": "gate", "channel": "gate"},
                timeout=180)
            self.check(f"turn {i} on A echoes",
                       st == 200 and res.get("reply") == msg,
                       f"session={res.get('session')} rc={st}")
        sid = self.sid_main
        # convergence: B's copy must hold the messages even though its
        # ws has no trace files — store.db IS the history on B.
        got = poll(lambda: len([
            m for m in session_msgs(node_b, ALPHA, sid)
            if m.get("role") in ("user", "assistant")]) >= 4,
            timeout=90)
        self.check("B reads turn history from store.db", bool(got),
                   f"msgs={len(session_msgs(node_b, ALPHA, sid))}")
        b_traces = node_b["host_dir"] / "workspaces" / ALPHA / "traces"
        b_files = sorted(b_traces.glob("*.jsonl")) if b_traces.is_dir() else []
        self.check("B traces dir stays empty (store.db is history)",
                   not b_files, f"files={[f.name for f in b_files]}")
        got_h = poll(lambda: len([
            m for m in session_msgs(node_h, ALPHA, sid)
            if m.get("role") in ("user", "assistant")]) >= 4,
            timeout=90)
        self.check("hub holds the same 4+ msgs", bool(got_h),
                   f"msgs={len(session_msgs(node_h, ALPHA, sid))}")
        # v_current equality across all three (msg/session/frame domain)
        want = None
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

    def s_divergence_scrub(self) -> None:
        self.section("scenario 3 — offline divergence + scrub replay")
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if not self.ensure_alpha():
            self.check("alpha shared on all three nodes", False)
            return
        sid = self.sid_main
        # pick a synced msg entity to scrub
        rows = _sql(node_a, ALPHA,
                    "SELECT e FROM v_current WHERE a='msg:text' AND "
                    "e LIKE ? ORDER BY e LIMIT 1", (f"msg:{sid}:%",))
        target = rows[0][0] if rows else ""
        self.check("scrub target exists pre-scrub", bool(target),
                   f"entity={target}")

        # --- B goes offline; A + B diverge -------------------------------
        stop_serve(node_b)
        div_sid = f"ses_div{SUFFIX}"
        trace_msg(node_a, ALPHA, div_sid, "user",
                  f"online write on A {SUFFIX}")
        trace_msg(node_a, ALPHA, div_sid, "assistant",
                  f"A reply {SUFFIX}")
        trace_msg(node_b, ALPHA, div_sid, "user",
                  f"offline write on B {SUFFIX}")
        proj = project_traces(node_b, ALPHA)  # B projects while offline
        self.check("B projected its offline msg while down",
                   int(proj.get("projected") or 0) >= 1, f"{proj}")
        if target:
            self.check("scrub_entity on A", scrub(node_a, ALPHA, target),
                       f"entity={target}")
        # hub must purge within timeout while B is still down
        gone_hub = target and poll(lambda: (
            _sql(node_h, ALPHA,
                 "SELECT COUNT(*) FROM scrubbed WHERE e=?",
                 (target,)) == [[1]]
            and _sql(node_h, ALPHA,
                     "SELECT COUNT(*) FROM v_current WHERE e=?",
                     (target,)) == [[0]]) or None, timeout=90)
        self.check("hub replayed scrub tombstone", bool(gone_hub),
                   f"scrubbed rows on hub="
                   f"{_sql(node_h, ALPHA, 'SELECT COUNT(*) FROM scrubbed WHERE e=?', (target,))}")

        # --- B rejoins -----------------------------------------------------
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
                   bool(poll(converged, timeout=120, every=3)),
                   "full-store view equality")
        for n in (A, B, HUB):
            rows = _sql(self.nodes[n], ALPHA,
                        "SELECT COUNT(*) FROM v_current WHERE e=?",
                        (target,))
            self.check(f"scrubbed entity absent on {n}",
                       rows == [[0]], f"v_current rows={rows}")
            tomb = _sql(self.nodes[n], ALPHA,
                        "SELECT COUNT(*) FROM scrubbed WHERE e=?",
                        (target,))
            self.check(f"scrub tombstone held on {n}",
                       tomb == [[1]], f"scrubbed={tomb}")
        # B's offline msg arrived on A + hub; A's online msg on B
        for n, want in ((A, "offline write on B"),
                        (B, "online write on A")):
            rows = _sql(self.nodes[n], ALPHA,
                        "SELECT v FROM v_current WHERE a='msg:text' "
                        "AND v LIKE ?", (f"%{want}%",))
            self.check(f"divergent msg reached {n}", bool(rows),
                       f"{want!r} rows={len(rows)}")

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
        # B resolves the repo slug to ITS checkout (host-local map)
        hp_b = node_b["host_dir"] / "host_paths.json"
        hp_b.write_text(json.dumps(
            {ALPHA: {"gaterepo": str(repo_b)}}, indent=1),
            encoding="utf-8")
        # scripted provider overlay on A: first completion = git status
        prov_dir = node_a["host_dir"] / "providers"
        prov_dir.mkdir(parents=True, exist_ok=True)
        (prov_dir / "scripted.tool.json").write_text(json.dumps({
            "name": "scripted.tool", "kind": "scripted",
            "verb": "true", "cadence": "on_request", "rests_on": [],
            "tool_name": "call_job",
            "tool_arguments": {"name": "git",
                               "arguments": {"command": "status"}},
            "expected_exit": 0, "timeout_sec": 30}), encoding="utf-8")

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

        # --- first git-scoped turn binds host + worktree -------------------
        sid = f"ses_b{SUFFIX}"
        branch = f"klanker/s-{sid}"
        st, res = api(node_a, "POST", "/v1/turn", {
            "message": f"git status please {SUFFIX}", "session": sid,
            "workspace": ALPHA, "workdir": str(repo_a),
            "provider": "scripted.tool",
            "user": "gate", "channel": "gate"}, timeout=240)
        self.check("git-scoped turn ran on A",
                   st == 200 and bool(res.get("reply")),
                   f"rc={st} reply={str(res.get('reply'))[:80]!r}")
        view = poll(lambda: (lambda v: v
                             if v.get("host") == self.dev_a else None)(
            session_view(node_a, ALPHA, sid)), timeout=60)
        self.check("session:host bound to dev A",
                   bool(view),
                   f"view={session_view(node_a, ALPHA, sid)}")
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
        # binding state propagates over the channel to hub + B
        for n in (HUB, B):
            v = poll(lambda n=n: session_view(
                self.nodes[n], ALPHA, sid).get("host") == self.dev_a
                or None, timeout=90)
            self.check(f"session:host=dev_A synced to {n}", bool(v))

        # --- remote turn via hub channel reaches bound host ---------------
        st, res = api(node_h, "POST", "/v1/turn", {
            "message": f"ping-hub {SUFFIX}", "session": sid,
            "workspace": ALPHA, "provider": "echo",
            "user": "gate", "channel": "gate"}, timeout=240)
        self.check("turn POSTed to hub executed on bound A",
                   st == 200
                   and res.get("reply") == f"ping-hub {SUFFIX}",
                   f"rc={st} reply={str(res.get('reply'))[:80]!r}")
        rows = poll(lambda: _sql(
            node_a, ALPHA,
            "SELECT v FROM v_current WHERE a='msg:text' AND v=?",
            (f"ping-hub {SUFFIX}",)) or None, timeout=90)
        self.check("turn evidence lands in A's store", bool(rows))

        # --- host switch checkpoints + rebinds ------------------------------
        wt_path = _find_worktree(node_a, repo_a, branch)
        wip_name = f"gate-wip-{SUFFIX}.txt"
        wip_body = f"wip from gate {SUFFIX}\n"
        if wt_path and wt_path.is_dir():
            (wt_path / wip_name).write_text(wip_body, encoding="utf-8")
        st, res = api(node_a, "POST",
                      f"/v1/workspaces/{ALPHA}/sessions/{sid}/host",
                      {"host": self.dev_b})
        cp = (res or {}).get("checkpoint") or {}
        self.check("host switch checkpointed + pushed",
                   st == 200 and res.get("ok") and cp.get("pushed"),
                   f"resp={res}")
        v = session_view(node_a, ALPHA, sid)
        self.check("session:host rebound to dev_B on A",
                   v.get("host") == self.dev_b, f"view={v}")
        # the branch travels by git: fetchable from B's clone
        git("fetch", "origin", cwd=repo_b)
        show = git("show", f"origin/{branch}:{wip_name}", cwd=repo_b)
        self.check("checkpointed WIP exists on new host (via git)",
                   show.returncode == 0 and show.stdout == wip_body,
                   f"rc={show.returncode}")
        for n in (HUB, B):
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

    def s_revocation(self) -> None:
        self.section("scenario 5 — revocation")
        node_a, node_b, node_h = self.nodes[A], self.nodes[B], self.nodes[HUB]
        if not self.ensure_alpha():
            self.check("alpha shared on all three nodes", False)
            return
        # B holds a live lease so release_holder() is exercised
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
        leases = api(node_h, "GET", "/v1/hub/leases")[1].get("leases") or []
        self.check("hub leases show B as holder",
                   any(l.get("holder") == self.dev_b for l in leases),
                   f"leases={leases}")

        # unshare while the channel is still alive: ws:revoke freezes B
        un = klanker_cli(node_a, "workspace", "unshare", ALPHA,
                         "--to", self.dev_b)
        self.check("workspace unshare --to dev_B", un.returncode == 0,
                   (un.stderr or un.stdout).strip()[-160:])
        frozen = poll(lambda: (lambda m: m
                               if m.get("sync_policy") == "local"
                               else None)(ws_meta(node_b, ALPHA)),
                      timeout=60)
        self.check("ws alpha frozen to local on B", bool(frozen),
                   f"B meta={frozen}")
        # a new write on A must never reach B after the freeze
        marker = f"post-freeze {SUFFIX}"
        trace_msg(node_a, ALPHA, f"ses_freeze{SUFFIX}", "user", marker)
        rows_h = poll(lambda: _sql(
            node_h, ALPHA,
            "SELECT COUNT(*) FROM v_current WHERE a='msg:text' AND v=?",
            (marker,)) if _sql(
            node_h, ALPHA,
            "SELECT COUNT(*) FROM v_current WHERE a='msg:text' AND v=?",
            (marker,)) == [[1]] else None, timeout=90)
        rows_b = _sql(node_b, ALPHA,
                      "SELECT COUNT(*) FROM v_current WHERE a='msg:text'"
                      " AND v=?", (marker,))
        self.check("frozen ws stops receiving A writes",
                   bool(rows_h) and rows_b == [[0]],
                   f"B={rows_b} hub_marker={bool(rows_h)}")

        # device revocation: stream/send 401 + leases released
        st, res = api(node_h, "DELETE",
                      f"/v1/hub/devices/{self.dev_b}")
        self.check("DELETE /v1/hub/devices/dev_B", st == 200
                   and res.get("ok"), f"resp={res}")
        st_probe, _ = req("POST", node_h["base"] + "/v1/hub/send",
                          {"ch": self.dev_b, "msgs": []},
                          token=b_tok, device_id=self.dev_b)
        self.check("B channel errors 401", st_probe == 401,
                   f"http={st_probe}")
        leases = api(node_h, "GET", "/v1/hub/leases")[1].get("leases") or []
        self.check("leases released on revoke",
                   not any(l.get("holder") == self.dev_b for l in leases),
                   f"leases={leases}")
        devices = api(node_h, "GET", "/v1/hub/devices")[1].get("devices") or []
        self.check("device registry dropped dev_B",
                   self.dev_b not in [d.get("id") for d in devices],
                   f"devices={[d.get('id') for d in devices]}")
        # B notices on its own channel within a bounded window
        seen = False
        end = time.monotonic() + 3 * float(TICK) + 15
        while time.monotonic() < end:
            try:
                text = node_b["log"].read_text(
                    encoding="utf-8", errors="replace")
                if "revoked" in text or "401" in text:
                    seen = True
                    break
            except OSError:
                pass
            time.sleep(2)
        self.check("B channel noticed revocation in its log", seen,
                   f"log={node_b['log'].name}")

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
