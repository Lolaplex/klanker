"""Suite-wide env hygiene: point the agent host at a per-test tmp dir so
tests stay deterministic on hosts that hold several workspaces.
Individual tests override via monkeypatch.setenv where needed."""
import pytest


@pytest.fixture(autouse=True)
def _isolated_host(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    monkeypatch.delenv("AGENTS_WORKSPACE", raising=False)
    # Never let an ensure path detach a real `klanker serve`: the child
    # would keep this tmp host env, bind :8787, and outlive the suite.
    monkeypatch.setenv("AGENTS_NO_AUTOSPAWN", "1")
