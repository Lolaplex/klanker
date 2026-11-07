"""Regression gates from the briefing QA receipt and coverage cases.

These call Klanker directly. They do not use QA_SHIM_TIMEZONE and they are
not an HTTP or live-model run.
"""

from __future__ import annotations

from datetime import date

from klanker.evidence import (
    briefings_path,
    harness_final_check,
    investigate,
    render_report,
    review_turn,
)


def _nested(**extra: object) -> dict:
    payload = {
        "schema": "agents_memory.write_receipt.v1",
        "id": "user/notes/qa",
        "path": "user/notes/qa",
        "sha256": "abc",
        "bytes": 4,
        "written_at": "2026-11-07T00:00:00Z",
        "verified": True,
    }
    payload.update(extra)
    return payload


def _receipt(tool: str, nested: dict | None, success: object = True) -> dict:
    item: dict = {
        "schema": "agents_harness.tool_receipt.v1",
        "tool": tool,
        "args_digest": "digest-" + tool,
        "success": success,
    }
    if nested is not None:
        item["receipt"] = nested
    return item


def _assert_unevidenced(findings: list[str]) -> None:
    assert findings
    blob = " ".join(findings).lower()
    assert "unevidenced save claim" in blob
    assert "did not happen" not in blob
    assert "retry" not in blob
    assert "keep every sentence" in blob


def test_legacy_fields_do_not_clear_a_save():
    claim = "I saved the summary to memory."
    missing = _nested()
    missing.pop("verified")
    cases = {
        "no-receipt": [],
        "verified-false": [_receipt("mcp.memory.add", _nested(verified=False))],
        "verified-missing": [_receipt("mcp.memory.add", missing)],
        "verified-null": [_receipt("mcp.memory.add", _nested(verified=None))],
        "verified-string-true": [_receipt("mcp.memory.add", _nested(verified="true"))],
        "verified-string-false": [_receipt("mcp.memory.add", _nested(verified="false"))],
        "verified-one": [_receipt("mcp.memory.add", _nested(verified=1))],
        "bare-success": [_receipt("mcp.memory.add", None)],
        "success-false": [_receipt("mcp.memory.add", _nested(), success=False)],
        "success-string": [_receipt("mcp.memory.add", _nested(), success="true")],
        "verified-true": [_receipt("mcp.memory.add", _nested(verified=True))],
    }
    for name, receipts in cases.items():
        _assert_unevidenced(harness_final_check(claim, receipts))


def test_stale_orange_and_current_violet_do_not_clear():
    stale = _receipt(
        "mcp.memory.add",
        _nested(id="user/notes/orange", path="user/notes/orange", verified=True, sha256="aa" * 32),
    )
    current = _receipt(
        "mcp.memory.add",
        _nested(id="user/notes/violet", path="user/notes/violet", verified=False, sha256="bb" * 32),
    )
    claims = (
        "I saved the summary to memory.",
        "I saved the orange note to memory.",
        "I saved the violet briefing to memory.",
    )
    for claim in claims:
        _assert_unevidenced(harness_final_check(claim, [stale]))
        _assert_unevidenced(harness_final_check(claim, [stale, current]))


def test_contradictory_id_and_path_do_not_clear_either_name():
    mixed = _receipt(
        "mcp.memory.add",
        _nested(id="user/notes/violet", path="user/notes/orange", verified=True),
    )
    for claim in (
        "I saved the violet briefing to memory.",
        "I saved the orange note to memory.",
    ):
        _assert_unevidenced(harness_final_check(claim, [mixed]))


def test_same_path_does_not_clear_a_different_fact():
    stored = _receipt(
        "mcp.memory.add",
        _nested(id="user/notes/orange", path="user/notes/orange", verified=True, sha256="aa" * 32),
    )
    _assert_unevidenced(harness_final_check("I saved the orange note to memory.", [stored]))
    _assert_unevidenced(
        harness_final_check("I saved the orange note to memory. The fact text is BETA.", [stored])
    )


