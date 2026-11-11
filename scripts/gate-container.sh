#!/bin/sh
# P1 gate: two workspaces isolated inside a klanker container.
# Usage: scripts/gate-container.sh [image]   (default: image built from dev)
set -eu

# Git Bash on Windows would rewrite container paths (/bin/sh -> C:/...).
MSYS2_ARG_CONV_EXCL="${MSYS2_ARG_CONV_EXCL:-*}"
export MSYS2_ARG_CONV_EXCL

IMAGE="${1:-klanker:gate}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(docker images -q "$IMAGE" 2>/dev/null)" = "" ]; then
    docker build -t "$IMAGE" "$ROOT"
fi

CID="$(docker run -d --rm --entrypoint /bin/sh "$IMAGE" -c 'sleep 300')"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

# Two workspaces in one container: disjoint data dirs, shared host infra.
docker exec "$CID" sh -c '
    set -eu
    export AGENTS_HOST_DIR=/data/.agents
    python - <<PY
import os
from agents_workspace import Host

host = Host.from_env()
a = host.workspace("alpha")
b = host.workspace("beta")
a.ensure(); b.ensure()

assert a.memory != b.memory
assert a.traces != b.traces
assert a.relay_state != b.relay_state
assert host.keys.parent == host.dir
assert a.memory.parent == a.dir
assert b.memory.parent == b.dir
assert "alpha" in a.memory.parts
assert "beta" in b.memory.parts

env_a = a.env()
env_b = b.env()
assert env_a["AGENTS_WORKSPACE"] == "alpha"
assert env_b["AGENTS_WORKSPACE"] == "beta"
assert env_a["AGENTS_MEMORY_DIR"] != env_b["AGENTS_MEMORY_DIR"]
print("container gate OK")
PY
'
echo "gate-container: PASS"
