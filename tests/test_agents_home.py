"""save_system_prompt uses AGENTS_HOME, not AGENTS_DIR."""
from __future__ import annotations

from pathlib import Path

from klanker.prompt import save_system_prompt
from klanker.sensing import probe_host


def test_save_system_prompt_uses_agents_home(tmp_path, monkeypatch):
    home = tmp_path / "agents-home"
    monkeypatch.setenv("AGENTS_HOME", str(home))
    monkeypatch.delenv("AGENTS_DIR", raising=False)
    path = save_system_prompt(probe_host())
    assert path == home / "klanker_prompt.txt"
    assert path.is_file()
    assert "Klanker" in path.read_text(encoding="utf-8")


def test_save_system_prompt_default_without_env(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENTS_HOME", raising=False)
    monkeypatch.delenv("AGENTS_DIR", raising=False)
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr("klanker.prompt.Path.home", lambda: fake_home)
    path = save_system_prompt(probe_host())
    assert path == fake_home / ".agents" / "klanker_prompt.txt"
    assert path.is_file()
