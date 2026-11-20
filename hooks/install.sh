#!/usr/bin/env bash
# Install the membrane + signal discipline into klanker (or any repo that vendors hooks/).
# Sets core.hooksPath=hooks (idempotent) so git runs the in-repo dispatchers; refuses
# core.hooksPath=/dev/null, which disables hooks silently.
#
#   hooks/install.sh                 # install into THIS repo (self corpus)
#   hooks/install.sh /path/to/repo   # install into another repo
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORPUS_ROOT="$(cd "$HERE/.." && pwd)"
TARGET="$(cd "${1:-$CORPUS_ROOT}" && pwd)"

CURRENT="$(git -C "$TARGET" config --get core.hooksPath 2>/dev/null || true)"
case "$CURRENT" in
  /dev/null|dev/null)
    echo "refusing: core.hooksPath=$CURRENT disables hooks — run: git config --unset core.hooksPath" >&2
    exit 1
    ;;
esac
git -C "$TARGET" config core.hooksPath hooks

mkdir -p "$TARGET/hooks" "$TARGET/concepts" "$TARGET/signals"
[ -e "$TARGET/concepts/.gitkeep" ] || : > "$TARGET/concepts/.gitkeep"
for h in commit-msg commit-msg.cjs post-commit post-commit.cjs pre-commit install.sh; do
  if [ ! -f "$TARGET/hooks/$h" ] && [ -f "$HERE/$h" ]; then
    cp "$HERE/$h" "$TARGET/hooks/$h"
  fi
  if [ -f "$TARGET/hooks/$h" ]; then
    chmod +x "$TARGET/hooks/$h"
  fi
done

echo "core.hooksPath=hooks (idempotent) -> $(git -C "$TARGET" config --get core.hooksPath)"
echo "topology: self-contained (this repo is its own corpus — no .membrane pointer)"

# --- pre-commit's oracle rides along: git_wall.sh + an empty allowlist -----
mkdir -p "$TARGET/scripts"
if [ -f "$HERE/../scripts/git_wall.sh" ]; then
  [ -f "$TARGET/scripts/git_wall.sh" ] || cp "$HERE/../scripts/git_wall.sh" "$TARGET/scripts/git_wall.sh"
  chmod +x "$TARGET/scripts/git_wall.sh" 2>/dev/null || true
fi
if [ ! -f "$TARGET/scripts/git_wall_allowlist.txt" ]; then
  printf '# git_wall allowlist - grandfather only; the wall does not widen
' > "$TARGET/scripts/git_wall_allowlist.txt"
fi

# --- seed the belief-class + koru-os signals; never clobber a gardened one ---
if [ -d "$HERE/signals" ]; then
  for sig in "$HERE"/signals/*.signal; do
    [ -e "$sig" ] || continue
    dest="$TARGET/signals/$(basename "$sig")"
    [ -e "$dest" ] || cp "$sig" "$dest"
  done
  echo "signals                            -> $TARGET/signals/ (seeds only missing files)"
fi

echo ""
echo "The commit-msg gate now requires, on every authored commit:"
echo "  ## World Model   Signal: <type> — <note>   (or Signals: acknowledged-none)"
echo "  ## Membrane      Action/Concept lineage, or Evolution: acknowledged-none"
echo "  ## Gates         required on every authored commit:"
echo "                   'name: pass/total' rows, 'name: clean', or 'deferred — <reason>'"
echo ""
echo "Beliefs live in concepts/frag-<id>.md (frontmatter: type/id/provenance/ts)."
echo "Signals grow by declaration — declare one and its interface file is minted"
echo "(edit-distance-1 near-misses refuse, so typos can't fork the ontology)."
echo "Telemetry: .git/signal-cards.jsonl (append-only, untracked)."
echo ""
echo "Never set core.hooksPath=/dev/null — that bypasses discipline without --no-verify."