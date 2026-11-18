---
name: <slot-name>
area: <brain|wire|relay|serve|cron|cli|docs>   # what kind of gap this is
needs: []                    # slot names that must be landed|waived first
accept: <command>            # the falsifying oracle — must be able to say no
surface: <cli|daemon|web|relay|any>
status: open                 # open | claimed | landed | waived
evidence: D                  # V | M | C | D — grade of current claims
provenance: none-yet         # repo@SHA / source for derived work
---

# <slot-name>

One paragraph: what the slot is, what exists today (with evidence class),
what the gap actually is. Cite pins (`git rev-parse HEAD`), measured
mismatches, and prior art (agents-harness, agents-relay, koru-distill).

## Acceptance

What `accept:` proves, step by step, and which artifact decides it.
Name the independent oracle — a build, a roundtrip, a diff — never
self-report alone. `unmeasured` is a complete sentence.

## Notes

Ordering constraints, licensing, things measured vs assumed, upstream
deps (agents-harness, agents-relay, agents-memory, board) that live
outside this repo.
