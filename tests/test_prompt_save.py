"""save_system_prompt writes <host>/run/klanker_prompt_<ws-id>.txt."""
from __future__ import annotations

from pathlib import Path

from klanker.prompt import save_system_prompt
from klanker.sensing import probe_host


def test_save_system_prompt_uses_host_run(tmp_path, monkeypatch):
    host = tmp_path / "agents-host"
    monkeypatch.setenv("AGENTS_HOST_DIR", str(host))
    monkeypatch.delenv("AGENTS_DIR", raising=False)
    path = save_system_prompt(probe_host())
    assert path == host / "run" / "klanker_prompt_default.txt"
    assert path.is_file()
    assert "Klanker" in path.read_text(encoding="utf-8")


def test_save_system_prompt_default_without_env(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENTS_HOST_DIR", raising=False)
    monkeypatch.delenv("AGENTS_DIR", raising=False)
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr("klanker.prompt.Path.home", lambda: fake_home)
    path = save_system_prompt(probe_host())
    # first start creates the default workspace under the default host
    assert path == (
        fake_home / ".agents" / "run" / "klanker_prompt_default.txt"
    )
    assert path.is_file()
