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
klanker serve                       # HTTP + Telegram gateway
klanker cron                        # scheduled care flows
```

`--workspace <id>` selects the data workspace (`AGENTS_WORKSPACE=<id>`; unknown id exits 2). `--workdir <dir>` sets the session cwd (`AGENTS_WORKDIR`) plus `AGENTS_WORKSPACE_LOCK=1` for this process and the spawned `runner.loop`. A directory passed to `--workspace` still maps to workdir for one release with a deprecation warning.

## Layering

- `klanker` imports no harness internals. It talks to the suite through CLIs: `runner.loop`, `agents_relay`, `agents_terminal`, `agents_memory`, `agents_traces`.
- The harness owns the loop, tools, and approvals. Klanker owns the prompt, the CLI surface, and the overlay.
- File edits go through `mcp.terminal.edit` (existing files) and `mcp.terminal.write` (new files), never `mcp.terminal.run`.

## Files

- `src/klanker/prompt.py` — system prompt and the git coding block.
- `src/klanker/evidence.py` — evidence policy lines and workspace paths.
- `src/klanker/nucleus.py` — spawns `klanker.turn` (argv shims, then `runner.loop`).
- `src/klanker/__main__.py` — CLI parser and dispatch.
