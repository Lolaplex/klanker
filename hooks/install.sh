#!/usr/bin/env bash
# Install the membrane + signal discipline into klanker-desktop (or any repo).
# Ported from koru-os/hooks/install.sh: same self-contained-corpus default,
# same seed-signals step; post-commit writes a local .git/signal-cards.jsonl
# ledger. Gates wall here is UNIVERSAL (AGENTS.md: every authored commit
# answers all three sections).
#
#   hooks/install.sh                 # install into THIS repo (self corpus)
#   hooks/install.sh /path/to/repo   # install into another repo
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORPUS_ROOT="$(cd "$HERE/.." && pwd)"
TARGET="$(cd "${1:-$CORPUS_ROOT}" && pwd)"

HOOKS="$(git -C "$TARGET" rev-parse --absolute-git-dir)/hooks"
mkdir -p "$HOOKS" "$TARGET/concepts" "$TARGET/signals"
[ -e "$TARGET/concepts/.gitkeep" ] || : > "$TARGET/concepts/.gitkeep"
for h in commit-msg commit-msg.cjs post-commit post-commit.cjs pre-commit; do
  cp "$HERE/$h" "$HOOKS/$h"; chmod +x "$HOOKS/$h"
done

echo "installed commit-msg + post-commit + pre-commit -> $HOOKS"
echo "topology: self-contained (this repo is its own corpus — no .membrane pointer)"

# --- pre-commit's oracle rides along: git_wall.sh + an empty allowlist -----
# A foreign target has no scripts/git_wall.sh, and the hook refuses LOUDLY by
# design — so the wall must be installed beside the hooks, or install.sh would
# hand a foreign repo a pre-commit that can only ever fail missing-script.
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
