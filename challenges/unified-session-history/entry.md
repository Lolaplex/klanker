---
name: unified-session-history
area: serve
needs: []
accept: sessions from at least two agent sources (e.g. klanker sessions + relay jobs or devin ACP sessions) are listed in one surface
surface: web
status: open
evidence: D
provenance: discord thread 2026-11-18 (Cypoe: everyone in devin discord complains session history is scattered, nobody has one interface)
---

# unified-session-history

Agent work leaves sessions in every tool's own silo — klanker sessions,
relay jobs, devin ACP sessions, telegram turns, future clients. Nobody has
one interface over all of them. The gap is the cross-agent history surface:
one list, one search, one "what was I doing" answer regardless of which
surface or agent ran the work.

## Acceptance

A single surface lists sessions from ≥2 independent sources with stable
identity (who ran it, when, where the transcript lives), newest first.
The oracle: create a session via relay `/v1/turn` and one via `klanker chat`,
then show both in the same view — fails if either is missing or requires
the other tool's UI to find.

## Notes

- Traces already share the agents-traces format — the hard part is session
  *indexing*, not transcript storage.
- Overlaps the herd-view thesis: aggregation is client-side, sources stay
  dumb. The index should be a view over sources, not a new silo.
- assistant.db at `/data/legacy/` on sigmanas is a real migration case —
  its `messages` table is session history stranded in the old schema.
