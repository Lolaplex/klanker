#!/bin/sh
# Recreate compose projects only when their registry image moved.
# Dirs come from args or $PROJECT_DIRS (space-separated). No defaults.
#
#   pull-latest.sh /path/to/project-a /path/to/project-b
#   PROJECT_DIRS="/path/a /path/b" pull-latest.sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin
COMPOSE="${DOCKER_COMPOSE:-docker-compose}"

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

if [ "$#" -gt 0 ]; then
  for d in "$@"; do update "$d"; done
  exit 0
fi

if [ -n "${PROJECT_DIRS:-}" ]; then
  for d in $PROJECT_DIRS; do update "$d"; done
  exit 0
fi

echo "usage: pull-latest.sh <project-dir> [...]  (or set PROJECT_DIRS)" >&2
exit 2
