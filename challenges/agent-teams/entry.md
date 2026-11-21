---
name: agent-teams
area: brain
needs: []
accept: one goal spawns and coordinates at least two agent sessions whose traces show division of work to completion
surface: any
status: open
evidence: D
provenance: discord thread 2026-11-17 (devin.ai/blog/introducing-devin-bots — engineering teammates that own goals and lead teams of Devins)
---

# agent-teams

Devin Bots are sold as agents that own a goal and lead teams of agents to
deliver it. Klanker already has personas, workspaces, and multi-session
jobs — the gap is orchestrated division: one goal decomposed into
sub-sessions led by a coordinating agent, with the pieces joined back into
one outcome. "alle klauen sie von uns" — this is ours to land first.

## Acceptance

One goal prompt produces ≥2 distinct agent sessions (visible as separate
traces) whose work is coordinated by a lead session and joined into a
single reported outcome. The oracle must be able to say no: two parallel
sessions that never exchange results, or one session doing everything,
both fail it.

## Notes

- Relay handoffs (`/inbox/<task>/handoff` + `?wake=1`) are the
  already-built coordination primitive — this slot is the leader logic
  that decides when to hand off, not new plumbing.
- Session fork (Felix's recent work) is a candidate substrate.
- Trace shape matters for the oracle: parent/child linkage must be
  recorded, not implied.
