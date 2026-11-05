"""Harness content backend and final check, with the dev suite installed."""

from __future__ import annotations

import json

import pytest

from klanker.evidence import harness_final_check
from klanker.helpjson import build_manifests
from klanker.hooks import register_content_backend, register_harness_hooks


def _memory_receipt(**extra: object) -> dict:
    payload = {
        "schema": "agents_memory.write_receipt.v1",
        "id": "user/note",
        "path": "user/note",
        "sha256": "abc",
        "bytes": 4,
        "written_at": "2026-11-05T00:00:00Z",
        "verified": True,
    }
    payload.update(extra)
    return {
        "schema": "agents_harness.tool_receipt.v1",
        "tool": "mcp.memory.add",
        "args_digest": "digest",
        "success": True,
        "receipt": payload,
    }


def test_side_effects_metadata_wins_over_the_verb_name():
    spec = {
        "commands": {
            "grep": {"description": "search", "side_effects": "read-only", "usage": "agents-terminal grep PATTERN"},
            "stat": {"description": "stat", "side_effects": "read-only"},
            "read": {"description": "read", "side_effects": "read-only"},
            "list": {"description": "list", "side_effects": "mutating"},
            "run": {"description": "run", "side_effects": "mutating"},
        }
    }
    rows = {row["name"]: row for row in build_manifests(spec, alias="terminal", module="agents_terminal")}
    assert rows["mcp.terminal.grep"]["mutates"] is False
    assert rows["mcp.terminal.stat"]["mutates"] is False
    assert rows["mcp.terminal.read"]["mutates"] is False
    assert rows["mcp.terminal.grep"]["side_effects"] == "read-only"
    assert rows["mcp.terminal.list"]["mutates"] is True
    assert rows["mcp.terminal.run"]["mutates"] is True
    assert rows["mcp.terminal.list"]["side_effects"] == "mutating"


def test_saved_claim_needs_a_memory_write_receipt():
    claim = "I saved the summary to memory."
    assert harness_final_check(claim, [])
    bare = {
        "schema": "agents_harness.tool_receipt.v1",
        "tool": "mcp.memory.add",
        "success": True,
    }
    assert harness_final_check(claim, [bare])
    unverified = _memory_receipt(verified=False)
    assert harness_final_check(claim, [unverified])
    assert harness_final_check(claim, [_memory_receipt()]) == []


def test_content_backend_skips_when_traces_is_missing(monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "agents_traces", None)
    monkeypatch.setitem(sys.modules, "agents_traces.content", None)
    assert register_content_backend() is False


def test_clipped_trace_is_recovered_via_read_content(monkeypatch, tmp_path):
    pytest.importorskip("agents_traces")
    pytest.importorskip("runner")
    monkeypatch.setenv("AGENTS_TRACES_DIR", str(tmp_path / "traces"))
    monkeypatch.setenv("AGENTS_CONTENT_DIR", str(tmp_path / "content"))
    monkeypatch.setenv("AGENTS_NO_UPDATE_CHECK", "1")

    from agents_traces.content import INLINE_CONTENT_CHARS
    from agents_traces.models import TraceEvent
    from agents_traces.store import TraceStore
    from runner.retrieve import clear_content_backend, read_content

    marker = "UNIQUE_TAIL_MARKER"
    body = "HEAD " + ("a" * INLINE_CONTENT_CHARS) + marker
    session = "ses_clip"
    event = TraceEvent(
        session=session,
        type="tool_call",
        tool="mcp.terminal.read",
        result=body,
        status="ok",
    )
    TraceStore().append(event)
    digest = str((event.metadata or {}).get("result_digest") or "")
    assert digest
    assert marker not in str(event.result)

    clear_content_backend()
    try:
        missing = read_content(session, digest, offset=0, limit=-1)
        assert missing["available"] is False

        installed = register_harness_hooks()
        assert installed["content_backend"] is True
        assert installed["final_check"] is True
        page = read_content(session, digest, offset=0, limit=-1)
        assert page["available"] is True
        assert marker in page["text"]
        assert page["text"].startswith("HEAD ")
    finally:
        clear_content_backend()
        from runner import clear_final_check

        clear_final_check()


def test_saved_claim_without_receipt_triggers_revision_flag(monkeypatch, tmp_path, capsys):
    pytest.importorskip("runner")
    monkeypatch.setenv("AGENTS_TRACES_DIR", str(tmp_path / "traces"))
    monkeypatch.setenv("AGENTS_CONTENT_DIR", str(tmp_path / "content"))
    monkeypatch.setenv("AGENTS_IDENTITY_PATH", str(tmp_path / "identity.json"))
    monkeypatch.setenv("AGENTS_HOME", str(tmp_path / "agents"))
    monkeypatch.setenv("AGENTS_MODULES_DIR", str(tmp_path / "modules"))
    monkeypatch.setenv("AGENTS_SKILLS_DIR", str(tmp_path / "skills"))
    monkeypatch.setenv("AGENTS_MCP_CONFIG", str(tmp_path / "mcp.json"))
    monkeypatch.setenv("AGENTS_NO_UPDATE_CHECK", "1")

    from runner.providers import CompletionResult

    class Sticky:
        def __init__(self) -> None:
            self.calls = 0

        def complete(self, req):
            self.calls += 1
            return CompletionResult(text="I saved the summary to memory.")

    provider = Sticky()

    def fake_get_provider(_name: str = ""):
        return provider

    monkeypatch.setattr("runner.loop.get_provider", fake_get_provider)
    from klanker.turn import main
    from runner import clear_final_check
    from runner.retrieve import clear_content_backend

    try:
        code = main(
            [
                "--channel",
                "local",
                "--user",
                "tester",
                "--session",
                "ses_flag",
                "--detached-session",
                "--message",
                "hello",
                "--complete",
                "--deliver",
                "buffered",
                "--provider",
                "sticky",
            ]
        )
        captured = capsys.readouterr()
    finally:
        clear_content_backend()
        clear_final_check()
    assert code == 0
    assert provider.calls == 2
    assert "response flagged" in captured.err
    assert "I saved the summary to memory." in captured.out
    trailer = captured.out.split("---agents-loop-trailer---", 1)[1]
    payload = json.loads(trailer.strip().splitlines()[0])
    assert payload["response_flags"]
    assert any("memory" in flag for flag in payload["response_flags"])
