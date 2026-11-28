"""Lightweight, non-blocking PyPI update check for CLI / MCP entrypoints."""
from __future__ import annotations

import functools
import importlib.metadata
import json
import os
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from agents_workspace import Host
from packaging.version import InvalidVersion, Version

_TRUTHY = ("1", "true", "yes", "on")
_CI_KEYS = (
    "CI",
    "CONTINUOUS_INTEGRATION",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "TF_BUILD",
    "BUILDKITE",
    "CIRCLECI",
)

# Process-local: one MCP PyPI check (and at most one notice) per package.
_mcp_checked: set[str] = set()


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in _TRUTHY


def disabled() -> bool:
    if _env_truthy("AGENTS_NO_UPDATE_CHECK"):
        return True
    return any(_env_truthy(k) for k in _CI_KEYS)


def _version(value: str) -> Version | None:
    try:
        return Version(value.strip().lstrip("v"))
    except (InvalidVersion, AttributeError):
        return None


def version_is_devish(current: str) -> bool:
    """True for dev, pre, and local versions. Those sort as in-progress builds."""
    parsed = _version(current)
    if parsed is None:
        return False
    return bool(parsed.local is not None or parsed.is_devrelease or parsed.is_prerelease)


def release_base(current: str) -> Version | None:
    """Release a dev build is working from, with dev/pre/post/local stripped."""
    parsed = _version(current)
    if parsed is None:
        return None
    return Version(parsed.base_version)


def install_kind(package_name: str) -> str:
    """``editable``, ``vcs``, or ``index`` from the installed distribution."""
    try:
        dist = importlib.metadata.distribution(package_name)
    except importlib.metadata.PackageNotFoundError:
        return "index"
    raw = dist.read_text("direct_url.json")
    if not raw:
        return "index"
    try:
        data = json.loads(raw)
    except Exception:
        return "index"
    if (data.get("dir_info") or {}).get("editable"):
        return "editable"
    if data.get("vcs_info"):
        return "vcs"
    return "index"


def is_dev_install(package_name: str, current: str) -> bool:
    """A dev, editable, or VCS install must not be replaced by a release of its base."""
    if version_is_devish(current):
        return True
    return install_kind(package_name) in {"editable", "vcs"}


def decide_update(current: str, latest: str, *, dev_install: bool = False) -> str:
    """Return ``upgrade``, ``inform``, or ``skip``.

    A final install offers a PyPI release only when it is strictly newer.
    A dev, editable, or VCS install never offers a release that is less than
    or equal to its base — that would downgrade it, or move it sideways onto
    the release the dev build already contains. When PyPI is strictly newer
    than that base the result is ``inform``: say so, and do not recommend
    replacing the dev install.
    """
    current_v = _version(current)
    latest_v = _version(latest)
    if current_v is None or latest_v is None:
        return "skip"
    if dev_install or version_is_devish(current):
        base = release_base(current)
        if base is None or latest_v <= base:
            return "skip"
        return "inform"
    if latest_v > current_v:
        return "upgrade"
    return "skip"


def _cache_file(package_name: str) -> Path:
    host = Host.from_env()
    return host.cache / "updates" / f"updates-{package_name}.json"


def format_notice(package_name: str, current: str, latest: str) -> str:
    return (
        f"{package_name} {latest} available (you have {current}): "
        f"uv tool upgrade {package_name}"
    )


def format_dev_notice(package_name: str, current: str, latest: str) -> str:
    """Information only. A dev install is left where it is."""
    return f"{package_name} {latest} is on PyPI (dev install {current}; left unchanged)"


@dataclass(frozen=True)
class UpdateNotice:
    kind: str  # upgrade | inform
    latest: str


