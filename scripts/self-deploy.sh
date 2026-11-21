#!/bin/sh
# self-deploy.sh — rebuild and push the klanker image from inside the
# klanker container. Requires the compose mounts that make this possible:
#   /var/run/docker.sock  (docker API; group_add <docker-sock gid>)
#   <repo checkout>:/src  (this git clone, kept on KLANKER_REF)
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
#   KLANKER_DOCKERFILE Dockerfile path relative to $SRC (default Dockerfile;
#                      e.g. Dockerfile.nas for a deployment-specific overlay)
#   GITHUB_TOKEN     needed while any suite repo is private (BuildKit secret mount)
set -eu

export DOCKER_BUILDKIT=1

SRC="${KLANKER_SRC:-/src}"
REF="${KLANKER_REF:-dev}"
IMAGE="${KLANKER_IMAGE:-klanker}"
TAGS="${KLANKER_TAGS:-latest}"
REGISTRY="${KLANKER_REGISTRY:-127.0.0.1:9500}"
DOCKERFILE="${KLANKER_DOCKERFILE:-Dockerfile}"
LOCAL="${IMAGE}:selfbuild"

echo "self-deploy: fetching $REF in $SRC"
# /src is a host-owned checkout — the container user needs the safe.directory
# exception once per boot (git config lives in $HOME=/data, persists on the
# volume, but this is cheap and idempotent).
git config --global --add safe.directory "$SRC" 2>/dev/null || true
git -C "$SRC" fetch origin "$REF"
# /src is build-only: reset hard, then clear drift — but keep untracked
# overlay files (Dockerfile.nas, compose.nas.*) that live only on the host.
git -C "$SRC" reset --hard "origin/$REF"
git -C "$SRC" clean -fd -e 'Dockerfile.nas' -e 'compose.nas.*'

BUST="$(date +%Y%m%d%H%M%S)"
BUILD_ARGS="--build-arg SUITE_REF=$REF --build-arg CACHE_BUST=$BUST"
SECRET_ARGS=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
    SECRET_ARGS="--secret id=github_token,env=GITHUB_TOKEN"
else
    echo "self-deploy: GITHUB_TOKEN unset — build fails if any suite repo is private" >&2
fi

if [ "$DOCKERFILE" != "Dockerfile" ]; then
    # Overlay mode: the overlay is FROM the registry's previous image, so
    # building it alone ships a stale suite. Build the public image first —
    # that is what tracks $REF — then layer the overlay on the fresh base.
    echo "self-deploy: building base image first (ref=$REF)"
    # shellcheck disable=SC2086
    docker build $BUILD_ARGS $SECRET_ARGS -f "$SRC/Dockerfile" -t "$LOCAL" "$SRC"
    echo "self-deploy: layering overlay $DOCKERFILE on fresh base"
    docker build --build-arg "BASE_IMAGE=$LOCAL" -f "$SRC/$DOCKERFILE" -t "$LOCAL" "$SRC"
else
    echo "self-deploy: building $LOCAL (ref=$REF, dockerfile=$DOCKERFILE)"
    # shellcheck disable=SC2086
    docker build $BUILD_ARGS $SECRET_ARGS -f "$SRC/$DOCKERFILE" -t "$LOCAL" "$SRC"
fi

for tag in $TAGS; do
    target="$REGISTRY/$IMAGE:$tag"
    docker tag "$LOCAL" "$target"
    echo "self-deploy: pushing $target"
    docker push "$target"
done

echo "self-deploy: pushed — host pull-latest.sh recreates on digest move"
