"""Suite drift check — the portable self-deploy watcher.

Compares the git SHAs of installed ``agents-*`` distributions against the
remote branch tips. With ``--deploy`` it triggers the host's deploy path
only when a package actually drifted, so repeated runs never queue a
same-commit rebuild. This is the general mechanism: any host klanker
runs on gets self-deploy without a per-repo webhook.

Deploy path resolution (first match wins):

- Coolify: ``COOLIFY_API_URL`` + ``COOLIFY_API_TOKEN`` +
  ``COOLIFY_RESOURCE_UUID`` are injected into every Coolify-managed
  container → ``POST /api/v1/deploy?uuid=…&force=false``.
- self-deploy host (e.g. NAS): docker socket + a repo checkout at
  ``KLANKER_SRC`` (default ``/src``) → ``scripts/self-deploy.sh``.

Exit codes: 0 = suite current, 2 = drift detected, 3 = drift but no
deploy path on this host.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import urllib.request

_GIT_DEP = re.compile(
    r"^(agents-[\w-]+)\s*@\s*git\+(https://[^@\s]+?\.git)@([0-9a-f]{6,40})\s*$"
)


def _installed() -> dict[str, tuple[str, str]]:
    """package name -> (repo url, installed sha) for agents-* git installs."""
    proc = subprocess.run(
        [sys.executable, "-m", "pip", "freeze"],
        capture_output=True,
        text=True,
    )
    pkgs: dict[str, tuple[str, str]] = {}
    for line in proc.stdout.splitlines():
        m = _GIT_DEP.match(line.strip())
        if m:
            pkgs[m.group(1)] = (m.group(2), m.group(3))
    return pkgs


def _remote_sha(url: str, ref: str) -> str:
    proc = subprocess.run(
        ["git", "ls-remote", url, ref],
        capture_output=True,
        text=True,
        timeout=30,
    )
    for line in proc.stdout.splitlines():
        parts = line.split()
        if parts:
            return parts[0]
    return ""


def _deploy() -> str:
    url = os.environ.get("COOLIFY_API_URL", "").strip().rstrip("/")
    token = os.environ.get("COOLIFY_API_TOKEN", "").strip()
    uuid = os.environ.get("COOLIFY_RESOURCE_UUID", "").strip()
    if url and token and uuid:
        req = urllib.request.Request(
            f"{url}/deploy?uuid={uuid}&force=false",
            method="POST",
            headers={"Authorization": f"Bearer {token}"},
        )
        body = urllib.request.urlopen(req, timeout=30).read().decode(
            "utf-8", "replace"
        )
        return f"coolify deploy queued: {body[:200]}"
    src = os.environ.get("KLANKER_SRC", "/src")
    script = os.path.join(src, "scripts", "self-deploy.sh")
    if os.path.exists("/var/run/docker.sock") and os.path.isfile(script):
        proc = subprocess.run(
            ["sh", script], capture_output=True, text=True, timeout=3600
        )
        tail = (proc.stdout or proc.stderr).strip()[-200:]
        return f"self-deploy.sh rc={proc.returncode}: {tail}"
    return "no deploy path (no COOLIFY_* env and no /src + docker.sock)"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="klanker drift")
    ap.add_argument(
        "--ref",
        default=os.environ.get("SUITE_REF") or os.environ.get("KLANKER_REF") or "dev",
        help="Suite branch/tag to compare against (default: SUITE_REF or dev)",
    )
    ap.add_argument(
        "--deploy",
        action="store_true",
        help="Trigger the host deploy path when drift is detected",
    )
    args = ap.parse_args(argv)

    pkgs = _installed()
    if not pkgs:
        print("no agents-* git installs found (release image?)")
        return 0

    drift: list[tuple[str, str, str]] = []
    for pkg, (url, sha) in sorted(pkgs.items()):
        try:
            remote = _remote_sha(url, args.ref)
        except Exception as exc:
            print(f"{pkg}: ls-remote failed ({exc})")
            continue
        if not remote:
            print(f"{pkg}: no remote ref {args.ref}")
        elif remote != sha:
            drift.append((pkg, sha, remote))

    if not drift:
        print(f"suite current vs {args.ref} ({len(pkgs)} pkgs)")
        return 0

    for pkg, sha, remote in drift:
        print(f"drift {pkg}: {sha[:8]} -> {remote[:8]}")
    if args.deploy:
        print(_deploy())
    else:
        print("no --deploy flag; report only")
    return 2
