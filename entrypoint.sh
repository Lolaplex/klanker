#!/bin/sh
set -e

# Ensure data, workspace, and overlay directories exist
mkdir -p /data /data/.agents /data/.agents/memory /data/schedules /data/modules /data/traces /data/workspace /data/inbox
export AGENTS_WORKSPACE_DIR="${AGENTS_WORKSPACE_DIR:-/data/workspace}"
export AGENTS_HOME="${AGENTS_HOME:-/data/.agents}"
python -c "from klanker.overlay import install_overlay; install_overlay()" 2>/dev/null || true
chown -R klanker:klanker /data 2>/dev/null || true
chmod 775 /data 2>/dev/null || true

# If Docker socket is mounted for host inspection / container verbs
if [ -S /var/run/docker.sock ]; then
    chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

# Setup git authentication for GitHub if token is set
if [ -n "$GITHUB_TOKEN" ] || [ -n "$GH_TOKEN" ]; then
    GH_T="${GITHUB_TOKEN:-$GH_TOKEN}"
    git config --global url."https://${GH_T}@github.com/".insteadOf "https://github.com/" 2>/dev/null || true
    printf 'https://x-access-token:%s@github.com\n' "$GH_T" > /data/.git-credentials 2>/dev/null || true
    chmod 600 /data/.git-credentials 2>/dev/null || true
fi

# Drop privileges to klanker user if started as root
if [ "$(id -u)" = "0" ]; then
    exec setpriv --reuid=klanker --regid=klanker --init-groups "$@"
else
    exec "$@"
fi