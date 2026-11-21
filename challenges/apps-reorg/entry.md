---
name: apps-reorg
area: serve
needs: []
accept: a re-org plan exists in evidence/ listing every user-facing surface, its proposed apps/ home, and no surface left unfiled
surface: web
status: open
evidence: D
provenance: follow-up session (Cypoe: no real apps/ folder in klanker, everything a bit all over the place — like hermes or backplane repos)
---

# apps-reorg

Klanker grew surfaces without an organizing unit: web UI components, the
dashboard, discovery, settings, generated views — "a bit all over the
place". The hermes/backplane model puts user-facing applications under a
visible `apps/` collection — each app a directory with its own contract —
instead of surfaces accreting wherever they landed. This challenge is the
**re-org plan**, not the move: before directories shift, every surface
needs a destination or an explicit "stays outside apps/" ruling.

## Acceptance

`evidence/surface-map.md` in this challenge dir: a full inventory of
klanker's user-facing surfaces (web routes, panels, embedded tools) each
mapped to a proposed `apps/` home or an explicit exclusion with reason.
The oracle is completeness — a `grep` of `web/src/` routes against the
map finds zero unfiled entries. Falsifiable because a missed surface or
a double-filed one makes the row wrong.

## Notes

- This gates `intent-ui` and `generative-spaces`: generated views/spaces
  need somewhere to persist, and `apps/` is the obvious filing system —
  decide this layout before they land.
- agents-relay has the same smell one layer down (protocols vs server) —
  a parallel `src/protocols/` re-org there was discussed; keep the two
  plans consistent but separate repos, separate commits.
- The daemon's API surface (`/v1/*`) should NOT move — only presentation.
