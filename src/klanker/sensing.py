"""Host capability probe (Slimemold sensing)."""

from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path


COMMON_RUNTIMES = ["git", "docker", "curl", "node", "npm", "uv", "sqlite3"]
SUITE_MODULES = {
    "harness": "runner.loop",
    "gateway": "agents_gateway",
    "memory": "agents_memory",
    "docs": "agents_docs",
    "traces": "agents_traces",
    "keys": "agents_keys",
    "browser": "agents_browser",
}


@dataclass(frozen=True)
class HostCapabilities:
    os_name: str
    is_tty: bool
    python_version: str
    runtimes: dict[str, bool] = field(default_factory=dict)
    suite_modules: dict[str, bool] = field(default_factory=dict)
    has_agents_home: bool = False

    # Backwards-compatible convenience properties
    @property
    def has_git(self) -> bool:
        return self.runtimes.get("git", False)

    @property
    def has_docker(self) -> bool:
        return self.runtimes.get("docker", False)

    @property
    def has_curl(self) -> bool:
        return self.runtimes.get("curl", False)

    @property
    def has_harness(self) -> bool:
        return self.suite_modules.get("harness", False)

    @property
    def has_gateway(self) -> bool:
        return self.suite_modules.get("gateway", False)

    @property
    def has_memory(self) -> bool:
        return self.suite_modules.get("memory", False)

    @property
    def has_docs(self) -> bool:
        return self.suite_modules.get("docs", False)

    @property
    def has_traces(self) -> bool:
        return self.suite_modules.get("traces", False)

    def summary(self) -> dict[str, object]:
        return {
            "os_name": self.os_name,
            "is_tty": self.is_tty,
            "python_version": self.python_version,
            "has_agents_home": self.has_agents_home,
            "runtimes": self.runtimes,
            "suite_modules": self.suite_modules,
        }


def probe_host() -> HostCapabilities:
    """Probe current environment and available feelers dynamically."""
    def _has_cmd(cmd: str) -> bool:
        return shutil.which(cmd) is not None

    def _has_mod(name: str) -> bool:
        try:
            return importlib.util.find_spec(name) is not None
        except Exception:
            return False

    runtimes = {cmd: _has_cmd(cmd) for cmd in COMMON_RUNTIMES}
    modules = {alias: _has_mod(pkg) for alias, pkg in SUITE_MODULES.items()}
    agents_home = Path.home() / ".agents"

    return HostCapabilities(
        os_name=platform.system(),
        is_tty=sys.stdin.isatty() if hasattr(sys.stdin, "isatty") else False,
        python_version=platform.python_version(),
        runtimes=runtimes,
        suite_modules=modules,
        has_agents_home=agents_home.exists(),
    )

