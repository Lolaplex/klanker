# SCENE.md — klanker

Read-many, write-rarely. The felt north star; `challenges/CATALOG.md` is
the living slot board. When a `plans/` walk exists it names the current
walk.

## North star

The adaptive agent shell. One klanker instance = one agent with a brain
(`agents-harness`), a mouth (`agents-relay`), memory (`agents-memory`,
`agents-traces`), and feelers — composable from the suite through CLIs,
never by importing internals. It runs detached on a laptop, a PVS box,
or a VPS and stays the same agent: the surfaces that drive it
(klanker-desktop, board, chat clients) are interchangeable views onto
the daemon, not the agent itself.

## Ideal user

Fabian, running a herd: `klanker serve` on the VPS grinding scheduled
flows, a detached daemon on the desktop mid-turn, a `klanker chat`
one-shot from a terminal. The agent's identity, memory, and capabilities
follow the instance — not the window, not the client, not the machine
it happens to be shelled from today.

## What it says no to

- **Brains elsewhere.** The daemon owns the loop and the workspace.
  Surfaces connect to it; they never embed a second loop. A turn
  happens here or nowhere.
- **Suite internals.** Klanker talks to `runner.loop`, `agents_relay`,
  `agents_memory`, `agents_traces` as CLIs. Needing a private import
  means the contract is missing — fix it upstream, don't reach in.
- **Silent degradation.** A feeler that can't load, a relay that
  doesn't answer, a workspace that won't lock: loud failures with the
  command and the output, never a quieter default.
- **Option menus.** Pick the steelman, defend it in a paragraph, let
  Fabian veto.
- **Ungated claims.** "Fast", "works", "landed" each need the command
  and the output. `unmeasured` is a complete sentence.

## Tending log

- 2026-11-18 — planted alongside the challenges board install. The
  commit-membrane discipline (`hooks/`, `signals/`, `concepts/`, the
  `commit-discipline` CI wall) landed earlier the same week; this adds
  the challenge slot board so gaps here are recorded the same way as
  in klanker-desktop.
