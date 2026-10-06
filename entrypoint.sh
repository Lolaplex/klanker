#!/bin/sh
set -e

# Ensure data, workspace, and overlay directories exist
mkdir -p /data /data/.agents /data/.agents/memory /data/.agents/skills /data/.agents/schedules /data/.agents/modules /data/schedules /data/modules /data/traces /data/workspace /data/inbox
export AGENTS_WORKSPACE_DIR="${AGENTS_WORKSPACE_DIR:-/data/workspace}"
export AGENTS_HOME="${AGENTS_HOME:-/data/.agents}"
python -c "from klanker.overlay import install_overlay; install_overlay()" 2>/dev/null || true
python -c "from klanker.git_identity import setup_git_identity; setup_git_identity()" 2>/dev/null || true
chown -R klanker:klanker /data 2>/dev/null || true
chmod 775 /data 2>/dev/null || true
[ -f /data/.git-credentials ] && chmod 600 /data/.git-credentials 2>/dev/null || true
[ -f /data/.gitconfig ] && chmod 644 /data/.gitconfig 2>/dev/null || true

# Docker socket: join the socket's group. Never make the socket world-writable.
# If group setup fails, set group_add on the service to the host socket gid
# (stat -c %g /var/run/docker.sock).
if [ -S /var/run/docker.sock ] && [ "$(id -u)" = "0" ]; then
    sock_gid=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)
    if [ -n "$sock_gid" ]; then
        if ! getent group "$sock_gid" >/dev/null 2>&1; then
            groupadd --gid "$sock_gid" dockerhost 2>/dev/null || true
        fi
        sock_group=$(getent group "$sock_gid" 2>/dev/null | cut -d: -f1 || true)
        if [ -n "$sock_group" ]; then
            usermod -aG "$sock_group" klanker 2>/dev/null || true
        fi
    fi
fi

# Drop privileges to klanker user if started as root
if [ "$(id -u)" = "0" ]; then
    exec setpriv --reuid=klanker --regid=klanker --init-groups "$@"
else
    exec "$@"
fi
