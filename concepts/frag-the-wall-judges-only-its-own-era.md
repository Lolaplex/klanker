---
type: concept
id: frag-the-wall-judges-only-its-own-era
provenance: ported from klanker-desktop CI leg; corrected on first klanker PR (feat/discipline-hooks) when BASE..HEAD flagged 82 pre-discipline commits
ts: 2026-11-18
---

Belief: the commit-discipline wall judges only commits authored into a tree that already carried it. Pre-gate history is exempt by ancestry, not by forgiveness.

Concretely: `commit-discipline.yml` checks `BASE..HEAD`, minus everything
reachable from the parent of the commit that first added
`hooks/commit-msg.cjs`. Ancestry is the test, not date (rebase preserves
author dates) and not a manual allowlist (silence by another name).

Why it exists: the ported gate's naive range assumed every PR commit was
authored under the discipline — never true in a repo with history. The
first klanker PR flagged 82 inherited dev commits; a future dev→main
release PR would fail on the same commits, permanently, unless the rule
knows which era a commit belongs to. Rewriting release history to satisfy
a linter is strictly worse than exempting it.

Open questions: whether branches forked from pre-gate history should get
the same exemption when they land after the gate (they do — ancestry
handles it, and their NEW commits are still judged).
