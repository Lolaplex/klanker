"""3-node gate runner: executes scripts/gate-two-host.py as a subprocess.

Spins up hub + two spokes of real `klanker serve` processes on free
loopback ports and drives pair/share/sync/bind/switch/revoke end-to-end
(klanker#154). ~2-3 min at KLANKER_GATE_TICK=4 — shorten locally via
KLANKER_GATE_TICK=2 / KLANKER_GATE_SCENARIOS=<csv>.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
GATE = REPO / "scripts" / "gate-two-host.py"
_spec = importlib.util.spec_from_file_location("gate_two_host_script", GATE)
GATE_MOD = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(GATE_MOD)


def test_gate_env_drops_inherited_parent_session(monkeypatch):
    """The suite can leak an in-process turn's parent-session binding;
    the hermetic gate must never bind its sessions to that stale id."""
    monkeypatch.setenv("AGENTS_PARENT_SESSION", "ses_flag")
    assert "AGENTS_PARENT_SESSION" not in GATE_MOD.base_env()


def test_two_host_gate():
    pytest.importorskip("agents_relay.channel_client")
    pytest.importorskip("agents_store.db")
    env = dict(os.environ)
    env.setdefault("KLANKER_GATE_TICK", "4")
    scenarios = [
        s.strip()
        for s in os.environ.get("KLANKER_GATE_SCENARIOS", "").split(",")
        if s.strip()
    ]
    argv = [sys.executable, str(GATE)]
    for s in scenarios:
        argv += ["--scenario", s]
    proc = subprocess.run(
        argv, capture_output=True, text=True, timeout=900, env=env)
    if proc.returncode != 0:
        tail = (proc.stdout or "")[-4000:] + "\n" + (proc.stderr or "")[-2000:]
        pytest.fail(f"gate-two-host rc={proc.returncode}:\n{tail}")
