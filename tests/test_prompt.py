"""Focused prompt-surface regression checks."""
from klanker.prompt import build_system_prompt
from klanker.sensing import probe_host


def test_prompt_has_no_dead_openui_genui_block(monkeypatch):
    monkeypatch.setenv("KLANKER_GENUI", "1")
    text = build_system_prompt(probe_host())
    assert "```openui" not in text
    assert "Strictly FORBIDDEN" not in text
