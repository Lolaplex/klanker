"""P1 gate: two workspaces in one process/serve stay isolated.

In-process checks use agents-* APIs directly; the HTTP variant runs a real
agents-relay `serve_http` on an ephemeral port with an injected turn hook.
Container variant lives in `scripts/gate-container.sh` (runs on the image).
"""

from __future__ import annotations

import http.client
import json
import os
import threading
import urllib.request

import pytest
from agents_workspace import Host, Workspace


@pytest.fixture()
def host(tmp_path, monkeypatch):
    for var in list(os.environ):
        if var.startswith("AGENTS_"):
            monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    h = Host.from_env()
    h.create("alpha")
    h.create("beta")
    return h


def _ws(host, ws_id):
    return host.workspace(ws_id)


def test_two_workspaces_have_disjoint_domain_dirs(host):
    a, b = _ws(host, "alpha"), _ws(host, "beta")
    for domain in ("memory", "rules", "skills", "modules", "schedules",
                   "traces", "routine_runs", "relay_state", "personas"):
        pa, pb = getattr(a, domain), getattr(b, domain)
        assert pa != pb, domain
        assert str(a.id) in str(pa) or "alpha" in pa.parts
        assert "beta" in pb.parts


def test_ws_env_is_explicit_and_does_not_mutate_parent(host):
    a = _ws(host, "alpha")
    before = dict(os.environ)
    env = a.env()
    assert dict(os.environ) == before
    assert env["AGENTS_WORKSPACE"] == "alpha"
    assert env["AGENTS_HOST_DIR"] == str(host.dir)
    assert "beta" not in json.dumps({k: v for k, v in env.items() if k != "AGENTS_WORKSPACE"})


def test_memory_stores_are_isolated_per_workspace(host):
    from agents_memory.store import memory_store

    a, b = _ws(host, "alpha"), _ws(host, "beta")
    sa, sb = memory_store(a), memory_store(b)
    assert sa.memory != sb.memory
    assert sa.memory.parent == a.dir
    assert sb.memory.parent == b.dir


def test_traces_resolve_per_workspace(host):
    a, b = _ws(host, "alpha"), _ws(host, "beta")
    assert a.traces != b.traces
    assert "alpha" in a.traces.parts
    assert "beta" in b.traces.parts


def test_relay_state_per_workspace(host):
    a, b = _ws(host, "alpha"), _ws(host, "beta")
    assert a.relay_state != b.relay_state
    assert a.relay_state.parent == a.dir


def test_host_infra_stays_host_level(host):
    a = _ws(host, "alpha")
    assert host.keys.parent == host.dir
    assert host.run.parent == host.dir
    assert host.cache.parent == host.dir
    assert host.logs.parent == host.dir
    # no host-level workspace data
    for domain in ("memory", "traces", "schedules", "personas"):
        assert not (host.dir / domain.replace("_", "-")).exists()


def test_members_per_workspace_users_at_host(host):
    a, b = _ws(host, "alpha"), _ws(host, "beta")
    assert (a.dir / "members.json") != (b.dir / "members.json")
    assert host.users_file().parent == host.dir


def test_env_override_only_affects_selected_workspace(host, monkeypatch):
    override = host.dir / "custom-mem"
    a = _ws(host, "alpha")
    env = a.env()
    env["AGENTS_MEMORY_DIR"] = str(override)
    a2 = Workspace.from_env(env)
    assert a2.memory == override
    b = _ws(host, "beta")
    assert b.memory == b.dir / "memory"


def test_tick_iterates_workspaces_without_env_mutation(host):
    from klanker import routine

    seen = []
    def fake_tick(base_time=None, *, wait=True, workspace=None, **kwargs):
        seen.append(workspace)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("runner.schedule.tick", fake_tick)
        before = dict(os.environ)
        routine.default_tick()
    assert dict(os.environ) == before
    ids = {ws.id for ws in seen if ws}
    assert {"alpha", "beta"} <= ids


def test_serve_refuses_legacy_layout(tmp_path, monkeypatch):
    for var in list(os.environ):
        if var.startswith("AGENTS_"):
            monkeypatch.delenv(var, raising=False)
    legacy = tmp_path / "legacy-host"
    (legacy / "memory").mkdir(parents=True)
    monkeypatch.setenv("AGENTS_HOST_DIR", str(legacy))
    import klanker.__main__ as cli

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("sys.argv", ["klanker", "serve", "--no-telegram"])
        assert cli.main() == 1


def test_second_workspace_listing(host):
    ids = {w.id for w in Workspace.list_all()}
    assert {"alpha", "beta"} <= ids


# --- HTTP variant -----------------------------------------------------------


def _post_turn(port: int, payload: dict) -> tuple[int, dict]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(
        "POST", "/v1/turn",
        body=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(data)
    except json.JSONDecodeError:
        return resp.status, {}


def test_http_turn_isolates_workspaces(host, monkeypatch):
    from agents_relay.config import RelayConfig
    from agents_relay.http_adapter import serve_http

    monkeypatch.setenv("AGENTS_HOST_DIR", str(host.dir))
    resolved: list[dict] = []

    def hook(**kwargs):
        ws_id = kwargs.get("workspace") or ""
        ws = host.workspace(ws_id) if ws_id else None
        resolved.append({
            "workspace": ws_id,
            "memory": str(ws.memory) if ws else None,
        })
        from agents_relay.turn import LoopTurnResult
        return LoopTurnResult(
            reply=str(ws.memory) if ws else "",
            session="", user_id="", alias="", returncode=0, stderr="",
        )

    cfg = RelayConfig(
        loop_cmd=("python", "-c", "pass"),
        loop_provider="",
        relay_secret="",
        telegram_bot_token="",
        telegram_allowed_chat_ids=(),
        relay_host="127.0.0.1",
        relay_port=0,
        telegram_poll_timeout=0,
    )
    server = serve_http(cfg, on_turn=hook)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status_a, body_a = _post_turn(port, {"text": "hi", "workspace": "alpha"})
        status_b, body_b = _post_turn(port, {"text": "hi", "workspace": "beta"})
        status_bad, _ = _post_turn(port, {"text": "hi", "workspace": "../evil"})
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert status_a == 200 and status_b == 200
    assert resolved[0]["workspace"] == "alpha"
    assert resolved[1]["workspace"] == "beta"
    assert resolved[0]["memory"] != resolved[1]["memory"]
    assert status_bad == 400
