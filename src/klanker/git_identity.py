"""Configure git credentials and identity for Klanker environments."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)


def setup_git_identity(target_home: Path | None = None) -> dict[str, str]:
    home = target_home or Path(os.environ.get("HOME", "/data"))
    home.mkdir(parents=True, exist_ok=True)

    token = os.environ.get("GITHUB_TOKEN", "").strip() or os.environ.get("GH_TOKEN", "").strip()
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

    if token:
        try:
            cred_file.write_text(f"https://x-access-token:{token}@github.com\n", encoding="utf-8")
            cred_file.chmod(0o600)
        except OSError as exc:
            log.warning("Failed to write .git-credentials: %s", exc)

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
        # Strip any legacy plaintext token insteadOf sections
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

        if token:
            subprocess.run(
                [
                    "git",
                    "config",
                    "-f",
                    str(gitconfig),
                    "credential.helper",
                    f"store --file {cred_file.as_posix()}",
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

    return {"name": name, "email": email}


if __name__ == "__main__":
    setup_git_identity()
