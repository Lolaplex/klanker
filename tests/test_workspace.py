"""--workspace points the turn at a repo; the prompt gains a coding block."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any
from unittest.mock import patch

import klanker.__main__ as cli
from klanker.prompt import build_system_prompt
from klanker.sensing import HostCapabilities, probe_host


def _caps() -> HostCapabilities:
    return HostCapabilities(
        os_name="Linux",
        is_tty=False,
        python_version="3.10.0",
        suite_modules={"harness": True},
    )


def test_prompt_names_edit_and_write():
    text = build_system_prompt(probe_host())
    assert "mcp.terminal.edit" in text
    assert "mcp.terminal.write" in text
    assert "Do not use `mcp.terminal.run` for a file edit" in text


def test_git_workspace_adds_coding_block(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    monkeypatch.setenv("AGENTS_WORKSPACE_DIR", str(repo))
    text = build_system_prompt(probe_host())
    assert "Coding workspace" in text
    assert repo.as_posix() in text
    assert "AGENTS.md" in text
    assert "git push" in text


def test_non_git_workspace_has_no_coding_block(tmp_path, monkeypatch):
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setenv("AGENTS_WORKSPACE_DIR", str(work))
    text = build_system_prompt(probe_host())
    assert "Coding workspace" not in text


def test_workspace_flag_sets_env_for_spawned_loop(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.delenv("AGENTS_WORKSPACE_DIR", raising=False)
    monkeypatch.setenv("AGENTS_HOME", str(tmp_path / "home"))
    caps = _caps()
    assert cli.apply_workspace(str(repo)) is None

    nucleus = cli.Nucleus(caps=caps)
    with patch("klanker.nucleus.probe_host", return_value=caps), \
         patch("klanker.overlay.publish_modules_dir", return_value=None), \
         patch("subprocess.run") as mock_run:
        mock_run.return_value.returncode = 0
        rc = nucleus.run_turn(message="hi")

    assert rc == 0
    assert mock_run.called
    # subprocess.run inherits os.environ, so the child loop sees the workspace
    assert mock_run.call_args.kwargs.get("env") is None
    assert os.environ["AGENTS_WORKSPACE_DIR"] == str(repo.resolve())


def test_workspace_missing_path_exits_2(tmp_path, monkeypatch, capsys):
    missing = tmp_path / "nope"
    monkeypatch.delenv("AGENTS_WORKSPACE_DIR", raising=False)
    with patch("klanker.__main__.Nucleus") as nucleus_cls:
        rc = cli.main(["chat", "hi", "--workspace", str(missing)])
    assert rc == 2
    nucleus_cls.assert_not_called()
    assert "does not exist" in capsys.readouterr().err


def test_workspace_file_path_exits_2(tmp_path, monkeypatch, capsys):
    target = tmp_path / "file.txt"
    target.write_text("x", encoding="utf-8")
    monkeypatch.delenv("AGENTS_WORKSPACE_DIR", raising=False)
    with patch("klanker.__main__.Nucleus") as nucleus_cls:
        rc = cli.main(["chat", "hi", "--workspace", str(target)])
    assert rc == 2
    nucleus_cls.assert_not_called()
    assert "not a directory" in capsys.readouterr().err


def test_terminal_edit_counts_as_a_file_write():
    from klanker.evidence import flag_unbacked_side_effects

    calls: list[Mapping[str, Any]] = [
        {
            "name": "call_job",
            "ok": True,
            "arguments": {
                "name": "mcp.terminal",
                "arguments": {"command_name": "edit", "path": "a.py"},
            },
        }
    ]
    assert flag_unbacked_side_effects("I wrote the file.", calls) == []
    assert flag_unbacked_side_effects("I wrote the file.", []) != []


def test_prompt_subcommand_shows_coding_block(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    monkeypatch.setenv("AGENTS_HOME", str(tmp_path / "home"))
    with patch("klanker.updates.check_for_updates", return_value=None):
        rc = cli.main(["prompt", "--workspace", str(repo)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Coding workspace" in out
    assert repo.as_posix() in out
