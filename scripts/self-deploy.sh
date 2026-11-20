#!/bin/sh
# self-deploy.sh — rebuild and push the klanker image from inside the
# klanker container. Requires the compose mounts that make this possible:
#   /var/run/docker.sock  (docker API; group_add <docker-sock gid>)
#   <repo checkout>:/src  (this git clone, kept on SUITE_REF)
#
# The container does NOT recreate itself — that is the host's job.
# /volume1/docker/pull-latest.sh (host cron, ~5min) runs
# `compose up -d --pull always` and recreates only when the digest moved.
# This script's contract ends at `docker push`.
#
# Env:
#   KLANKER_SRC      repo checkout inside the container (default /src)
#   KLANKER_REF      git ref to build (default dev)
#   KLANKER_IMAGE    image name without registry (default klanker)
#   KLANKER_TAGS     space-separated tags (default "latest")
#   KLANKER_REGISTRY push target reachable from the NAS (default 127.0.0.1:9500)
#   GITHUB_TOKEN     needed while any suite repo is private (build arg only)
set -eu

SRC="${KLANKER_SRC:-/src}"
REF="${KLANKER_REF:-dev}"
IMAGE="${KLANKER_IMAGE:-klanker}"
TAGS="${KLANKER_TAGS:-latest}"
REGISTRY="${KLANKER_REGISTRY:-127.0.0.1:9500}"
LOCAL="${IMAGE}:selfbuild"

echo "self-deploy: fetching $REF in $SRC"
git -C "$SRC" fetch origin "$REF"
git -C "$SRC" checkout --detach "origin/$REF"

BUST="$(date +%Y%m%d%H%M%S)"
BUILD_ARGS="--build-arg SUITE_REF=$REF --build-arg CACHE_BUST=$BUST"
if [ -n "${GITHUB_TOKEN:-}" ]; then
    BUILD_ARGS="$BUILD_ARGS --build-arg GITHUB_TOKEN=$GITHUB_TOKEN"
else
    echo "self-deploy: GITHUB_TOKEN unset — build fails if any suite repo is private" >&2
fi

echo "self-deploy: building $LOCAL (ref=$REF)"
# shellcheck disable=SC2086
docker build $BUILD_ARGS -t "$LOCAL" "$SRC"

for tag in $TAGS; do
    target="$REGISTRY/$IMAGE:$tag"
    docker tag "$LOCAL" "$target"
    echo "self-deploy: pushing $target"
    docker push "$target"
done

echo "self-deploy: pushed — host pull-latest.sh recreates on digest move"
