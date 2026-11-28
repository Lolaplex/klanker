"""PEP 440 version for klanker builds.

The only written version is ``[project].version`` in pyproject.toml — the
release being prepared. A release build (``KLANKER_RELEASE=1``) stamps that
string. Every other build appends a local segment so the result sorts
strictly above the release base, and therefore above every published
release of that base or lower.

Examples (base ``0.3.0``):

    release:  0.3.0
    dev:      0.3.0+g<sha>
    dirty:    0.3.0+g<sha>.dirty
    no git:   0.3.0+dev
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_VERSION_RE = re.compile(r'(?m)^(version\s*=\s*")([^"]+)(")\s*$')
_TRUTHY = {"1", "true", "yes", "on"}
_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,}$")


def release_version(text: str | None = None) -> str:
    """Public release version declared in pyproject.toml, local segment stripped."""
    raw = text if text is not None else (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = _VERSION_RE.search(raw)
    if not match:
        raise RuntimeError("pyproject.toml has no [project] version")
    return match.group(2).split("+", 1)[0]


def render_project_version(text: str, version: str) -> str:
    """Return ``text`` with the ``[project]`` version line set to ``version``."""
    if not _VERSION_RE.search(text):
        raise RuntimeError("pyproject.toml has no [project] version")
    return _VERSION_RE.sub(
        lambda match: f"{match.group(1)}{version}{match.group(3)}",
        text,
        count=1,
    )


def _git(*args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(ROOT), *args],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def is_release_build() -> bool:
    return os.environ.get("KLANKER_RELEASE", "").strip().lower() in _TRUTHY


def local_segment() -> str:
    """Local segment including the leading ``+``, or ``""`` on a release build."""
    if is_release_build():
        return ""
    sha = _git("rev-parse", "--short=12", "HEAD")
    if not _SHA_RE.fullmatch(sha):
        return "+dev"
    segment = "g" + sha.lower()
    if _git("status", "--porcelain"):
        segment += ".dirty"
    return "+" + segment


def version_for_build() -> str:
    return release_version() + local_segment()
