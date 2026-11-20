"""Tests for klanker cron add — koru schedule synthesis (dry-run + apply)."""

import json
import os
import sys

import pytest
from agents_workspace import Host, Workspace

from klanker.__main__ import parse_cli_args
from klanker import flows


@pytest.fixture()
def host(tmp_path, monkeypatch):
    for var in list(os.environ):
        if var.startswith("AGENTS_"):
            monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    h = Host.from_env()
    h.create("alpha")
    monkeypatch.setenv("AGENTS_WORKSPACE", "alpha")
    return h


def _args(argv):
    args, _ = parse_cli_args(argv)
    return args


def test_dry_run_validates_without_registering(host):
    args = _args([
        "cron", "add",
        "--name", "standup",
        "--natural", "every morning 8",
        "--text", "post standup",
        "--sched-user", "u1",
        "--channel", "local",
    ])
    manifest = flows.synthesize_flow(args, apply=False)
    assert manifest["_registered"] is False
    for key in ("name", "verb", "cadence", "rests_on"):
        assert manifest[key], key
    live = Workspace.from_env().schedules
    assert not (live / "standup.json").exists()


def test_apply_registers_live(host):
    args = _args([
        "cron", "add",
        "--name", "traces_sync",
        "--verb", "python -m agents_traces stats",
        "--cadence", "hourly",
        "--apply",
    ])
    manifest = flows.synthesize_flow(args, apply=True)
    assert manifest["_registered"] is True
    path = Workspace.from_env().schedules / "traces_sync.json"
    assert path.is_file()
    row = json.loads(path.read_text(encoding="utf-8"))
    assert row["name"] == "traces_sync"
    assert row["cadence"] == "hourly"
    assert row["verb"] == "python -m agents_traces stats"


def test_invalid_schedule_rejected(host):
    args = _args(["cron", "add", "--name", "broken", "--verb", "echo hi"])
    with pytest.raises(ValueError):
        flows.synthesize_flow(args, apply=False)


def test_dispatch_dry_run(capsys, host):
    args = _args([
        "cron", "add", "--name", "x", "--cadence", "daily",
        "--verb", "python -c pass",
    ])
    rc = flows.dispatch(args)
    out = capsys.readouterr().out
    assert rc == 0
    assert "dry-run" in out
    assert '"_registered": false' in out


def test_parser_flags():
    args = _args(["cron", "add", "--name", "n", "--natural", "weekdays 9",
                  "--verb", "v", "--apply", "--one-shot"])
    assert args.op == "add"
    assert args.natural == "weekdays 9"
    assert args.apply is True
    assert args.one_shot is True
