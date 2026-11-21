---
name: deepseek-chat-demo-harvest
area: serve
needs: []
accept: a feature-parity checklist against deepseek-ai/chat-demo exists and every adopted item has its own evidence
surface: web
status: open
evidence: D
provenance: discord thread 2026-11-15 (Cypoe: deepseek open-sourced their whole chat thing — zum ausschlachten)
---

# deepseek-chat-demo-harvest

DeepSeek released their entire chat product as open source
(`deepseek-ai/chat-demo`). That's a reference implementation of everything
a polished agent chat already solved — message rendering, streaming,
sessions, retry/edit, model switch. The challenge isn't to copy it; it's
to harvest it: catalog what it does that klanker's chat doesn't, and adopt
the pieces worth having.

## Acceptance

The checklist itself is the artifact: an `evidence/` file listing what
chat-demo does vs klanker's chat, each row marked adopt/skip with a reason,
and each adopted row linked to a landed implementation. Falsifiable
because a row can be wrong — e.g. "they solved X" and they didn't.

## Notes

- License check first (MIT/other) before lifting code; patterns are
  always fair game.
- Read-through session needed before the checklist is honest — the row
  "unmeasured" is a complete sentence until then.
- Adjacent to intent-ui and unified-session-history — the harvest may
  supply oracles for both.
