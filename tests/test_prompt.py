"""Focused prompt-surface regression checks."""
from klanker.prompt import _probe_user_memory_empty, build_system_prompt
from klanker.sensing import HostCapabilities, probe_host


def test_prompt_has_no_dead_openui_genui_block(monkeypatch):
    monkeypatch.setenv("KLANKER_GENUI", "1")
    text = build_system_prompt(probe_host())
    assert "```openui" not in text
    assert "Strictly FORBIDDEN" not in text


def _caps():
    return HostCapabilities(os_name="test", is_tty=False, python_version="3.12")


def _fake_workspace(monkeypatch, tmp_path):
    ws = tmp_path / "host" / "workspaces" / "default"
    ws.mkdir(parents=True)

    class FakeWorkspace:
        dir = ws
        workdir = ws / "work"
        id = "default"

    monkeypatch.setattr("klanker.prompt.Workspace.from_env", classmethod(lambda cls: FakeWorkspace()))
    monkeypatch.setattr("klanker.prompt.evidence_policy_lines", lambda: [])
    return ws


def test_probe_user_memory_empty_true(tmp_path):
    ws = tmp_path / "host" / "workspaces" / "default"
    (ws / "memory").mkdir(parents=True)
    (ws / "memory" / "LAYOUT.md").write_text("# layout\n", encoding="utf-8")
    assert _probe_user_memory_empty(ws) is True


def test_probe_user_memory_empty_false_for_user_or_fact_file(tmp_path):
    ws = tmp_path / "host" / "workspaces" / "default"
    (ws / "memory").mkdir(parents=True)
    (ws / "memory" / "USER.md").write_text("# user\nprefers concise German replies\n", encoding="utf-8")
    assert _probe_user_memory_empty(ws) is False


def test_prompt_empty_memory_skips_search_probe(monkeypatch, tmp_path):
    ws = _fake_workspace(monkeypatch, tmp_path)
    (ws / "memory").mkdir(parents=True)
    text = build_system_prompt(_caps())
    assert "User memory state: EMPTY" in text
    assert "Do NOT call mcp.memory.search" in text
    assert "POPULATED" not in text


def test_prompt_populated_memory_makes_search_conditional(monkeypatch, tmp_path):
    ws = _fake_workspace(monkeypatch, tmp_path)
    (ws / "memory" / "user").mkdir(parents=True)
    (ws / "memory" / "user" / "USER.md").write_text("prefers terse answers\n", encoding="utf-8")
    text = build_system_prompt(_caps())
    assert "User memory state: POPULATED" in text
    assert "Only call mcp.memory.search" in text
    assert "EMPTY (no facts stored yet)" not in text
