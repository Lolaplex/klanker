#!/bin/sh
# Recreate a compose project only when its registry image moved.
# Live copy: /volume1/docker/pull-latest.sh (host cron, not a container).
# No Watchtower. Not Orisha. compose up re-reads compose.yml (group_add stays).
#
#   nas-pull-latest.sh                         # koru + assistant + klanker
#   nas-pull-latest.sh /volume1/docker/klanker
set -eu
PATH=/usr/local/bin:/usr/bin:/bin
COMPOSE=/usr/local/bin/docker-compose

update() {
  dir=$1
  file=$dir/compose.yml
  if [ ! -f "$file" ]; then
    echo "skip $dir (no compose.yml)"
    return 0
  fi
  "$COMPOSE" -f "$file" --project-directory "$dir" \
    up -d --no-build --pull always --remove-orphans
}

if [ -n "${1:-}" ]; then
  update "$1"
  exit 0
fi

update /volume1/docker/koru-orisha-media
update /volume1/docker/agents-assistant
update /volume1/docker/klanker
