"""Session host binding + session worktree mechanics (klanker#136).

session:host is a card-one datom — sessions stay unbound ("") until a
host-local tool needs a host; hosts can switch between prompts. The
live run lock is the hub lease (out-of-band); these datoms are the slow
durable state. Writes go through ingest with origin_actor
"bind:<session>" — local, LWW-correct, replay-idempotent.

Code moves by Git, never by file sync: each session gets worktree
`<repo>/.klanker/wt/<sid8>` on branch `klanker/s-<sid8>`; a WIP
checkpoint commit lands before any host switch on a dirty tree.
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path

from agents_store.db import connect
from agents_store.ingest import ingest

from .msgsync import ensure_domain


def _now_ms() -> int:
    return int(time.time() * 1000)


def session_branch(session_id: str) -> str:
    return f"klanker/s-{session_id[:8]}"


def session_view(conn, session_id: str) -> dict:
    """Current slow-state binding for a session."""
    ensure_domain(conn)
    e = f"session:{session_id}"
    out = {"host": "", "branch": "", "repo": "", "wip_unpushed": False}
    for a, v in conn.execute(
            "SELECT a, v FROM v_current WHERE e = ?", (e,)):
        key = a.split(":", 1)[1]
        if key == "wip_unpushed":
            out[key] = v in ("true", "1")
        elif key in out:
            out[key] = v
    return out


def bind_session(conn, session_id: str, host_id: str, *,
                 branch: str = "", repo: str = "") -> None:
    """Bind a session to a host (or switch). card-one LWW wins."""
    ensure_domain(conn)
    e = f"session:{session_id}"
    ms = _now_ms()
    datoms = [(e, "session:host", host_id, True)]
    if branch:
        datoms.append((e, "session:branch", branch, True))
    if repo:
        datoms.append((e, "session:repo", repo, True))
    ingest(conn, f"bind:{session_id}", ms,
           f"{ms:013d}.00000.bind", datoms)


def set_wip_unpushed(conn, session_id: str, flag: bool) -> None:
    ensure_domain(conn)
    ms = _now_ms()
    ingest(conn, f"bind:{session_id}", ms + 1,
           f"{ms + 1:013d}.00000.bind",
           [(f"session:{session_id}", "session:wip_unpushed",
             "true" if flag else "false", True)])


# -- git mechanics -----------------------------------------------------------

def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=check)


def _git_ok(repo: Path, *args: str) -> bool:
    try:
        _git(repo, *args)
        return True
    except subprocess.CalledProcessError:
        return False


def repo_dirty(repo: Path) -> bool:
    out = _git(repo, "status", "--porcelain").stdout
    return bool(out.strip())


def ensure_worktree(repo: str | Path, session_id: str) -> Path:
    """Idempotent session worktree on branch klanker/s-<sid8>."""
    repo = Path(repo)
    branch = session_branch(session_id)
    wt = repo / ".klanker" / "wt" / session_id[:8]
    if (wt / ".git").exists():
        return wt
    wt.parent.mkdir(parents=True, exist_ok=True)
    if not _git_ok(repo, "rev-parse", "--verify", branch):
        _git(repo, "worktree", "add", str(wt), "-b", branch)
    else:
        _git(repo, "worktree", "add", str(wt), branch)
    return wt


def checkpoint(repo: str | Path, session_id: str, host_id: str = "") -> dict:
    """Commit dirty session state on its branch; push if a remote is up.

    Returns {"committed", "pushed", "unpushed", "error"}. Never commits
    on user main/dev — switches to klanker/s-<sid8> first.
    """
    repo = Path(repo)
    branch = session_branch(session_id)
    out = {"committed": False, "pushed": False, "unpushed": False,
           "error": ""}
    cur = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if cur != branch:
        if not _git_ok(repo, "rev-parse", "--verify", branch):
            _git(repo, "checkout", "-b", branch)
        else:
            _git(repo, "checkout", branch)
    if not repo_dirty(repo):
        # clean tree — still maybe unpushed commits
        pass
    else:
        _git(repo, "add", "-A")
        msg = (f"wip(klanker): checkpoint session {session_id[:8]}"
               + (f" ({host_id})" if host_id else ""))
        try:
            _git(repo, "commit", "-m", msg)
            out["committed"] = True
        except subprocess.CalledProcessError as exc:
            out["error"] = f"commit refused: {exc.stderr.strip() or exc}"
            return out
    remotes = _git(repo, "remote").stdout.split()
    if remotes and _git_ok(repo, "ls-remote", remotes[0], "HEAD"):
        try:
            _git(repo, "push", "-u", remotes[0], branch)
            out["pushed"] = True
        except subprocess.CalledProcessError as exc:
            out["unpushed"] = True
            out["error"] = f"push failed: {exc.stderr.strip() or exc}"
    else:
        out["unpushed"] = True
    return out


def switch_host(conn, session_id: str, new_host: str, *,
                repo: str | Path | None = None,
                old_host: str = "") -> dict:
    """Host switch between prompts: checkpoint -> rebind -> flag state.

    Caller decides what to do with unpushed=True (warn / refuse per
    workspace execution policy).
    """
    result = {"checkpoint": None, "bound": False}
    if repo is not None:
        cp = checkpoint(repo, session_id, old_host)
        result["checkpoint"] = cp
        if cp["error"] and not cp["committed"]:
            return result
    view = session_view(conn, session_id)
    bind_session(conn, session_id, new_host,
                 branch=view["branch"], repo=view["repo"])
    if repo is not None:
        set_wip_unpushed(conn, session_id,
                         bool(result["checkpoint"]["unpushed"]))
    result["bound"] = True
    return result
