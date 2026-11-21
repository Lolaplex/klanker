"""Configure git credentials and identity for Klanker environments."""

from __future__ import annotations

import json
import logging
import os
import stat
import subprocess
import sys
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)


def _resolve_github_token() -> str:
    try:
        from agents_workspace import resolve_secret

        tok = resolve_secret("GITHUB_TOKEN").strip() or resolve_secret("GH_TOKEN").strip()
        if tok:
            return tok
    except Exception:
        pass
    return os.environ.get("GITHUB_TOKEN", "").strip() or os.environ.get("GH_TOKEN", "").strip()


def askpass_response(prompt: str = "") -> str:
    """Respond to ``git`` ``GIT_ASKPASS`` / ``core.askPass`` prompts without storing tokens."""
    low = (prompt or "").lower()
    if "username" in low:
        return "x-access-token"
    return _resolve_github_token()


def _askpass_script_path(home: Path) -> Path:
    try:
        from agents_workspace import Host

        host = Host.from_env()
        # Use target home when caller passed an isolated/test home outside Host.
        if home == Path(os.environ.get("HOME", str(home))):
            host.run.mkdir(parents=True, exist_ok=True)
            name = "git-askpass.cmd" if os.name == "nt" else "git-askpass"
            return host.run / name
    except Exception:
        pass
    name = ".git-askpass.cmd" if os.name == "nt" else ".git-askpass"
    return home / name


def _write_askpass_helper(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    py = sys.executable or "python3"
    if os.name == "nt" or path.suffix.lower() in (".cmd", ".bat"):
        content = f'@echo off\r\n"{py}" -m klanker.git_identity --askpass %1\r\n'
    else:
        content = f'#!/bin/sh\nexec "{py}" -m klanker.git_identity --askpass "$1"\n'
    path.write_text(content, encoding="utf-8")
    try:
        if os.name != "nt":
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    except OSError as exc:
        log.warning("Failed to chmod askpass helper: %s", exc)
    return path


def setup_git_identity(target_home: Path | None = None) -> dict[str, str]:
    home = target_home or Path(os.environ.get("HOME", "/data"))
    home.mkdir(parents=True, exist_ok=True)

    token = _resolve_github_token()
    name = (
        os.environ.get("GIT_AUTHOR_NAME", "").strip()
        or os.environ.get("GIT_NAME", "").strip()
        or os.environ.get("GIT_COMMITTER_NAME", "").strip()
    )
    email = (
        os.environ.get("GIT_AUTHOR_EMAIL", "").strip()
        or os.environ.get("GIT_EMAIL", "").strip()
        or os.environ.get("GIT_COMMITTER_EMAIL", "").strip()
    )

    cred_file = home / ".git-credentials"
    gitconfig = home / ".gitconfig"
    askpass_path = _askpass_script_path(home)

    # Remove any legacy plaintext .git-credentials file.
    if cred_file.is_file():
        try:
            cred_file.unlink()
        except OSError as exc:
            log.warning("Failed to remove legacy .git-credentials: %s", exc)

    if token:
        if not name or not email:
            try:
                req = urllib.request.Request(
                    "https://api.github.com/user",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "User-Agent": "Klanker-Agent",
                        "Accept": "application/vnd.github.v3+json",
                    },
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode("utf-8"))
                        login = data.get("login") or ""
                        user_id = data.get("id") or ""
                        if login and not name:
                            name = login
                        if login and not email:
                            email = (
                                f"{user_id}+{login}@users.noreply.github.com"
                                if user_id
                                else f"{login}@users.noreply.github.com"
                            )
            except Exception as exc:
                log.warning("Failed to resolve git identity from GitHub API: %s", exc)

    if not name:
        name = "Klanker"
    if not email:
        email = "klanker@users.noreply.github.com"

    try:
        # Strip legacy plaintext token sections and store credential helpers
        if gitconfig.is_file():
            proc = subprocess.run(
                ["git", "config", "-f", str(gitconfig), "--get-regexp", r"^url\..*\.insteadof"],
                capture_output=True,
                text=True,
                check=False,
            )
            for line in proc.stdout.splitlines():
                key = line.split()[0] if line.split() else ""
                if key.endswith(".insteadof"):
                    section = key[:-len(".insteadof")]
                    subprocess.run(
                        ["git", "config", "-f", str(gitconfig), "--remove-section", section],
                        check=False,
                        capture_output=True,
                    )
            subprocess.run(
                ["git", "config", "-f", str(gitconfig), "--unset-all", "credential.helper"],
                check=False,
                capture_output=True,
            )

        if token:
            helper = _write_askpass_helper(askpass_path)
            subprocess.run(
                [
                    "git",
                    "config",
                    "-f",
                    str(gitconfig),
                    "core.askPass",
                    helper.as_posix(),
                ],
                check=False,
                capture_output=True,
            )
        subprocess.run(
            ["git", "config", "-f", str(gitconfig), "user.name", name],
            check=False,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "-f", str(gitconfig), "user.email", email],
            check=False,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "-f", str(gitconfig), "init.defaultBranch", "dev"],
            check=False,
            capture_output=True,
        )
    except Exception as exc:
        log.warning("Failed to configure git: %s", exc)

    return {"name": name, "email": email, "askpass": askpass_path.as_posix() if token else ""}


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--askpass":
        prompt = sys.argv[2] if len(sys.argv) >= 3 else ""
        print(askpass_response(prompt))
    else:
        setup_git_identity()
