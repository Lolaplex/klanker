#!/usr/bin/env python3
"""dev-suite.py — one dev switch for the whole agents-* suite.

Reads pyproject.toml (the only dep list — it cannot drift) and installs
every ``agents-*`` requirement from source, never from PyPI:

  - a sibling checkout exists (``<repo-parent>/agents-*``) → ``pip install -e``
    so uncommitted local work flows through — true lock-step with dev work
  - no sibling → ``pip install "name @ git+https://github.com/Lolaplex/<name>.git@<ref>"``

Usage:

    python scripts/dev-suite.py            # install the suite from source
    python scripts/dev-suite.py --emit     # print git-ref requirement lines
    python scripts/dev-suite.py --dry-run  # show what would run

Env:

    SUITE_REF          default git ref (default: dev) — same name the
                       Dockerfile ARG and self-deploy.sh use
    <NAME>_REF         per-package override, dashes → underscores
                       (e.g. RELAY_REF=main for agents-relay) — same names
                       the Dockerfile ARGs use
    AGENTS_SUITE_DIR   directory holding sibling checkouts
                       (default: parent of this repo)

``--emit`` always prints the git-URL form for every dep — the Dockerfile
consumes it (images have no sibling checkouts but keep the per-package
ARG override surface).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEP_RE = re.compile(r"^(agents-[\w-]+)(\[[^\]]+\])?")
GIT_URL = "git+https://github.com/Lolaplex/{name}.git@{ref}"


def suite_deps() -> list[tuple[str, str]]:
    """(name, extras) for every agents-* dependency in pyproject.toml."""
    deps = tomllib.loads((REPO / "pyproject.toml").read_text())["project"]["dependencies"]
    out = []
    for dep in deps:
        m = DEP_RE.match(dep)
        if m:
            out.append((m.group(1), m.group(2) or ""))
    return out


def ref_for(name: str) -> str:
    env = name.upper().replace("-", "_") + "_REF"
    return os.environ.get(env, os.environ.get("SUITE_REF", "dev"))


def git_req(name: str, extras: str) -> str:
    return f"{name}{extras} @ {GIT_URL.format(name=name, ref=ref_for(name))}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--emit", action="store_true", help="print git-ref requirements and exit")
    ap.add_argument("--dry-run", action="store_true", help="print the pip command and exit")
    args = ap.parse_args()

    deps = suite_deps()
    if args.emit:
        for name, extras in deps:
            print(git_req(name, extras))
        return 0

    suite_dir = Path(os.environ.get("AGENTS_SUITE_DIR", REPO.parent))
    reqs, plan = [], []
    for name, extras in deps:
        sibling = suite_dir / name
        if (sibling / "pyproject.toml").is_file():
            reqs += ["-e", f"{sibling}{extras}"]
            plan.append(f"{name}{extras}: editable {sibling}")
        else:
            reqs.append(git_req(name, extras))
            plan.append(f"{name}{extras}: git@{ref_for(name)} (no sibling in {suite_dir})")

    cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", *reqs]
    print("\n".join(plan))
    if args.dry_run:
        print("$ " + " ".join(cmd))
        return 0
    return subprocess.run(cmd).returncode


if __name__ == "__main__":
    raise SystemExit(main())
