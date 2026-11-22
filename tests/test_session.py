"""session host binding + worktree/checkpoint mechanics."""
import subprocess

import pytest
from agents_store.db import connect

from klanker.session import (bind_session, checkpoint, ensure_worktree,
                             session_branch, session_view, set_wip_unpushed,
                             switch_host)


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "store.db")
    yield c
    c.close()


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True)


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    _git(r, "init", "-b", "main")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "user.name", "t")
    (r / "f.txt").write_text("v1")
    _git(r, "add", "-A")
    _git(r, "commit", "-m", "init")
    return r


def test_bind_and_read(conn):
    bind_session(conn, "sess-1", "dev-a", branch="klanker/s-sess-1",
                 repo="/tmp/r")
    v = session_view(conn, "sess-1")
    assert v["host"] == "dev-a"
    assert v["branch"] == "klanker/s-sess-1"
    assert v["repo"] == "/tmp/r"


def test_switch_host_lww(conn):
    bind_session(conn, "s2", "dev-a")
    bind_session(conn, "s2", "dev-b")
    assert session_view(conn, "s2")["host"] == "dev-b"


def test_wip_flag(conn):
    bind_session(conn, "s3", "dev-a")
    set_wip_unpushed(conn, "s3", True)
    assert session_view(conn, "s3")["wip_unpushed"] is True
    set_wip_unpushed(conn, "s3", False)
    assert session_view(conn, "s3")["wip_unpushed"] is False


def test_branch_name():
    assert session_branch("abcdef123456") == "klanker/s-abcdef12"


def test_worktree_creates_branch(repo):
    wt = ensure_worktree(repo, "sessx1234")
    assert (wt / ".git").exists()
    out = _git(wt, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    assert out == "klanker/s-sessx123"
    assert (wt / "f.txt").read_text() == "v1"
    # idempotent
    assert ensure_worktree(repo, "sessx1234") == wt


def test_checkpoint_commits_dirty_on_session_branch(repo):
    _git(repo, "checkout", "-b", session_branch("s1"))
    (repo / "new.txt").write_text("wip")
    res = checkpoint(repo, "s1", "dev-a")
    assert res["committed"] is True
    assert res["unpushed"] is True  # no remote configured
    assert session_branch("s1") == _git(
        repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    assert "wip(klanker): checkpoint session s1" in _git(
        repo, "log", "-1", "--pretty=%s").stdout


def test_checkpoint_clean_tree_no_commit(repo):
    branch = session_branch("s2")
    _git(repo, "checkout", "-b", branch)
    n = _git(repo, "rev-list", "--count", "HEAD").stdout.strip()
    res = checkpoint(repo, "s2")
    assert res["committed"] is False
    assert _git(repo, "rev-list", "--count", "HEAD").stdout.strip() == n


def test_never_touches_user_main(repo):
    _git(repo, "checkout", "-b", session_branch("s3"))
    (repo / "x.txt").write_text("x")
    checkpoint(repo, "s3")
    main_tree = _git(repo, "ls-tree", "main", "--name-only").stdout
    assert "x.txt" not in main_tree


def test_switch_host_full_flow(conn, repo):
    bind_session(conn, "s4", "dev-a")
    _git(repo, "checkout", "-b", session_branch("s4"))
    (repo / "wip.txt").write_text("half-done")
    res = switch_host(conn, "s4", "dev-b", repo=repo, old_host="dev-a")
    assert res["bound"] is True
    assert res["checkpoint"]["committed"] is True
    assert res["checkpoint"]["unpushed"] is True
    v = session_view(conn, "s4")
    assert v["host"] == "dev-b"
    assert v["wip_unpushed"] is True
