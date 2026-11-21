# klanker

Adaptive agent shell on the Lolaplex suite. Wires `agents-harness` (brain), `agents-relay` (I/O), and optional feelers into one CLI.

## Stack

- Python 3.10+, stdlib first, `argparse`, `subprocess`.
- Optional extras: `repl` (shell/TUI), `browser`, `keys`, `calendar`.
- Tests: `pytest`.

## Commands

```bash
python -m pytest -q                 # tests
klanker sense                       # probe host, feelers, MCP servers, skills
klanker prompt                      # print the dynamic system prompt
klanker chat "…"                    # one harness turn
klanker chat "…" --workdir PATH     # one turn with cwd = PATH
klanker chat "…" --workspace ID     # one turn inside data workspace ID
klanker --workspace ID              # REPL inside data workspace ID
klanker serve                       # HTTP + Telegram gateway (auto-mints RELAY_WEB_TOKEN, prints ?token= URL once)
klanker serve --no-auth             # only way to run the web surface unprotected (or RELAY_NO_AUTH=1)
klanker cron                        # scheduled care flows
```

`--workspace <id>` selects the data workspace (`AGENTS_WORKSPACE=<id>`; unknown id exits 2). `--workdir <dir>` sets the session cwd (`AGENTS_WORKDIR`) plus `AGENTS_WORKDIR_LOCK=1` for this process and the spawned `runner.loop`. A directory passed to `--workspace` still maps to workdir for one release with a deprecation warning.

## Layering

- `klanker` imports no harness internals. It talks to the suite through CLIs: `runner.loop`, `agents_relay`, `agents_terminal`, `agents_memory`, `agents_traces`.
- The harness owns the loop, tools, and approvals. Klanker owns the prompt, the CLI surface, and the overlay.
- File edits go through `mcp.terminal.edit` (existing files) and `mcp.terminal.write` (new files), never `mcp.terminal.run`.

## Files

- `src/klanker/prompt.py` — system prompt and the git coding block.
- `src/klanker/evidence.py` — evidence policy lines and workspace paths.
- `src/klanker/nucleus.py` — spawns `klanker.turn` (argv shims, then `runner.loop`).
- `src/klanker/__main__.py` — CLI parser and dispatch.

## Inherited rules (koru-distill discipline)

- **Ground truth = running code.** `python -m pytest -q`,
  `bash scripts/board.sh` — a claim without a measured command is
  `unmeasured`, and `unmeasured` is a complete sentence.
- **Claim states: blocker / not a blocker / unmeasured.** Re-measure
  anything inherited from another session, doc, or header before
  relying on it. Pin `git rev-parse HEAD` on scans.
- **Find it before you build it.** Search klanker, agents-*, client-*
  first; report an empty search as a result.
- **Refusals are loud.** No fallbacks, no silent skips, no degraded
  path labeled default. A contract mismatch is fixed at the wire,
  never papered over client-side.
- **Never present option menus.** Pick the steelman, defend it in a
  paragraph, let Fabian veto.
- **Evidence classes V/M/C/D** on every challenge entry. `landed`
  requires `evidence/` artifacts — `scripts/board.sh` enforces it.

## Challenge entry discipline

- One self-contained dir per slot under `challenges/`. Copy
  `challenges/_template/`.
- `entry.md` frontmatter is the contract: `name`, `area`, `needs`,
  `accept`, `surface`, `status`, `evidence`, `provenance`.
- `accept:` names the falsifying oracle — a check that can only confirm
  is not a gate. Prefer runnable commands; manual oracles say so.
- Status: `open → claimed → landed` (or `waived` with a named reason).
  `claimed` requires all `needs:` landed or waived.
- Append happens automatically: `bash scripts/board.sh --write`
  regenerates the CATALOG table block; `--check` verifies freshness.

## Before pushing

```bash
bash scripts/board.sh          # challenges ↔ evidence consistency
python -m pytest -q            # test suite
```

`git push` to a public remote is submission surface — explicit approval
of exact content required, every time.

## Commit discipline (installed via `bash hooks/install.sh`)

**Every contributor and agent** must run `bash hooks/install.sh` once per
clone. That sets `core.hooksPath=hooks` so git runs the tracked dispatchers
under `hooks/`. **`core.hooksPath=/dev/null` is not allowed** — it disables
hooks silently (worse than `--no-verify` because it looks configured).

Every authored commit answers three sectioned questions — silence is a
refusal, honest opt-outs are explicit:

- `## World Model` — `Signal: <type> — <note>` per belief that changed,
  or `Signals: acknowledged-none`. Types live in `signals/*.signal`.
- `## Gates` — measured rows (`name: pass/total`) or
  `deferred — <reason>`. "Gates green" is a measured claim, not prose.
- `## Membrane` — durable beliefs live in `concepts/frag-<id>.md`
  (frontmatter `type/id/provenance/ts`, id == stem). Stage one →
  `Action: create|evolve|merge|split|correct|move` + `Concept:`; stage
  none → `Evolution: acknowledged-none`.

Merge commits are exempt. Never `--no-verify`. Server-side leg:
`.github/workflows/commit-discipline.yml` re-runs the same grammar over
every PR commit — local hooks are bypassable, CI is not.

## Roadmap

`docs/ROADMAP.md` holds the current direction (thin Tauri shell over
web/, card-verification rule, wave map). Read it before starting
board work — board status does not equal code truth.