def test_schedule_receipt_and_other_target_do_not_authorize_a_save():
    claim = "I saved the summary to memory."
    violet = "I saved the violet briefing to memory."
    both = "I saved the orange note to memory. I saved the violet note to memory."
    unrelated = _receipt(
        "mcp.schedule.add",
        _nested(id="user/notes/unrelated", path="user/notes/unrelated"),
    )
    orange = _receipt("mcp.memory.add", _nested(id="user/notes/orange", path="user/notes/orange"))
    _assert_unevidenced(harness_final_check(claim, [unrelated]))
    _assert_unevidenced(harness_final_check(violet, [orange]))
    _assert_unevidenced(harness_final_check(both, [orange]))
    _assert_unevidenced(harness_final_check("I saved the orange note to memory.", [orange]))


def test_named_target_without_receipt_id_is_not_supported():
    nameless = _nested(id="", path="")
    receipt = _receipt("mcp.memory.add", nameless)
    findings = harness_final_check("I saved the violet briefing to memory.", [receipt])
    assert findings
    assert any("violet" in item for item in findings)


def test_limit_without_eof_is_not_a_full_read():
    """Unit check of review_turn only. The live final_check does not see reads."""
    prior = "tool output clipped:\nHEAD"
    evidence = "HEAD is the start of a longer file"
    partial = review_turn(
        "HEAD is the start.",
        prior_context=prior,
        tool_calls=[{"name": "read_content", "ok": True, "arguments": {"limit": 1}}],
        evidence=evidence,
    )
    assert any(item.startswith("truncated:") for item in partial)
    covered = review_turn(
        "HEAD is the start.",
        prior_context=prior,
        tool_calls=[
            {
                "name": "read_content",
                "ok": True,
                "arguments": {"offset": 0, "limit": -1},
                "page": {
                    "offset": 0,
                    "limit": -1,
                    "text": evidence,
                    "total_chars": len(evidence),
                    "truncated": False,
                },
            }
        ],
        evidence=evidence,
    )
    assert not any(item.startswith("truncated:") for item in covered)


def test_memory_miss_does_not_hide_home_dated_files(monkeypatch, tmp_path):
    home = tmp_path / "agents"
    work = tmp_path / "workspace"
    monkeypatch.setenv("AGENTS_HOME", str(home))
    monkeypatch.setenv("AGENTS_WORKSPACE_DIR", str(work))
    monkeypatch.setenv("AGENTS_ROUTINE_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("AGENTS_SCHEDULES_DIR", str(tmp_path / "schedules"))
    dated = briefings_path()
    dated.mkdir(parents=True)
    (dated / "2026-10-20.md").write_text("OUTSIDE_WORKSPACE_FACT_DAY_20\n", encoding="utf-8")
    folder = work / "briefings"
    folder.mkdir(parents=True)
    (folder / "2026-10-19.md").write_text("DISTINGUISHING_FACT_DAY_19\n", encoding="utf-8")
    (work / "notes.md").write_text("A mention of 2026-10-20 is not that day's file.\n", encoding="utf-8")
    report = investigate(
        date(2026, 10, 19),
        date(2026, 10, 21),
        include_defaults=True,
        tool_results={"memory": "no hit", "traces": "no hit"},
    )
    rendered = render_report(report)
    assert "2026-10-20" not in report["gaps"]
    assert any("briefings/2026-10-20.md" in rec["path"] for rec in report["days"][1]["records"])
    assert "OUTSIDE_WORKSPACE_FACT_DAY_20" not in rendered
    assert "DISTINGUISHING_FACT_DAY_19" not in rendered
    assert "not opened" in rendered
    absence = "There were no briefings from 2026-10-19 to 2026-10-21. Nothing exists for that range."
    assert any(item.startswith("absence:") for item in harness_final_check(absence, []))
