"""Evidence policy: a memory miss is not absence, and a save needs a tool call.

The fixture is a synthetic 14-day routine-run tree plus a clipped earlier turn.
It is not a personal workspace.
"""

from __future__ import annotations

import json
from argparse import Namespace
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from klanker.__main__ import parse_cli_args
from klanker.evidence import (
    asks_permission_for_read,
    claims_global_absence,
    flag_unbacked_side_effects,
    investigate,
    iter_days,
    read_source,
    record_routine_run,
    recover_truncated,
    render_report,
    review_turn,
    routine_runs_path,
    run_evidence,
    workspace_path,
)
from klanker.prompt import build_system_prompt
from klanker.routine import add_routine, perform_routine
from klanker.sensing import probe_host

START = date(2026, 10, 19)
END = date(2026, 11, 1)
GAP_DAYS = {date(2026, 10, 22), date(2026, 10, 31)}
QUIET_DAY = date(2026, 10, 23)
FOCUS = date(2026, 10, 20)

CLIPPED = (
    "Earlier turn (tool output clipped):\n"
    "# 2026-10-20\n"
    "Next step: rotate ... [truncated]\n"
)

BAD_REPLY = (
    "I searched memory and there were no briefings from 2026-10-19 to 2026-11-01.\n"
    "May I use the terminal for a read-only investigation?\n"
    "Summary: 11 critical items. No reboot required.\n"
    "I saved the summary to memory.\n"
)


