---
type: concept
id: frag-slimemold-grows-feelers
provenance: distilled from .agents/memory/notes/implemented/architecture/clanker-vision.md (product vision)
ts: 2026-11-21
---

Belief: klanker is a zero-bloat universal nucleus — it grows only the
feelers its host actually needs, detected by host sensing, not shipped as
fixed feature sets.

The Slimemold paradigm: no hardcoded briefings, no rigid scripts, no
opinionated chatbot shape. The nucleus boots on any environment (VPS,
workstation, Pi, Docker, CI) with stdlib-only minimum, senses the host,
and grows three feeler classes on demand — I/O (TTY, desktop IPC, relay
gateway, HTTP), memory (flat markdown, agents-memory, custom MCP), and
tools (local shell, FastMCP, Docker/Coolify, browser CDP). Each feeler is
a loose plug: present where the host supports it, absent where it doesn't,
never a hard dependency.

This is why `klanker sense` exists as a first-class command — the product's
shape is per-host, and sensing is the mechanism that decides which feelers
grow.
