"""``klanker doctor`` — one-shot health check over config, keys, MCP, tokens, disk, suite."""

from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Mapping

from .config_sense import mcp_config_path, mcp_report
from .sensing import HostCapabilities, SUITE_MODULES, probe_host

PROVIDER_KEYS = ("OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "LLM_API_KEY")
_MIN_FREE_GB = 1.0


@dataclass
class Check:
    name: str
    status: str  # pass | warn | fail
    detail: str = ""
    hint: str = ""


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    @property
    def failed(self) -> int:
        return sum(1 for c in self.checks if c.status == "fail")

    @property
    def warned(self) -> int:
        return sum(1 for c in self.checks if c.status == "warn")

    def to_dict(self) -> dict:
        return {
            "checks": [vars(c) for c in self.checks],
            "failed": self.failed,
            "warned": self.warned,
        }


def _dist_name(alias: str, module: str) -> str:
    if alias == "harness":
        return "agents-harness"
    if alias == "vand":
        return "vand"
    return module.replace("_", "-")


def _check_python() -> Check:
    ver = sys.version_info
    ok = ver >= (3, 10)
    return Check(
        "python",
        "pass" if ok else "fail",
        f"{ver.major}.{ver.minor}.{ver.micro}",
        "" if ok else "klanker requires Python 3.10+",
    )


def _check_suite(caps: HostCapabilities) -> list[Check]:
    rows: list[Check] = []
    for alias, module in SUITE_MODULES.items():
        dist = _dist_name(alias, module)
        if not caps.suite_modules.get(alias):
            rows.append(Check(f"suite.{alias}", "warn", "missing", f"pip install {dist}"))
            continue
        try:
            version = metadata.version(dist)
        except metadata.PackageNotFoundError:
            version = "?"
        rows.append(Check(f"suite.{alias}", "pass", version))
    return rows


def _check_runtimes(caps: HostCapabilities) -> list[Check]:
    return [
        Check(f"runtime.{cmd}", "pass", "") if ok
        else Check(f"runtime.{cmd}", "warn", "not on PATH", f"install {cmd}")
        for cmd, ok in sorted(caps.runtimes.items())
    ]


def _check_workspace() -> Check:
    try:
        from agents_workspace import Host, Workspace

        ws = Workspace.from_env()
        root = ws.dir
        if root.is_dir() and os.access(root, os.W_OK):
            return Check("workspace", "pass", str(root))
        return Check("workspace", "fail", str(root), "create it or pick another AGENTS_WORKSPACE")
    except Exception as exc:
        try:
            Host.from_env()
        except Exception as host_exc:
            return Check("workspace", "fail", str(host_exc), "set AGENTS_HOST_DIR")
        return Check("workspace", "warn", str(exc), "klanker workspace create <id>")


def _check_mcp() -> list[Check]:
    path = mcp_config_path()
    if not path.is_file():
        return [Check("mcp", "warn", f"no config at {path}", f"create {path}")]
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [Check("mcp", "fail", f"invalid JSON: {exc}", f"fix {path}")]
    rows = mcp_report().get("mcp_servers") or []
    if not rows:
        return [Check("mcp", "pass", "0 servers")]
    bad = [r for r in rows if r.get("health") != "ok"]
    checks = [Check("mcp", "pass", f"{len(rows) - len(bad)}/{len(rows)} servers ok")]
    for row in bad:
        checks.append(
            Check(
                f"mcp.{row['name']}",
                "warn",
                row.get("health", "?"),
                "install the server command or fix its url",
            )
        )
    return checks


def _check_provider_keys(env: Mapping[str, str]) -> Check:
    have = [k for k in PROVIDER_KEYS if env.get(k, "").strip()]
    if have:
        return Check("tokens", "pass", f"{len(have)} provider key(s): {', '.join(have)}")
    return Check("tokens", "warn", "no provider API key in env", f"set one of {', '.join(PROVIDER_KEYS)}")


def _check_github(caps: HostCapabilities, env: Mapping[str, str]) -> Check:
    """GH capability: `gh` CLI plus a token the turn env passes through."""
    token = env.get("GH_TOKEN", "").strip() or env.get("GITHUB_TOKEN", "").strip()
    if caps.has_gh and token:
        return Check("github", "pass", "gh CLI + GH_TOKEN/GITHUB_TOKEN in env")
    if caps.has_gh:
        return Check("github", "warn", "gh CLI present, no GH_TOKEN/GITHUB_TOKEN", "set GH_TOKEN for PR/CI work")
    if token:
        return Check("github", "warn", "token set but no gh CLI", "install gh (https://cli.github.com)")
    return Check("github", "warn", "no gh CLI, no GH_TOKEN/GITHUB_TOKEN", "install gh + set GH_TOKEN for PR/CI work")


def _check_agent_keys() -> Check:
    try:
        from agents_workspace import Host

        keydir = Host.from_env().keys
        legacy = Path.home() / ".agents" / "keys"
        found = list(keydir.glob("*.ed25519")) if keydir.is_dir() else []
        found += list(legacy.glob("*.ed25519")) if legacy.is_dir() else []
        if found:
            return Check("keys", "pass", f"{len(found)} key(s)")
        return Check("keys", "warn", "no agent keys", "agents-keys mint <slug>")
    except Exception as exc:
        return Check("keys", "warn", str(exc), "agents-keys mint <slug>")


def _check_disk() -> Check:
    try:
        from agents_workspace import Host

        target = Host.from_env().dir
        target.mkdir(parents=True, exist_ok=True)
        free_gb = shutil.disk_usage(target).free / 1e9
        status = "pass" if free_gb >= _MIN_FREE_GB else "fail"
        hint = "" if status == "pass" else "free disk space or point AGENTS_HOST_DIR elsewhere"
        return Check("disk", status, f"{free_gb:.1f} GB free", hint)
    except Exception as exc:
        return Check("disk", "warn", str(exc))


def _check_relay_secret(env: Mapping[str, str]) -> Check:
    if env.get("RELAY_SECRET", "").strip() or env.get("GATEWAY_SECRET", "").strip():
        return Check("relay.secret", "pass")
    return Check("relay.secret", "warn", "no RELAY_SECRET", "set RELAY_SECRET to gate the HTTP API")


def collect_checks(caps: HostCapabilities | None = None, env: Mapping[str, str] | None = None) -> Report:
    caps = caps or probe_host()
    env = env if env is not None else os.environ
    report = Report()
    report.checks.append(_check_python())
    report.checks.extend(_check_suite(caps))
    report.checks.extend(_check_runtimes(caps))
    report.checks.append(_check_workspace())
    report.checks.extend(_check_mcp())
    report.checks.append(_check_provider_keys(env))
    report.checks.append(_check_github(caps, env))
    report.checks.append(_check_agent_keys())
    report.checks.append(_check_disk())
    report.checks.append(_check_relay_secret(env))
    return report


def run(as_json: bool = False) -> int:
    report = collect_checks()
    if as_json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        for c in report.checks:
            line = f"  {c.status:<4}  {c.name:<18} {c.detail}".rstrip()
            if c.hint:
                line += f"  -> {c.hint}"
            print(line)
        print(f"{len(report.checks) - report.failed - report.warned} pass, {report.warned} warn, {report.failed} fail")
    return 1 if report.failed else 0
