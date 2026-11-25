"""session host binding + worktree/checkpoint mechanics."""
import subprocess
from pathlib import Path

import pytest
from agents_store.db import connect

from klanker import session as session_mod
from klanker.session import (InvalidSessionId, bind_session, checkpoint,
                             ensure_worktree, find_worktree, remove_worktree,
                             session_branch, session_view, set_wip_unpushed,
                             switch_host, worktree_path)


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "store.db")
    yield c
    c.close()


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, check=True)



def _can_symlink(tmp_path):
    probe = tmp_path / ".symlink-probe"
    try:
        probe.symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        return False
    probe.unlink()
    return True

@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    _git(r, "init", "-b", "main")
    _git(r, "config", "user.email", "t@t")
    _git(r, "config", "user.name", "t")
    (r / "f.txt").write_text("v1", encoding="utf-8")
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
    assert session_branch("abcdef123456") == "klanker/s-abcdef123456"


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
    assert _head(wt) == "klanker/s-sessx1234"
    assert (wt / "f.txt").read_text(encoding="utf-8") == "v1"
    assert ensure_worktree(repo, "sessx1234") == wt
    # the user's checkout stays clean -- no untracked worktree dirs
    assert _git(repo, "status", "--porcelain").stdout.strip() == ""


def test_checkpoint_commits_only_in_worktree(repo):
    wt = ensure_worktree(repo, "s1aaaaaa")
    (wt / "new.txt").write_text("wip", encoding="utf-8")
    (repo / "user.txt").write_text("user edit on main", encoding="utf-8")
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
    (wt_b / "b.txt").write_text("b", encoding="utf-8")
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
    (wt / "p.txt").write_text("p", encoding="utf-8")
    res = checkpoint(repo, "s5eeeeee")
    assert res["pushed"] is True and res["unpushed"] is False
    assert session_branch("s5eeeeee") in _git(bare, "branch").stdout


def test_checkpoint_unreachable_remote_flags_unpushed(repo, tmp_path):
    _git(repo, "remote", "add", "origin", str(tmp_path / "missing.git"))
    wt = ensure_worktree(repo, "s6ffffff")
    (wt / "q.txt").write_text("q", encoding="utf-8")
    res = checkpoint(repo, "s6ffffff")
    assert res["committed"] is True
    assert res["unpushed"] is True and res["pushed"] is False


def test_switch_host_full_flow(conn, repo):
    bind_session(conn, "s4cccccc", "dev-a", node="hostA")
    wt = ensure_worktree(repo, "s4cccccc")
    (wt / "wip.txt").write_text("half-done", encoding="utf-8")
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


# -- session id / path hardening ---------------------------------------------

@pytest.mark.parametrize("bad", [
    "/tmp/qax", "../../etc", "..", "a/b", "a\\b", "", " sess", "s.1",
    "sess\x00x", "x" * 200, None,
])
def test_invalid_session_ids_refused(repo, tmp_path, bad):
    with pytest.raises(InvalidSessionId):
        ensure_worktree(repo, bad)
    with pytest.raises(InvalidSessionId):
        session_branch(bad)
    # nothing was created anywhere
    assert not (tmp_path / "qax").exists()
    assert _git(repo, "worktree", "list", "--porcelain").stdout.count(
        "worktree ") == 1


def test_absolute_session_id_never_creates_worktree_at_that_path(repo):
    target = Path("/tmp/qax-klanker-test")
    with pytest.raises(InvalidSessionId):
        ensure_worktree(repo, str(target))
    assert not target.exists()


def test_checkpoint_and_switch_refuse_invalid_id(conn, repo):
    cp = checkpoint(repo, "../evil")
    assert "invalid session id" in cp["error"]
    assert not cp["committed"]
    res = switch_host(conn, "../evil", "h2", repo=repo)
    assert res["bound"] is False


