---
name: sandboxed-desktop-stream
area: serve
needs: []
accept: a live desktop frame from a sandboxed container renders inside the klanker web UI client
surface: web
status: open
evidence: D
provenance: discord thread 2026-11-18 (Cypoe: grok-computer analog; tempo/voxl for streaming, agent0ai/tuxee inside the same docker project)
---

# sandboxed-desktop-stream

Computer-use agents need a real desktop, not a text terminal. The goal is
the grok-computer analog for klanker: a sandboxed container running a
desktop environment whose frames stream into the klanker web UI — the
agent drives it, the user watches (and can take over).

Prior art: `tempo/voxl` (desktop streaming server — the webUI needs a
matching client), `agent0ai/tuxee` (dockerized desktop, candidate to run
inside the same compose project as klanker).

## Acceptance

A container spawned by klanker exposes a streamed desktop; the web UI
renders live frames (screenshot-per-second or better) in a client surface.
The oracle: move a window inside the sandbox via the agent and see it move
in the browser — fails if only a static screenshot or terminal output
appears.

## Notes

- Sandboxing boundary: the streamed desktop is a disposable work surface —
  secrets and the host filesystem stay out; agents-sandbox is the policy
  layer it should sit under.
- Input path (clicks/keys back into the sandbox) is the interactive leg;
  view-only streaming is the honest first landed state.
- Same docker project or same container? Thread suggested same project —
  separate container keeps the base image honest.
