---
name: generative-spaces
area: serve
needs: []
accept: an agent-bootstrapped workspace (tools + generated UI + profile) persists server-side and reloads identically for a second client
surface: web
status: open
evidence: D
provenance: discord thread 2026-11-18 + follow-up (Cypoe: generative workspace, persistent UI/profiles — spaces, not just screens)
---

# generative-spaces

The heavier sibling of `intent-ui`. That slot is screens and views over the
CRUD API — generated on demand, maybe saved. This one is the **space** a
view lives in: an agent-bootstrapped workspace that carries its own tool
set, its generated UI surfaces, and a profile (who it belongs to, what it
remembers), persisted server-side so a second client opens the same space
in the same state.

The distinction that keeps these separate: intent-ui fails closed — if the
view isn't live it dies. A space fails differently — its state, layout, and
tool bindings must *survive*; a space that reloads empty is the regression.

## Acceptance

An agent creates a space (workspace + bound tools + at least one generated
surface + profile). A second client (fresh browser session, or the desktop
shell) opens it and sees the same layout with the same live bindings —
the oracle diffs the two renders' data bindings, not the pixels. Fails if
the second load re-derives from scratch or the profile/tools don't follow.

## Notes

- May absorb `intent-ui` later — likely landing order is views first,
  persistence second, and this slot becomes the "does it stick" oracle for
  both.
- "Profile" here is the workspace's own memory/prefs, not the user account —
  adjacent to agents-memory, not to auth.
- Where spaces live (a `spaces/` or `apps/` collection on the daemon vs the
  workspace root) is open; decide together with `apps-reorg`.
