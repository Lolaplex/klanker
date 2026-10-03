#!/bin/sh
set -e

# Ensure data, workspace, and overlay directories exist
mkdir -p /data /data/.agents /data/.agents/memory /data/schedules /data/modules /data/traces /data/workspace /data/inbox
export AGENTS_WORKSPACE_DIR="${AGENTS_WORKSPACE_DIR:-/data/workspace}"
export AGENTS_HOME="${AGENTS_HOME:-/data/.agents}"
python -c "from klanker.overlay import install_overlay; install_overlay()" 2>/dev/null || true
python -c "from klanker.git_identity import setup_git_identity; setup_git_identity()" 2>/dev/null || true
chown -R klanker:klanker /data 2>/dev/null || true
chmod 775 /data 2>/dev/null || true
[ -f /data/.git-credentials ] && chmod 600 /data/.git-credentials 2>/dev/null || true
[ -f /data/.gitconfig ] && chmod 644 /data/.gitconfig 2>/dev/null || true

# If Docker socket is mounted for host inspection / container verbs
if [ -S /var/run/docker.sock ]; then
    chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

# Drop privileges to klanker user if started as root
if [ "$(id -u)" = "0" ]; then
    exec setpriv --reuid=klanker --regid=klanker --init-groups "$@"
else
    exec "$@"
fi