def test_symlinked_repo_dir_under_root_refused(repo, tmp_path):
    if not _can_symlink(tmp_path):
        pytest.skip("symlink privilege required")
    outside = tmp_path / "outside"
    outside.mkdir()
    probe = worktree_path(repo, "sessaaaa")
    probe.parent.parent.mkdir(parents=True, exist_ok=True)
    probe.parent.symlink_to(outside, target_is_directory=True)
    with pytest.raises(InvalidSessionId):
        ensure_worktree(repo, "sessaaaa")
    assert list(outside.iterdir()) == []


def test_symlinked_session_dir_refused(repo, tmp_path):
    if not _can_symlink(tmp_path):
        pytest.skip("symlink privilege required")
    outside = tmp_path / "outside2"
    outside.mkdir()
    probe = worktree_path(repo, "sessbbbb")
    probe.parent.mkdir(parents=True, exist_ok=True)
    probe.symlink_to(outside, target_is_directory=True)
    with pytest.raises(InvalidSessionId):
        ensure_worktree(repo, "sessbbbb")
    assert list(outside.iterdir()) == []


def test_symlinked_root_is_resolved_and_allowed(repo, tmp_path, monkeypatch):
    if not _can_symlink(tmp_path):
        pytest.skip("symlink privilege required")
    real = tmp_path / "realroot"
    real.mkdir()
    link = tmp_path / "linkroot"
    link.symlink_to(real, target_is_directory=True)
    monkeypatch.setenv("KLANKER_WORKTREE_DIR", str(link))
    wt = ensure_worktree(repo, "sesscccc")
    assert real.resolve() in wt.parents


def test_remove_worktree(repo):
    wt = ensure_worktree(repo, "sessdddd")
    res = remove_worktree(repo, "sessdddd")
    assert res["removed"] and not res["error"]
    assert not wt.exists()
    # branch kept by default (may back a PR)
    assert _git(repo, "rev-parse", "--verify", "--quiet",
                "refs/heads/klanker/s-sessdddd").returncode == 0
    # idempotent, then branch deletion on request
    res = remove_worktree(repo, "sessdddd", delete_branch=True)
    assert not res["removed"] and res["branch_deleted"]


def test_remove_worktree_refuses_dirty_unless_forced(repo):
    wt = ensure_worktree(repo, "sesseeee")
    (wt / "f.txt").write_text("dirty", encoding="utf-8")
    res = remove_worktree(repo, "sesseeee")
    assert not res["removed"] and res["error"]
    assert wt.exists()
    res = remove_worktree(repo, "sesseeee", force=True, delete_branch=True)
    assert res["removed"] and res["branch_deleted"]
    assert not wt.exists()


def test_remove_worktree_invalid_id(repo):
    assert "invalid session id" in remove_worktree(repo, "/tmp/x")["error"]



# -- QA recheck: id collisions, foreign worktrees, newline, TOCTOU ----------

def _branch_exists(repo, branch):
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", "--quiet",
         f"refs/heads/{branch}"], capture_output=True).returncode == 0


def test_shared_prefix_sessions_do_not_collide(repo):
    a = ensure_worktree(repo, "abcdefgh1")
    b = ensure_worktree(repo, "abcdefgh2")
    assert a != b
    assert _head(a) == "klanker/s-abcdefgh1"
    assert _head(b) == "klanker/s-abcdefgh2"
    res = remove_worktree(repo, "abcdefgh1", delete_branch=True, force=True)
    assert res["removed"] and res["branch_deleted"], res
    assert not a.exists()
    assert b.exists() and _head(b) == "klanker/s-abcdefgh2"
    assert _branch_exists(repo, "klanker/s-abcdefgh2")
    assert not _branch_exists(repo, "klanker/s-abcdefgh1")