def _isolate(monkeypatch, tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    runs = tmp_path / "routine-runs"
    work = tmp_path / "workspace"
    sched = tmp_path / "schedules"
    memory = tmp_path / "memory"
    for path in (work, sched, memory):
        path.mkdir()
    monkeypatch.setenv("AGENTS_ROUTINE_RUNS_DIR", str(runs))
    monkeypatch.setenv("AGENTS_WORKSPACE_DIR", str(work))
    monkeypatch.setenv("AGENTS_SCHEDULES_DIR", str(sched))
    monkeypatch.setenv("AGENTS_HOME", str(tmp_path / "agents-home"))
    return runs, work, sched, memory


def _seed_runs() -> None:
    for day in iter_days(START, END):
        if day in GAP_DAYS:
            continue
        if day == QUIET_DAY:
            reply, status = "NO_UPDATE", "no_update"
        elif day == FOCUS:
            reply = "Next step: rotate the deploy key.\nDisk use is high.\n"
            status = "local"
        else:
            reply, status = f"Next step: close item {day.isoformat()}.\n", "local"
        record_routine_run(
            {"name": "daily", "session": "routine:daily", "channel": "local"},
            minute=f"{day.isoformat()}T08:00",
            status=status,
            reply=reply,
        )


def _report(runs: Path, work: Path, sched: Path) -> dict:
    return investigate(
        START,
        END,
        roots=[
            ("routine_runs", runs),
            ("workspace", work),
            ("schedules", sched),
        ],
        tool_results={"memory": "no hit", "traces": "no hit"},
    )


def test_prompt_requires_evidence_before_absence(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    text = build_system_prompt(probe_host())
    for phrase in (
        "No hit in <source>",
        "does not exist",
        "every calendar day",
        "Do not ask permission",
        "truncated",
        "not in the retrieved text",
        "this turn",
        "mcp.memory.add",
        "mcp.memory.write",
        "mcp.schedule.add",
        "index.jsonl",
        "klanker evidence",
        "routine:<name>",
        "mcp.traces.sessions",
        "mcp.traces.inspect",
        "no_update",
        "AGENTS_ROUTINE_RUNS_KEEP_DAYS",
        "newest 2000",
        "read_content",
        "mcp.terminal.list",
        "mcp.terminal.read",
        "mcp.terminal.grep",
        "mcp.terminal.stat",
        "agents_memory.write_receipt.v1",
        "Do not ask permission",
        routine_runs_path().as_posix(),
        workspace_path().as_posix(),
    ):
        assert phrase in text, phrase


def test_readme_does_not_list_agents_docs():
    readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
    assert "agents-docs" not in readme
    assert "agents_docs" not in readme


def test_saved_claim_requires_a_memory_write():
    claim = "I saved the summary to memory."
    assert flag_unbacked_side_effects(claim, [])
    assert flag_unbacked_side_effects(claim, [{"name": "mcp.memory.search", "ok": True}])
    assert flag_unbacked_side_effects(claim, [{"name": "mcp.memory.add", "ok": False}])
    assert flag_unbacked_side_effects(claim, [{"name": "mcp.memory.add", "status": "denied"}])
    executed = flag_unbacked_side_effects(claim, [{"name": "mcp.memory.add", "ok": True}])
    assert executed
    assert "unevidenced save claim" in " ".join(executed)
    assert "retry" not in " ".join(executed).lower()
    wrapped = [{"name": "call_job", "ok": True, "arguments": {"name": "mcp.memory.add", "fact": "summary"}}]
    assert flag_unbacked_side_effects(claim, wrapped)
    assert flag_unbacked_side_effects("I scheduled a reminder.", [])
    assert flag_unbacked_side_effects("I sent the message.", [{"name": "mcp.memory.add", "ok": True}])


def test_read_only_permission_ask_is_flagged():
    assert asks_permission_for_read("May I use the terminal for a read-only investigation?")
    assert not asks_permission_for_read("Should I delete the file?")
    assert not asks_permission_for_read("Do not ask permission for a read-only investigation.")


def test_fourteen_day_tree_and_clipped_turn(monkeypatch, tmp_path):
    runs, work, sched, memory = _isolate(monkeypatch, tmp_path)
    assert list(memory.iterdir()) == []
    _seed_runs()
    weekly = work / "notes" / "weekly.md"
    weekly.parent.mkdir()
    weekly.write_text("See 2026-10-22 notes.\nNo day heading.\n", encoding="utf-8")
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "2026-10-22.md").write_text("# 2026-10-22\nNot a known source.\n", encoding="utf-8")

    assert len(iter_days(START, END)) == 14
    report = _report(runs, work, sched)
    assert [row["day"] for row in report["days"]] == [day.isoformat() for day in iter_days(START, END)]
    assert report["gaps"] == ["2026-10-22", "2026-10-31"]
    assert report["checked"]["memory"] == "no hit"
    assert report["checked"]["traces"] == "no hit"
    assert not claims_global_absence(render_report(report))
    assert "there were no" not in render_report(report).lower()

    quiet = next(row for row in report["days"] if row["day"] == QUIET_DAY.isoformat())
    assert quiet["gap"] is False
    assert quiet["records"][0]["status"] == "no_update"
    assert len(quiet["records"]) == 1

    focus = next(row for row in report["days"] if row["day"] == FOCUS.isoformat())
    assert len(focus["records"]) == 1
    focus_path = Path(focus["records"][0]["path"])
    body, gap = read_source(focus_path)
    assert gap is None
    assert "rotate the deploy key" in body
    assert "11 critical" not in body
    assert "reboot" not in body.lower()

    undated_paths = [item["path"] for item in report["undated"]]
    assert any(path.endswith("weekly.md") for path in undated_paths)
    assert all("elsewhere" not in path for path in undated_paths)
    assert "2026-10-22" in report["gaps"]

    issues = review_turn(
        BAD_REPLY,
        tool_calls=[{"name": "mcp.memory.search", "ok": True}],
        checked={"memory": "no hit"},
        evidence=CLIPPED,
        prior_context=CLIPPED,
    )
    codes = [item.split(":", 1)[0] for item in issues]
    assert "absence" in codes
    assert "permission" in codes
    assert "truncated" in codes
    assert "side_effect" in codes
    assert "unsupported" in codes
    assert any("routine_runs" in item for item in issues)
    assert any("traces" in item for item in issues)
    assert any("workspace" in item for item in issues)
    assert any("number 11" in item for item in issues)
    assert any("reboot" in item for item in issues)

    recovered, missing = recover_truncated(CLIPPED, [runs, work])
    assert missing is None
    assert "rotate the deploy key" in recovered
    assert "11 critical" not in recovered
    assert "reboot" not in recovered.lower()

    empty = tmp_path / "empty"
    empty.mkdir()
    nothing, missing = recover_truncated(CLIPPED, [empty])
    assert nothing == ""
    assert missing is not None and missing.startswith("missing:")
    assert "11" not in missing
    assert "reboot" not in missing

    reply = render_report(report) + "\nRetrieved text:\n" + recovered
    evidence = recovered + "\n" + weekly.read_text(encoding="utf-8")
    clean = review_turn(
        reply,
        tool_calls=[{"name": "mcp.terminal", "ok": True, "command": f"cat {focus_path}"}],
        checked=report["checked"],
        evidence=evidence,
        prior_context=CLIPPED,
    )
    assert clean == [], clean

    invented = review_turn(
        "11 critical items. No reboot required.",
        tool_calls=[{"name": "mcp.terminal", "ok": True, "command": f"cat {focus_path}"}],
        checked=report["checked"],
        evidence=recovered,
        prior_context=CLIPPED,
    )
    assert any("number 11" in item for item in invented)
    assert any("reboot" in item for item in invented)


def test_search_miss_does_not_hide_files_on_disk(tmp_path):
    memory = tmp_path / "memory-tree"
    memory.mkdir()
    (memory / "2026-10-22.md").write_text("# 2026-10-22\nNext step: from disk.\n", encoding="utf-8")
    report = investigate(
        START,
        END,
        roots=[("memory", memory)],
        tool_results={"memory": "no hit", "traces": "no hit"},
    )
    assert "2026-10-22" not in report["gaps"]
    assert "file(s) on disk" in report["checked"]["memory"]
    issues = review_turn(
        "There were no briefings in that range.",
        checked=report["checked"],
        evidence="Next step: from disk.\n",
    )
    assert any(item.startswith("absence:") and "records" in item for item in issues)


def test_ambiguous_truncated_prefix_names_the_gap(tmp_path):
    root = tmp_path / "copies"
    for name in ("a", "b"):
        folder = root / name
        folder.mkdir(parents=True)
        (folder / "note.md").write_text("Next step: rotate the deploy key.\n", encoding="utf-8")
    text, gap = recover_truncated(CLIPPED, [root])
    assert text == ""
    assert gap is not None and "not choosing" in gap
    assert "11 critical" not in gap


def test_unreadable_source_names_the_path(tmp_path):
    missing = tmp_path / "gone.md"
    text, gap = read_source(missing)
    assert text == ""
    assert gap == f"missing: {missing} (not readable)"


def test_head_preview_does_not_clear_truncation():
    issues = review_turn(
        "Summary: 11 critical items.",
        tool_calls=[{"name": "mcp.terminal", "ok": True, "command": "head -n 5 note.md"}],
        prior_context=CLIPPED,
        evidence=CLIPPED,
        checked={
            "memory": "no hit",
            "traces": "no hit",
            "routine_runs": "no hit",
            "workspace": "no hit",
        },
    )
    assert any(item.startswith("truncated:") for item in issues)
    assert any("number 11" in item for item in issues)


def test_named_missing_span_is_not_a_truncated_summary():
    reply = "The earlier turn is truncated. Missing: the body after the first line. I cannot read it."
    issues = review_turn(reply, prior_context=CLIPPED, evidence=CLIPPED, tool_calls=[])
    assert not any(item.startswith("truncated:") for item in issues)


def test_scan_cap_blocks_absence(tmp_path):
    root = tmp_path / "many"
    root.mkdir()
    for offset in range(3):
        day = date(2026, 10, 19 + offset)
        (root / f"{day.isoformat()}.md").write_text(f"# {day.isoformat()}\nbody\n", encoding="utf-8")
    report = investigate(
        START,
        END,
        roots=[("workspace", root)],
        tool_results={"memory": "no hit", "traces": "no hit"},
        max_files=1,
    )
    assert report["scan_capped"] is True
    assert "Incomplete scan" in report["statement"]


def test_reversed_range_is_rejected():
    try:
        investigate(END, START)
    except ValueError as exc:
        assert "end is before start" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_evidence_cli_json_lists_gaps(monkeypatch, tmp_path, capsys):
    runs, work, sched, _memory = _isolate(monkeypatch, tmp_path)
    _seed_runs()
    code = run_evidence(Namespace(date_from="2026-10-19", date_to="2026-11-01", json=True, root=[]))
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["gaps"] == ["2026-10-22", "2026-10-31"]
    assert len(payload["days"]) == 14
    assert payload["checked"]["memory"] == "not scanned"
    assert payload["checked"]["traces"] == "not scanned"
    assert payload["checked"]["routine_runs"].endswith("record(s)")
    assert not claims_global_absence(payload["statement"])
    assert runs.is_dir() and work.is_dir() and sched.is_dir()

    args, prompt = parse_cli_args(["evidence", "--from", "2026-10-19", "--to", "2026-11-01", "--json"])
    assert args.command == "evidence"
    assert prompt == ""
    assert run_evidence(Namespace(date_from="nope", date_to="2026-10-19", json=False, root=[])) == 2


def test_perform_routine_records_a_findable_run(monkeypatch, tmp_path):
    runs, work, sched, _memory = _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("AGENTS_SCHEDULES_DIR", str(sched))
    job = add_routine(name="daily", prompt="check", user="local-user", cron="0 8 * * *", channel="local")
    with patch("klanker.routine.minute_key", return_value="2026-10-20T08:00"):
        result = perform_routine(
            job,
            force=True,
            turn=lambda _job: (0, "Next step: rotate the deploy key."),
            deliver=lambda *_args: None,
        )
        second = perform_routine(
            job,
            force=False,
            turn=lambda _job: (0, "should not run"),
            deliver=lambda *_args: None,
        )
    assert result["status"] == "delivered"
    assert "rotate the deploy key" in Path(result["artifact"]).read_text(encoding="utf-8")
    assert second["status"] == "skipped"
    assert "artifact" not in second
    index = (runs / "index.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(index) == 1

    with patch("klanker.routine.minute_key", return_value="2026-10-23T08:00"):
        quiet = perform_routine(job, force=True, turn=lambda _job: (0, "NO_UPDATE"))
    assert quiet["status"] == "no_update"
    assert "status: no_update" in Path(quiet["artifact"]).read_text(encoding="utf-8")

    with patch("klanker.routine.minute_key", return_value="2026-10-24T08:00"):
        failed = perform_routine(job, force=True, turn=lambda _job: (1, "boom"))
    assert failed["status"] == "failed"
    assert "boom" in Path(failed["artifact"]).read_text(encoding="utf-8")

    report = _report(runs, work, sched)
    assert "2026-10-20" not in report["gaps"]
    assert "2026-10-23" not in report["gaps"]
    assert "2026-10-24" not in report["gaps"]
    assert "2026-10-22" in report["gaps"]


_CHECKED = {
    "memory": "no hit",
    "traces": "no hit",
    "routine_runs": "1 record(s)",
    "workspace": "no hit",
}
_EVIDENCE = "Disk use is 80%. 2 packages need attention.\nNext step: rotate the deploy key.\n"


def test_numbers_in_the_source_are_not_flagged():
    reply = (
        "Checked sources:\n"
        "memory: no hit\n"
        "traces: no hit\n"
        "routine_runs: 1 record(s)\n"
        "workspace: no hit\n"
        "2026-10-20: routine_runs /tmp/daily/note.md status=local\n"
        "2026-10-22: gap (no record in the sources checked)\n"
        "Disk use is 80%. 2 packages need attention.\n"
        "Next step: rotate the deploy key.\n"
        "The notes do not mention a reboot.\n"
        "Nothing was saved to memory.\n"
    )
    issues = review_turn(
        reply,
        tool_calls=[{"name": "mcp.memory.read", "ok": True}],
        checked=_CHECKED,
        evidence=_EVIDENCE,
    )
    assert issues == [], issues


def test_german_reply_with_source_numbers_is_not_flagged():
    reply = (
        "Geprüfte Quellen:\n"
        "memory: kein Treffer\n"
        "traces: kein Treffer\n"
        "routine_runs: 1 Eintrag\n"
        "workspace: kein Treffer\n"
        "2026-10-20: Routine-Datei /tmp/daily/note.md\n"
        "2026-10-22: Lücke (kein Eintrag in den geprüften Quellen)\n"
        "Die Datei sagt: Disk use is 80%. 2 packages need attention.\n"
        "Es sind 2 Pakete. Die Platte liegt bei 80 Prozent.\n"
        "Nächster Schritt: rotate the deploy key.\n"
        "Ich habe nichts gespeichert.\n"
    )
    issues = review_turn(
        reply,
        tool_calls=[{"name": "mcp.terminal", "ok": True, "command": "cat /tmp/daily/note.md"}],
        checked=_CHECKED,
        evidence=_EVIDENCE,
    )
    assert issues == [], issues


def test_clean_reply_quoting_evidence_is_not_flagged():
    reply = (
        "I read the file. Disk use is 80% and 2 packages need attention. "
        "I did not write a summary.\n"
    )
    issues = review_turn(
        reply,
        tool_calls=[{"name": "mcp.memory.read", "ok": True}],
        checked=_CHECKED,
        evidence=_EVIDENCE,
    )
    assert issues == [], issues


def test_routine_runs_are_atomic_and_bounded(monkeypatch, tmp_path):
    runs, _work, _sched, _memory = _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("AGENTS_ROUTINE_RUNS_KEEP_DAYS", "10")
    monkeypatch.setenv("AGENTS_ROUTINE_RUNS_KEEP_COUNT", "3")
    today = date.today()
    days = [today - timedelta(days=offset) for offset in (40, 4, 3, 2, 1)]
    for day in days:
        record_routine_run(
            {"name": "daily", "session": "routine:daily", "channel": "local"},
            minute=f"{day.isoformat()}T08:00",
            status="local",
            reply=f"body {day.isoformat()}\n",
        )
    index_lines = (runs / "index.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(index_lines) == 3
    for line in index_lines:
        json.loads(line)
    kept = sorted(json.loads(line)["day"] for line in index_lines)
    assert kept == [(today - timedelta(days=offset)).isoformat() for offset in (3, 2, 1)]
    assert not (runs / "daily" / f"{(today - timedelta(days=40)).isoformat()}T08-00.md").exists()
    assert not (runs / "daily" / f"{(today - timedelta(days=4)).isoformat()}T08-00.md").exists()
    newest = runs / "daily" / f"{(today - timedelta(days=1)).isoformat()}T08-00.md"
    assert newest.read_text(encoding="utf-8").startswith("---\n")
    assert f"body { (today - timedelta(days=1)).isoformat() }" in newest.read_text(encoding="utf-8")

    again = record_routine_run(
        {"name": "daily", "session": "routine:daily", "channel": "local"},
        minute=f"{(today - timedelta(days=1)).isoformat()}T08:00",
        status="local",
        reply="updated body\n",
    )
    assert "updated body" in Path(again["path"]).read_text(encoding="utf-8")
    rewritten = (runs / "index.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(rewritten) == 3
    assert sum(1 for line in rewritten if json.loads(line)["day"] == (today - timedelta(days=1)).isoformat()) == 1

    with patch("klanker.evidence.os.replace", side_effect=OSError("replace failed")):
        try:
            record_routine_run(
                {"name": "daily", "session": "routine:daily", "channel": "local"},
                minute=f"{(today - timedelta(days=1)).isoformat()}T08:00",
                status="local",
                reply="partial should not land",
            )
        except OSError as exc:
            assert "replace failed" in str(exc)
        else:
            raise AssertionError("expected OSError")
    survived = newest.read_text(encoding="utf-8")
    assert "partial should not land" not in survived
    assert "updated body" in survived
    assert list(runs.rglob("*.tmp")) == []
