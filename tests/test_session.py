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


@pytest.fixture(autouse=True)
def _wt_root(tmp_path, monkeypatch):
    monkeypatch.setenv("KLANKER_WORKTREE_DIR", str(tmp_path / "wts"))
    monkeypatch.setenv("GIT_AUTHOR_NAME", "t")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "t@t")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "t")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "t@t")


def _head(repo):
    return _git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()


def test_worktree_outside_repo_and_idempotent(repo, tmp_path):
    wt = ensure_worktree(repo, "sessx1234")
    assert (wt / ".git").exists()
    assert tmp_path / "wts" in wt.parents
    assert repo not in wt.parents
    assert _head(wt) == "klanker/s-sessx123"
    assert (wt / "f.txt").read_text() == "v1"
    assert ensure_worktree(repo, "sessx1234") == wt
    # the user's checkout stays clean -- no untracked worktree dirs
    assert _git(repo, "status", "--porcelain").stdout.strip() == ""


def test_checkpoint_commits_only_in_worktree(repo):
    wt = ensure_worktree(repo, "s1aaaaaa")
    (wt / "new.txt").write_text("wip")
    (repo / "user.txt").write_text("user edit on main")
    res = checkpoint(repo, "s1aaaaaa", "dev-a")
    assert res["committed"] is True
    assert res["unpushed"] is True  # no remote configured
    assert res["worktree"] == str(wt)
    assert "wip(klanker): checkpoint session s1aaaaaa" in _git(
        wt, "log", "-1", "--pretty=%s").stdout
    # user's checkout untouched: still on main, edit still uncommitted
    assert _head(repo) == "main"
    assert "user.txt" in _git(repo, "status", "--porcelain").stdout
    assert "user.txt" not in _git(
        repo, "ls-tree", session_branch("s1aaaaaa"), "--name-only").stdout


def test_checkpoint_with_existing_worktree_no_crash(repo):
    """Regression: checkout of a branch held by a worktree used to raise."""
    ensure_worktree(repo, "s2bbbbbb")
    res = checkpoint(repo, "s2bbbbbb")
    assert res["error"] == ""
    assert res["committed"] is False


def test_other_session_worktree_never_committed(repo):
    ensure_worktree(repo, "AAAAAAAA1")
    wt_b = ensure_worktree(repo, "BBBBBBBB2")
    (wt_b / "b.txt").write_text("b")
    res = checkpoint(repo, "BBBBBBBB2")
    assert res["committed"] is True
    files = _git(wt_b, "show", "--name-only", "--format=", "HEAD").stdout.split()
    assert files == ["b.txt"]


def test_checkpoint_without_worktree_is_noop(repo):
    res = checkpoint(repo, "nowt0000")
    assert res["error"] == "no session worktree"
    assert _head(repo) == "main"
    assert _git(repo, "branch", "--list", "klanker/*").stdout.strip() == ""


def test_checkpoint_pushes_to_reachable_remote(repo, tmp_path):
    bare = tmp_path / "remote.git"
    _git(tmp_path, "init", "--bare", str(bare))
    _git(repo, "remote", "add", "origin", str(bare))
    wt = ensure_worktree(repo, "s5eeeeee")
    (wt / "p.txt").write_text("p")
    res = checkpoint(repo, "s5eeeeee")
    assert res["pushed"] is True and res["unpushed"] is False
    assert session_branch("s5eeeeee") in _git(bare, "branch").stdout


def test_checkpoint_unreachable_remote_flags_unpushed(repo, tmp_path):
    _git(repo, "remote", "add", "origin", str(tmp_path / "missing.git"))
    wt = ensure_worktree(repo, "s6ffffff")
    (wt / "q.txt").write_text("q")
    res = checkpoint(repo, "s6ffffff")
    assert res["committed"] is True
    assert res["unpushed"] is True and res["pushed"] is False


def test_switch_host_full_flow(conn, repo):
    bind_session(conn, "s4cccccc", "dev-a", node="hostA")
    wt = ensure_worktree(repo, "s4cccccc")
    (wt / "wip.txt").write_text("half-done")
    res = switch_host(conn, "s4cccccc", "dev-b", repo=repo, old_host="dev-a",
                      node="hostA")
    assert res["bound"] is True
    assert res["checkpoint"]["committed"] is True
    assert res["checkpoint"]["unpushed"] is True
    v = session_view(conn, "s4cccccc")
    assert v["host"] == "dev-b"
    assert v["wip_unpushed"] is True
    assert _head(repo) == "main"


def test_switch_host_pure_chat_without_worktree(conn, repo):
    res = switch_host(conn, "chat0000", "dev-b", repo=repo, node="hostA")
    assert res["bound"] is True
    assert session_view(conn, "chat0000")["host"] == "dev-b"


def test_bind_actor_host_scoped_and_seq_monotonic(conn):
    bind_session(conn, "s7", "dev-a", node="hostA")
    bind_session(conn, "s7", "dev-b", node="hostA")
    set_wip_unpushed(conn, "s7", True, node="hostA")
    rows = conn.execute(
        "SELECT origin_actor, origin_seq FROM tx"
        " WHERE origin_actor LIKE 'bind@%' ORDER BY id").fetchall()
    assert rows == [("bind@hostA:s7", 1), ("bind@hostA:s7", 2),
                    ("bind@hostA:s7", 3)]
