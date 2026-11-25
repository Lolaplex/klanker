# Runbook

Operational procedures for klanker hosts. Paths are generic: `<host>`
is the host root (`AGENTS_HOST_DIR`, default `~/.agents`), `<ws>` is
`<host>/workspaces/<id>`.

## Migrate `~/.agents` → Host/Workspace layout

Legacy installs keep every domain flat under `~/.agents`. The current
contract (see `docs/ARCHITECTURE.md`) is a host root holding infra only
(`keys/`, `secrets/`, `run/`, `cache/`, `logs/`, `clients/`,
`providers/`, `mcp/`, `agents.json`, `users.json`, `host_paths.json`)
plus workspaces at `<host>/workspaces/<id>`.

`python -m agents_workspace migrate` does the move. The planner is
pure; the executor takes a lock, moves entries, and appends one JSON
log per run under `<host>/logs/`.

```bash
# preview the planned moves (no writes)
python -m agents_workspace migrate --dry-run

# apply into workspace "default" (prompts unless --yes)
python -m agents_workspace migrate --yes --workspace default

# reverse a run using its log file
python -m agents_workspace migrate --rollback <host>/logs/<log>.json
```

What lands where:

- Legacy domain dirs (`memory`, `skills`, `rules`, `traces`,
  `schedules`, `personas`, `relay`, `routine-runs`, `modules`,
  `content`, `work`, `browser`) → `<ws>/<domain>`.
- Legacy alias dirs merge: `harness-content` → `<ws>/content`,
  `repl` → `<host>/clients`, `voice_inbox` → `<host>/run`.
- Host files stay host-level: `agents.json`, `host_paths.json`,
  `users.json`, `identity.json`, `mcp.json`, `voice.json`,
  `known-dids.jsonl`, `approval-allowlist.json`, `AGENTS.md`,
  `CLAUDE.md`, plus `keys/`, `secrets/`, `providers/`, `mcp/`,
  `clients/`, `browser-*`/`chromium*` profiles.
- Regenerable host files move under their infra dir
  (`mcp-tools-cache.json` → `<host>/cache/`).

After migrating, select the workspace with `AGENTS_WORKSPACE=<id>` or
`klanker --workspace <id>`; `agents-workspace info` prints the resolved
domain paths.

## Fold file domains into `store.db`

Once a workspace runs on the op-log line (see `docs/ARCHITECTURE.md`),
its personas/config/memory can move off files:

```bash
klanker migrate --to-store --workspace <id>
# keep originals out of the live tree afterwards:
klanker migrate --to-store --workspace <id> --archive
```

- Imports `personas/<id>/persona.json` → `persona:<id>`,
  `config.json` scalars → `cfg:<key>`, `memory/**` → `mem:<slug>`
  datoms (idempotent; `origin_actor="import@<host>:store"`).
- The store copy is scrubbed: secret-named keys, credential-shaped
  values and embedded credentials are redacted; only env-indirection
  names (`"OPENAI_API_KEY"`) may be recorded.
- Source files keep any raw tokens — `--archive` moves them unchanged
  to `<ws>/archive/pre-store/`; rotate or delete credentials found
  there.
- Sources stay in place by default because the runtime still reads
  them; `--archive` only after verifying the projections serve the
  data.
