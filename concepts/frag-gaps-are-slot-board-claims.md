---
type: concept
id: frag-gaps-are-slot-board-claims
provenance: ported from klanker-desktop challenges board (same-day port as the commit-membrane install, deferred a week)
ts: 2026-11-18
---

Belief: an open gap in klanker is a recorded claim on the slot board,
not ambient knowledge. `challenges/<slot>/entry.md` names the gap, its
`needs:` ordering, and an `accept:` oracle that can fail; `landed`
requires evidence artifacts, never self-report. `scripts/board.sh`
validates the entries and regenerates `challenges/CATALOG.md`.

Why it exists: the commit membrane (installed earlier this week) records
what beliefs changed inside commits — but says nothing about which gaps
are open, blocked, or landed. klanker-desktop solved that with the
slot board; without the same ledger here, "what's left to do" stays
tribal and re-discovered per session. The two halves compose: commits
garden beliefs, the board gardens work.

Open questions: whether board slots should cite board issues
(lolaplex-board/agents-board) instead of living only in-repo, and how
the two indexes stay honest once both exist.
