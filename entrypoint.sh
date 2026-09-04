#!/bin/sh
set -e

# Ensure data and overlay directories exist
mkdir -p /data /data/.agents /data/.agents/memory /data/schedules /data/modules /data/traces
chown -R klanker:klanker /data 2>/dev/null || true
chmod 775 /data 2>/dev/null || true

# If Docker socket is mounted for host inspection / container verbs
if [ -S /var/run/docker.sock ]; then
    chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

# Drop privileges to klanker user if started as root
if [ "$(id -u)" = "0" ]; then
    exec su -s /bin/sh klanker -c "$*"
else
    exec "$@"
fi