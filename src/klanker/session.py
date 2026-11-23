"""Session host binding + session worktree mechanics (klanker#136).

session:host is a card-one datom -- sessions stay unbound ("") until a
host-local tool needs a host; hosts can switch between prompts. The
live run lock is the hub lease (out-of-band); these datoms are the slow
durable state. Writes go through ingest with a host-scoped actor
``bind@<node>:<session>`` (origin_seq continues from the store) --
local, LWW-correct, replay-idempotent, never colliding across hosts.

Code moves by Git, never by file sync: each session gets its own
worktree on branch ``klanker/s-<session-id>``. Worktrees live OUTSIDE the
user's repo (``<worktree_root>/<repo>-<hash>/<session-id>``, root =
``$KLANKER_WORKTREE_DIR`` or ``<host>/worktrees``), so they never show
up as untracked files or get committed into another branch. The user's
own checkout is never switched: checkpoints commit only inside the
session worktree. Network git calls (ls-remote/push) have timeouts.
Session ids are validated before they touch a path or branch name and
worktree paths are confined to the root (no traversal, no symlinks).
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import time
from pathlib import Path

from agents_store.ingest import ingest

from .msgsync import actor, ensure_domain, local_node_id, next_seq

GIT_TIMEOUT_SEC = 30.0       # local git plumbing
REMOTE_PROBE_SEC = 15.0      # ls-remote
PUSH_TIMEOUT_SEC = 60.0      # push


def _now_ms() -> int:
    return int(time.time() * 1000)


# Session ids end up in branch names and filesystem paths; anything
# outside this set (slashes, dots, absolute paths, whitespace) is refused.
_SESSION_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")  # used with fullmatch
_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


class InvalidSessionId(ValueError):
    pass


def validate_session_id(session_id: str) -> str:
    if not isinstance(session_id, str) \
            or _SESSION_ID_RE.fullmatch(session_id) is None:
        raise InvalidSessionId(f"invalid session id: {session_id!r}")
    return session_id


def session_slug(session_id: str) -> str:
    """Path/branch-safe id: the full validated session id. (A short
    prefix let two sessions share one worktree and branch.)"""
    return validate_session_id(session_id)


def session_branch(session_id: str) -> str:
    return f"klanker/s-{session_slug(session_id)}"


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


def _bind_tx(conn, session_id: str, datoms, node: str | None) -> None:
    ensure_domain(conn)
    origin = actor("bind", node or local_node_id(), session_id)
    ms = _now_ms()
    ingest(conn, origin, next_seq(conn, origin),
           f"{ms:013d}.00000.bind", datoms)


def bind_session(conn, session_id: str, host_id: str, *,
                 branch: str = "", repo: str = "",
                 node: str | None = None) -> None:
    """Bind a session to a host (or switch). card-one LWW wins."""
    e = f"session:{session_id}"
    datoms = [(e, "session:host", host_id, True)]
    if branch:
        datoms.append((e, "session:branch", branch, True))
    if repo:
        datoms.append((e, "session:repo", repo, True))
    _bind_tx(conn, session_id, datoms, node)


def set_wip_unpushed(conn, session_id: str, flag: bool, *,
                     node: str | None = None) -> None:
    _bind_tx(conn, session_id,
             [(f"session:{session_id}", "session:wip_unpushed",
               "true" if flag else "false", True)], node)


# -- git mechanics -----------------------------------------------------------

def _git(repo: Path, *args: str, check: bool = True,
         timeout: float = GIT_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.setdefault("GIT_TERMINAL_PROMPT", "0")  # never block on a prompt
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=check, timeout=timeout,
        env=env)


def _git_ok(repo: Path, *args: str, timeout: float = GIT_TIMEOUT_SEC) -> bool:
    try:
        _git(repo, *args, timeout=timeout)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def repo_dirty(repo: Path) -> bool:
    out = _git(repo, "status", "--porcelain").stdout
    return bool(out.strip())


def worktree_root() -> Path:
    env = os.environ.get("KLANKER_WORKTREE_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    try:
        from agents_workspace import Host

        return Path(Host.from_env().dir) / "worktrees"
    except Exception:  # noqa: BLE001
        return Path.home() / ".klanker" / "worktrees"


def _main_repo(repo: Path) -> Path:
    """Top level of the main working tree (works from a linked worktree)."""
    common = _git(repo, "rev-parse", "--path-format=absolute",
                  "--git-common-dir").stdout.strip()
    return Path(common).parent


def _check_contained(path: Path, root: Path) -> None:
    """Refuse symlinks between ``root`` and ``path`` and anything whose
    resolved location escapes ``root`` (``root`` itself may be a link)."""
    try:
        rel = path.relative_to(root)
    except ValueError:
        raise InvalidSessionId(f"worktree path escapes root: {path}") from None
    cur = root
    for part in rel.parts:
        if part in ("", ".", ".."):
            raise InvalidSessionId(f"unsafe worktree path: {path}")
        cur = cur / part
        if cur.is_symlink():
            raise InvalidSessionId(f"symlink in worktree path: {cur}")
    if not path.resolve().is_relative_to(root):
        raise InvalidSessionId(f"worktree path escapes root: {path}")


def _resolved_root(root: str | Path | None = None) -> Path:
    base = Path(root) if root is not None else worktree_root()
    return base.expanduser().resolve()


def _inside_root(path: Path, base: Path) -> bool:
    """True if ``path`` lies under the resolved root ``base`` without a
    symlink below it and resolves inside it."""
    try:
        _check_contained(Path(path), base)
        return True
    except InvalidSessionId:
        return False


def worktree_path(repo: str | Path, session_id: str,
                  root: str | Path | None = None) -> Path:
    """``<root>/<repo>-<hash>/<session-id>``; validated, contained in
    root, no symlinks below the (resolved) root."""
    slug = session_slug(session_id)
    main = _main_repo(Path(repo)).resolve()
    tag = hashlib.sha1(str(main).encode("utf-8")).hexdigest()[:8]
    name = _UNSAFE_NAME.sub("_", main.name).lstrip(".") or "repo"
    base = _resolved_root(root)
    wt = base / f"{name}-{tag}" / slug
    _check_contained(wt, base)
    return wt


def find_worktree(repo: str | Path, branch: str) -> Path | None:
    """Path of the worktree that has ``branch`` checked out, if any."""
    out = _git(Path(repo), "worktree", "list", "--porcelain").stdout
    path = None
    for line in out.splitlines():
        if line.startswith("worktree "):
            path = Path(line[len("worktree "):])
        elif line.startswith("branch ") and path is not None:
            if line[len("branch "):] == f"refs/heads/{branch}":
                return path
    return None


def ensure_worktree(repo: str | Path, session_id: str, *,
                    root: str | Path | None = None) -> Path:
    """Idempotent session worktree on branch klanker/s-<session-id>,
    outside the repo. Re-uses the worktree already holding the branch
    only if it lies inside the worktree root; a checkout of the session
    branch anywhere else is refused (InvalidSessionId), never returned."""
    repo = Path(repo)
    branch = session_branch(session_id)  # validates session_id
    base = _resolved_root(root)
    existing = find_worktree(repo, branch)
    if existing is not None and existing.exists():
        if not _inside_root(existing, base):
            raise InvalidSessionId(
                f"session branch {branch} is checked out outside the"
                f" worktree root: {existing}")
        return existing
    _git(repo, "worktree", "prune")
    wt = worktree_path(repo, session_id, base)
    wt.parent.mkdir(parents=True, exist_ok=True)
    # re-check after mkdir: a link planted in between is still refused
    _check_contained(wt, base)
    if not _git_ok(repo, "rev-parse", "--verify", "--quiet",
                   f"refs/heads/{branch}"):
        _git(repo, "worktree", "add", "-b", branch, str(wt))
    else:
        _git(repo, "worktree", "add", str(wt), branch)
    # re-check after git created it: if a component was swapped for a
    # link meanwhile, drop the fresh checkout and refuse
    try:
        _check_contained(wt, base)
    except InvalidSessionId:
        _git_ok(repo, "worktree", "remove", "--force", str(wt))
        _git_ok(repo, "worktree", "prune")
        raise
    return wt


def checkpoint(repo: str | Path, session_id: str, host_id: str = "", *,
               root: str | Path | None = None) -> dict:
    """Commit dirty session state in the session worktree; push if a
    remote answers in time.

    Returns {"committed", "pushed", "unpushed", "error", "worktree"}.
    Only the session worktree is touched -- the user's checkout (main,
    dev, whatever is checked out) is never switched or committed to, and
    a checkout of the session branch outside the worktree root is
    refused (error, nothing committed).
    """
    repo = Path(repo)
    out = {"committed": False, "pushed": False, "unpushed": False,
           "error": "", "worktree": ""}
    try:
        branch = session_branch(session_id)
    except InvalidSessionId as exc:
        out["error"] = str(exc)
        return out
    try:
        wt = find_worktree(repo, branch)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        out["error"] = f"not a git repo: {exc}"
        return out
    if wt is None or not wt.exists():
        out["error"] = "no session worktree"
        return out
    out["worktree"] = str(wt)
    if not _inside_root(wt, _resolved_root(root)):
        out["error"] = ("refusing to checkpoint a session worktree outside"
                        f" the worktree root: {wt}")
        return out
    try:
        if repo_dirty(wt):
            _git(wt, "add", "-A")
            msg = (f"wip(klanker): checkpoint session {session_id[:8]}"
                   + (f" ({host_id})" if host_id else ""))
            _git(wt, "commit", "-m", msg)
            out["committed"] = True
    except subprocess.CalledProcessError as exc:
        out["error"] = f"commit refused: {exc.stderr.strip() or exc}"
        return out
    except subprocess.TimeoutExpired:
        out["error"] = "commit timed out"
        return out
    remotes = _git(wt, "remote").stdout.split()
    if not remotes:
        out["unpushed"] = True
        return out
    if not _git_ok(wt, "ls-remote", "--heads", remotes[0],
                   timeout=REMOTE_PROBE_SEC):
        out["unpushed"] = True
        out["error"] = "remote unreachable"
        return out
    try:
        _git(wt, "push", "-u", remotes[0], branch, timeout=PUSH_TIMEOUT_SEC)
        out["pushed"] = True
    except subprocess.CalledProcessError as exc:
        out["unpushed"] = True
        out["error"] = f"push failed: {exc.stderr.strip() or exc}"
    except subprocess.TimeoutExpired:
        out["unpushed"] = True
        out["error"] = "push timed out"
    return out


def remove_worktree(repo: str | Path, session_id: str, *,
                    delete_branch: bool = False,
                    force: bool = False,
                    root: str | Path | None = None) -> dict:
    """Session end / PR merged: drop the session worktree.

    Only a worktree inside the worktree root is removed; a checkout of
    the session branch anywhere else (or the main tree) is refused.
    Refuses a dirty worktree unless ``force`` (git's own check). The
    branch is kept unless ``delete_branch`` (it may still back a PR).
    Returns {"removed", "branch_deleted", "error", "worktree"}.
    """
    repo = Path(repo)
    out = {"removed": False, "branch_deleted": False, "error": "",
           "worktree": ""}
    try:
        branch = session_branch(session_id)
        wt = find_worktree(repo, branch)
        if wt is not None:
            out["worktree"] = str(wt)
            if wt.resolve() == _main_repo(repo).resolve():
                out["error"] = "refusing to remove the main working tree"
                return out
            if not _inside_root(wt, _resolved_root(root)):
                out["error"] = ("refusing to remove a worktree outside the"
                                f" worktree root: {wt}")
                return out
            args = ["worktree", "remove"] + (["--force"] if force else [])
            _git(repo, *args, str(wt))
            out["removed"] = True
        _git(repo, "worktree", "prune")
        if delete_branch and _git_ok(repo, "rev-parse", "--verify",
                                     "--quiet", f"refs/heads/{branch}"):
            _git(repo, "branch", "-D" if force else "-d", branch)
            out["branch_deleted"] = True
    except InvalidSessionId as exc:
        out["error"] = str(exc)
    except subprocess.CalledProcessError as exc:
        out["error"] = (exc.stderr or str(exc)).strip()
    except subprocess.TimeoutExpired:
        out["error"] = "git timed out"
    return out


def switch_host(conn, session_id: str, new_host: str, *,
                repo: str | Path | None = None,
                old_host: str = "", node: str | None = None,
                root: str | Path | None = None) -> dict:
    """Host switch between prompts: checkpoint -> rebind -> flag state.

    Caller decides what to do with unpushed=True (warn / refuse per
    workspace execution policy). A session without a worktree (pure
    conversation) rebinds without a checkpoint.
    """
    result = {"checkpoint": None, "bound": False}
    if repo is not None:
        cp = checkpoint(repo, session_id, old_host, root=root)
        result["checkpoint"] = cp
        if cp["error"] and not cp["committed"] \
                and cp["error"] != "no session worktree" \
                and not cp["unpushed"]:
            return result
    view = session_view(conn, session_id)
    bind_session(conn, session_id, new_host,
                 branch=view["branch"], repo=view["repo"], node=node)
    if repo is not None:
        set_wip_unpushed(conn, session_id,
                         bool(result["checkpoint"]["unpushed"]), node=node)
    result["bound"] = True
    return result