def _lookup_latest(
    package_name: str,
    current_version: str,
    *,
    cache_ttl_sec: int = 86400,
    timeout: float = 1.0,
) -> str | None:
    """Latest PyPI version string, from the 24h cache or the network. None on failure."""
    now = time.time()
    cache_file = _cache_file(package_name)
    latest_version: str | None = None
    last_checked = 0.0
    try:
        if cache_file.is_file():
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            last_checked = float(data.get("last_checked") or 0)
            latest_version = data.get("latest_version") or None
    except Exception:
        latest_version = None

    if latest_version and (now - last_checked) < cache_ttl_sec:
        return str(latest_version)

    try:
        req = urllib.request.Request(
            f"https://pypi.org/pypi/{package_name}/json",
            headers={"User-Agent": f"{package_name}/{current_version} (update-check)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        latest_version = payload.get("info", {}).get("version")
        if not latest_version:
            return None
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(
            json.dumps(
                {"last_checked": int(now), "latest_version": latest_version},
                indent=2,
            ),
            encoding="utf-8",
        )
        return str(latest_version)
    except Exception:
        return None


def _notice(package_name: str, current_version: str, latest_version: str | None) -> UpdateNotice | None:
    if not latest_version:
        return None
    kind = decide_update(
        current_version,
        latest_version,
        dev_install=is_dev_install(package_name, current_version),
    )
    if kind == "skip":
        return None
    return UpdateNotice(kind, latest_version)


def latest_available(
    package_name: str,
    current_version: str,
    *,
    cache_ttl_sec: int = 86400,
    timeout: float = 1.0,
) -> str | None:
    """Return a PyPI version to upgrade to, or None.

    Dev, editable, and VCS installs return None. A release at or below their
    base is not an upgrade, and a newer release is information only
    (see ``check_for_updates``). Cached ~24h; silent on failure.
    """
    if disabled():
        return None
    found = _lookup_latest(
        package_name,
        current_version,
        cache_ttl_sec=cache_ttl_sec,
        timeout=timeout,
    )
    notice = _notice(package_name, current_version, found)
    if notice is not None and notice.kind == "upgrade":
        return notice.latest
    return None


def check_for_updates(
    package_name: str,
    current_version: str,
    cache_ttl_sec: int = 86400,
    timeout: float = 1.0,
) -> None:
    """CLI: print one stderr line if a newer PyPI release exists. Never touches stdout.

    A dev, editable, or VCS install never prints the upgrade line. When PyPI
    is strictly newer than that install's release base, the line only says
    the release exists and that this install was left unchanged.
    """
    if disabled():
        return
    found = _lookup_latest(
        package_name,
        current_version,
        cache_ttl_sec=cache_ttl_sec,
        timeout=timeout,
    )
    notice = _notice(package_name, current_version, found)
    if notice is None:
        return
    if notice.kind == "inform":
        line = format_dev_notice(package_name, current_version, notice.latest)
    else:
        line = format_notice(package_name, current_version, notice.latest)
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def mcp_update_notice(
    package_name: str,
    current_version: str,
    cache_ttl_sec: int = 86400,
    timeout: float = 1.0,
) -> str:
    """One-line notice for the first MCP tool response this process; else empty."""
    if package_name in _mcp_checked:
        return ""
    _mcp_checked.add(package_name)
    if disabled():
        return ""
    found = _lookup_latest(
        package_name,
        current_version,
        cache_ttl_sec=cache_ttl_sec,
        timeout=timeout,
    )
    notice = _notice(package_name, current_version, found)
    if notice is None:
        return ""
    if notice.kind == "inform":
        return format_dev_notice(package_name, current_version, notice.latest)
    return format_notice(package_name, current_version, notice.latest)


def attach_mcp_update_notice(mcp: object, package_name: str, current_version: str) -> None:
    """Wrap future ``add_tool`` registrations so the first str result may get a notice.

    Call once right after ``FastMCP(...)`` and before ``@mcp.tool()`` decorators.
    """
    original = mcp.add_tool  # type: ignore[attr-defined]

    def add_tool(fn, *args, **kwargs):  # type: ignore[no-untyped-def]
        @functools.wraps(fn)
        def wrapped(*a, **kw):
            result = fn(*a, **kw)
            if isinstance(result, str):
                notice = mcp_update_notice(package_name, current_version)
                if notice and not result.startswith(notice):
                    return f"{notice}\n\n{result}"
            return result

        return original(wrapped, *args, **kwargs)

    mcp.add_tool = add_tool  # type: ignore[method-assign]
