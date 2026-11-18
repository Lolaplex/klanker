---
type: concept
id: frag-beliefs-garden-in-the-same-commit
provenance: ported from klanker-desktop/koru-os discipline; first frag this gate produced in klanker
ts: 2026-11-18
---

Belief: a commit that changes a durable belief must carry the belief in the same commit. Never queue it away.

Concretely: hooks/ enforces three sections on every authored commit —
`## World Model` (what belief changed), `## Gates` (measured evidence,
or `deferred — <reason>`), `## Membrane` (concept lineage, or
`Evolution: acknowledged-none`). A belief-class signal (`membrane: true`
types in `signals/*.signal`) without a staged `concepts/frag-*.md` refuses:
the signal says a belief moved; the frag is where it lands.

Why it exists: the failure mode this kills is silent belief drift — a
session changes a ruling, ships the code, and the belief update sits in a
chat log until it rots. Coupling the signal to the garden makes the update
atomic with the change that produced it.

Open questions: which suite repos get the port next (agents-* family
shares the workflow); whether `Host`-era agents_workspace lands so the
Gates rows can be pytest-measured rather than deferred.