def test_remove_worktree_refuses_checkout_outside_root(repo, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    _git(repo, "worktree", "add", "-b", "klanker/s-foreign1", str(elsewhere))
    res = remove_worktree(repo, "foreign1", delete_branch=True, force=True)
    assert not res["removed"] and not res["branch_deleted"]
    assert "outside the worktree root" in res["error"]
    assert elsewhere.exists() and (elsewhere / "f.txt").exists()
    assert _branch_exists(repo, "klanker/s-foreign1")


@pytest.mark.parametrize("bad", ["abc\n", "abc\n\n", "\nabc", "abc\r"])
def test_trailing_newline_ids_refused(repo, bad):
    with pytest.raises(InvalidSessionId):
        session_branch(bad)
    with pytest.raises(InvalidSessionId):
        ensure_worktree(repo, bad)


def test_link_swapped_during_worktree_add_is_undone(repo, tmp_path,
                                                    monkeypatch):
    outside = tmp_path / "outside-swap"
    outside.mkdir()
    real_git = session_mod._git

    if not _can_symlink(tmp_path):
        pytest.skip("symlink privilege required")

    def racing_git(r, *args, **kw):
        if args[:2] == ("worktree", "add"):
            target = Path(args[4] if args[2] == "-b" else args[2])
            parent = target.parent
            parent.rename(parent.with_name(parent.name + ".moved"))
            parent.symlink_to(outside, target_is_directory=True)
        return real_git(r, *args, **kw)

    monkeypatch.setattr(session_mod, "_git", racing_git)
    with pytest.raises(InvalidSessionId):
        ensure_worktree(repo, "racer01")
    monkeypatch.setattr(session_mod, "_git", real_git)
    # the checkout git made through the link is gone again
    assert not (outside / "racer01").exists()
    assert _git(repo, "worktree", "list", "--porcelain").stdout.count(
        "worktree ") == 1


def test_outside_checkout_of_session_branch_never_used(conn, repo, tmp_path):
    elsewhere = tmp_path / "outside-co"
    _git(repo, "worktree", "add", "-b", "klanker/s-outside1", str(elsewhere))
    (elsewhere / "untracked.txt").write_text("not yours", encoding="utf-8")
    before = _git(elsewhere, "rev-parse", "HEAD").stdout.strip()
    with pytest.raises(InvalidSessionId, match="outside the worktree root"):
        ensure_worktree(repo, "outside1")
    cp = checkpoint(repo, "outside1", "h1")
    assert not cp["committed"] and not cp["pushed"]
    assert "outside the worktree root" in cp["error"]
    res = switch_host(conn, "outside1", "h2", repo=repo)
    assert res["bound"] is False
    # nothing was committed in the outside checkout
    assert _git(elsewhere, "rev-parse", "HEAD").stdout.strip() == before
    assert (elsewhere / "untracked.txt").exists()
    assert "untracked.txt" in _git(elsewhere, "status", "--porcelain").stdout


def test_inside_root_worktree_still_reused_and_checkpointed(repo):
    wt = ensure_worktree(repo, "inside01")
    assert ensure_worktree(repo, "inside01") == wt
    (wt / "f.txt").write_text("v2", encoding="utf-8")
    assert checkpoint(repo, "inside01")["committed"]


# -- session gate (harness first host-local tool -> bind datom) ---------------

def _gate_host(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "gatehost"))
    from agents_workspace import Host

    h = Host.from_env()
    h.dir.mkdir(parents=True, exist_ok=True)
    return h


def test_session_gate_binds_once(tmp_path, monkeypatch, repo):
    from klanker.session import session_bind_gate

    h = _gate_host(tmp_path, monkeypatch)
    h.create("wgate")
    (h.dir / "clients").mkdir(parents=True, exist_ok=True)
    (h.dir / "clients" / "hubs.json").write_text(
        '{"hubs": {"h1": {"device_id": "dev-self",'
        ' "hub_url": "http://hub"}}}', encoding="utf-8")
    monkeypatch.setenv("AGENTS_WORKSPACE", "wgate")
    monkeypatch.setenv("AGENTS_WORKDIR", str(repo))

    res = session_bind_gate("ses_gate1", "git")
    assert res["bound"] is True and res["already_bound"] is False
    conn = connect(h.dir / "workspaces" / "wgate" / "store.db")
    try:
        v = session_view(conn, "ses_gate1")
        assert v["host"] == "dev-self"
        # canonical slug only — never an absolute path (klanker#148)
        assert v["repo"] == "repo"
        assert v["branch"] == "klanker/s-ses_gate1"
        # turn-2 fire on THIS host: bound + already_bound, no SessionGateError
        res2 = session_bind_gate("ses_gate1", "git")
        assert res2["bound"] is True and res2["already_bound"] is True
        # bound to a DIFFERENT host: declines loudly, never rebinding
        bind_session(conn, "ses_gate1", "dev-other")
        res3 = session_bind_gate("ses_gate1", "git")
        assert res3["bound"] is False and res3["already_bound"] is False
        assert session_view(conn, "ses_gate1")["host"] == "dev-other"
    finally:
        conn.close()


