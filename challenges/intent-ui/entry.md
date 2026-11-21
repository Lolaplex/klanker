---
name: intent-ui
area: serve
needs: []
accept: a prompt-generated view renders live klanker API data and can be re-opened from a saved list
surface: web
status: open
evidence: D
provenance: discord thread 2026-11-18 (Cypoe: intent UI over plain CRUD APIs, same interface always)
---

# intent-ui

Today the web UI is hand-built surfaces. The goal: klanker generates its own
tabs/apps/views over its existing CRUD APIs — the user asks for a view
("my sessions grouped by project"), klanker composes it, and the user can
save it so it persists as a first-class surface. One interface, always the
same — no new UI to learn, just new views over the same data.

Prior art to mine: `thesysdev/openui` (generative UI standard),
`Aaryan-Kapoor/it` (referenced as "more sicken stuff" — unexamined).

## Acceptance

One prompt produces a view bound to live `/v1/*` data (not a mock), the view
is stored server-side or per-workspace, and re-opening it renders fresh data.
The falsifying oracle: kill and reload the page — the saved view is still
there and still live.

## Notes

- Felix's dashboard surfaces are the substrate — intent-ui is the
  agent-generated layer on top, not a rewrite.
- "so with hermes, mit halt nen apps/ ordner oder so?" — the storage shape
  (a user-facing apps/ or views/ collection) is undecided; pin down before
  building.
- Sandbox question: generated views execute code — what runs them (iframe,
  sandboxed component tree, declarative schema) decides the risk profile.