def test_session_gate_repo_slug_from_ws_repos(tmp_path, monkeypatch, repo):
    """ws.repos consumption (R7): a mapped slug prefixes session:repo."""
    import inspect

    from agents_workspace import Host

    from klanker.session import session_bind_gate

    if "repos" not in inspect.signature(Host.update_workspace).parameters:
        pytest.skip("agents-workspace without repos field")
    h = _gate_host(tmp_path, monkeypatch)
    h.create("wgate")
    h.update_workspace(
        "wgate",
        repos=[{"slug": "myrepo", "url": "git@h:me/repo.git",
                "checkout_mode": "worktree"}])
    # repo dir name resolves against the url tail -> slug match
    monkeypatch.setenv("AGENTS_WORKSPACE", "wgate")
    monkeypatch.setenv("AGENTS_WORKDIR", str(repo))
    res = session_bind_gate("ses_map", "git")
    assert res["bound"] is True and res["already_bound"] is False
    conn = connect(h.dir / "workspaces" / "wgate" / "store.db")
    try:
        assert session_view(conn, "ses_map")["repo"] == "myrepo"
    finally:
        conn.close()
    # checkout_mode=worktree: session worktree exists on its branch and
    # the gate hands it back as workdir (turn-1 lands in the tree)
    wt = find_worktree(repo, "klanker/s-ses_map")
    assert wt is not None and _head(wt) == "klanker/s-ses_map"
    assert res["workdir"] == str(wt)
    res2 = session_bind_gate("ses_map", "git")
    assert res2["bound"] is True and res2["already_bound"] is True
    assert res2["workdir"] == str(wt)


def test_session_gate_shared_mode_skips_worktree(tmp_path, monkeypatch,
                                                 repo):
    import inspect

    from agents_workspace import Host

    from klanker.session import session_bind_gate

    if "repos" not in inspect.signature(Host.update_workspace).parameters:
        pytest.skip("agents-workspace without repos field")
    h = _gate_host(tmp_path, monkeypatch)
    h.create("wgate")
    h.update_workspace(
        "wgate",
        repos=[{"slug": "repo", "checkout_mode": "shared"}])
    monkeypatch.setenv("AGENTS_WORKSPACE", "wgate")
    monkeypatch.setenv("AGENTS_WORKDIR", str(repo))
    res = session_bind_gate("ses_sh", "git")
    assert res["bound"] is True and res["already_bound"] is False
    assert res["workdir"] == ""
    assert find_worktree(repo, "klanker/s-ses_sh") is None


def test_session_gate_without_repo_binds_local(tmp_path, monkeypatch):
    from klanker.session import session_bind_gate

    h = _gate_host(tmp_path, monkeypatch)
    h.create("wgate")
    monkeypatch.setenv("AGENTS_WORKSPACE", "wgate")
    monkeypatch.setenv("AGENTS_WORKDIR", str(tmp_path / "notarepo"))
    (tmp_path / "notarepo").mkdir()

    res = session_bind_gate("ses_chat", "mcp.terminal")
    assert res["bound"] is True and res["already_bound"] is False
    conn = connect(h.dir / "workspaces" / "wgate" / "store.db")
    try:
        v = session_view(conn, "ses_chat")
        # canonical id: no channel pairing -> the host's own host_id,
        # never a synthetic "local" (klanker#148)
        assert v["host"] == str(h.host_id())
        assert v["repo"] == "" and v["branch"] == ""
    finally:
        conn.close()
