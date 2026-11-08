# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `compose.nas.yaml` + `scripts/nas-{deploy,sync}.ps1`, `publish-registry.ps1`, `nas-pull-latest.sh`: SigmaNAS registry deploy flow (build → save → scp → NAS-side load/push → `pull-latest.sh` recreate). Container listens on 8000, host maps 8787 — the port klanker-desktop discovery probes first.
- `scripts/nas-seed.py`: one-time NAS seed — inherits `.agents` (memory/docs/rules/skills/traces/identity, missing files only) from the assistant project, writes a filtered `.env` (keeps `TELEGRAM_*` — klanker takes over the bot on cutover, replacing the assistant), and ingests `assistant.db` `messages` as `origin:"ingested"` agents-traces `message` events into daily JSONL.

### Fixed
- Dockerfile ran `useradd` twice; the second invocation failed the build.
- `compose.nas.yaml` starts the container as root (`user: "0"`) so `entrypoint.sh` can chown the bind-mounted `/data` before dropping to the `klanker` user — otherwise mkdir fails and the container restart-loops.

## [0.2.2] - 2026-11-08

### Added
- `--workspace PATH` on `klanker` (REPL), `klanker chat`, and `klanker prompt`. It resolves the path, requires an existing directory (exit 2 otherwise), and sets `AGENTS_WORKSPACE_DIR` for this process and the spawned `runner.loop`.
- System prompt: file edits use `mcp.terminal.edit` for existing files and `mcp.terminal.write` for new ones, never `mcp.terminal.run`. A git workspace adds a coding block with the repo path, the root `AGENTS.md`, the read → edit → test flow, and no `git push`.
- Root `AGENTS.md` for coding agents: role, stack, commands, and the layering rule (no harness internals, suite via CLIs).
- `klanker routine say "<sentence>"` creates a routine from one sentence plus `--at` (`+10m`) or `--cron`. `pause` and `resume` keep that job and stop it from firing; `list` shows `paused`.
- Finished routine runs (including `NO_UPDATE` and failures) are recorded under `routine-runs` (`index.jsonl` and one markdown file per run) so a later turn can find scheduled output that was never added to memory.
- `klanker evidence --from YYYY-MM-DD --to YYYY-MM-DD` lists routine-run and workspace files for every day in the range. Memory and traces stay separate tool checks.
- System prompt rules: name each source checked and keep a miss distinct from non-existence; cover every day of a requested range; do read-only investigation without asking; retrieve truncated text before summarizing; claim a side effect only after a successful tool call in that turn.
- Routine-run files are replaced atomically. Retention keeps the newest 2000 runs from the last 90 days (`AGENTS_ROUTINE_RUNS_KEEP_COUNT`, `AGENTS_ROUTINE_RUNS_KEEP_DAYS`).
- `klanker.turn` registers `agents-traces` `read_content` as the harness content backend when traces is installed, and registers the evidence side-effect check as the harness final check. A memory save counts only with `agents_memory.write_receipt.v1`.
- Generated tool manifests honor declared `side_effects`. Read-only terminal verbs (`list`, `read`, `grep`, `stat`) stay non-mutating when the package says so.

### Changed
- The system prompt sends clipped trace text to `read_content` and workspace reads to `mcp.terminal.list|read|grep|stat` instead of a shell or a permission ask.
- The evidence policy names `mcp.terminal.edit` and `mcp.terminal.write` beside the read-only verbs. Mutating file edits need an approval only when the host sets `AGENTS_APPROVAL_MODE` to `ask` or `strict`.

### Fixed
- On Windows, `klanker serve` starts its help-json probes without opening a console window.
- README no longer lists `agents-docs` as an integrated package. It is not a dependency.
- `klanker.turn` refuses a `--system` that is not a readable file. `runner.loop` would otherwise keep the path string as the system prompt.
- The running-daemon warning about `AGENTS_WORKSPACE_DIR` fires only when `--workspace` was passed, not when the variable happens to be exported.
- The `repl` extra depends on `agents-relay>=0.1.1` instead of a git URL. A direct reference cannot be resolved from an index and does not belong in published metadata.

## [0.2.1] - 2026-10-21

### Removed
- Removed deprecated `suite` optional extra and all references to suite / monorepo. Use individual feelers or `klanker[all]`.

## [0.2.0] - 2026-10-21

### Added
- `agents-sync>=0.1.0` integrated as fixed core dependency and autonomous sensing feeler.
- Autonomous self-equipping and direct execution directives in dynamic system prompt (`prompt.py`). Klanker immediately installs missing packages via `mcp.terminal` using `{caps.python_executable} -m pip install <pkg>` instead of passively instructing users to run pip commands.
- `python_executable` field recorded in `HostCapabilities` and dynamically probed via `probe_host()`.
- Dynamic capability re-probing (`self.caps = probe_host()`) on each conversational turn in `Nucleus.run_turn()`.

### Changed
- `agents-docs` transitioned from core dependencies to optional extras (`klanker[docs]`), keeping the default installation lightweight.
- Docker build configuration sets default `SUITE_REF=dev` on dev branch.
- `klanker serve` no longer sets `AGENTS_APPROVAL_MODE=ask` or `AGENTS_APPROVAL_CMD`. Unset mode stays ungated. Opt in with `AGENTS_APPROVAL_MODE=ask` or `strict`; serve then fills the default approve command when `AGENTS_APPROVAL_CMD` is unset.
- `klanker serve` sets `LOOP_CMD` using `sys.executable` to prevent Python interpreter mismatches.

## [0.1.0] - 2026-10-06

### Added
- Hard rules from agents-memory appear in the harness system prefix (`<memory_rules>`); the Klanker prompt notes that block. Cordis memory tools are unchanged.
- In-process schedule ticker in `klanker serve` (60s, `KLANKER_TICK=0` disables) with `.tick.lock`, plus `klanker routine add|list|remove|run`. Routines run a full turn in `routine:<name>` and drop `NO_UPDATE` replies.
- `mcp.schedule.add` prompt mode (routine) beside fixed-text reminders.
- Startup overlay generation from suite `--help-json`, with read/mutate classification. Hand-written manifests win. `agents-browser` is installed in the image; keys stay read-only unless `KLANKER_KEYS_WRITE=1`.
- `klanker sense` reports `~/.agents/mcp.json` servers and `~/.agents/skills`. Example config at `examples/mcp.json`.
- Telegram serve defaults `AGENTS_APPROVAL_MODE=ask` and `AGENTS_APPROVAL_CMD` for `agents-relay approve`.
- Auto-derive Git user identity and email via `git_identity` module from GitHub API or environment, setting up `/data/.gitconfig` and credentials with secure file permissions.
- Configurable Dockerfile build arguments (`HARNESS_REF`, `RELAY_REF`, `MEMORY_REF`, `TRACES_REF`, `DOCS_REF`, `TERMINAL_REF`, `CALENDAR_REF`, `BROWSER_REF`) defaulting to `dev` to allow building from custom feature branches or tags.
- `klanker audit` CLI subcommand to run integrity verification and replay analysis via `agents-traces`.
- `--seal` CLI flag on `klanker chat` and REPL to forward cryptographic turn sealing to `runner.loop`.
- System prompt section on Observability, Integrity & Sealing guiding Klanker to use `mcp.traces.audit` and `mcp.traces.seal`.
- CLI (and MCP, when present) check PyPI at most once per day for a newer release and print one stderr / tool-response line (`uv tool upgrade …`). Disabled with `AGENTS_NO_UPDATE_CHECK=1` or when `CI` is set; offline/timeout stays silent.

### Changed
- Requires `agents-docs>=0.45.0`, `agents-terminal>=0.0.5`, and `agents-browser>=0.45.0` (optional browser extra).
- System prompt uses the package version, describes approvals and untrusted tool data, and no longer says to execute mutating tools directly.
- `mcp.schedule.add` sets `approval_ask: false`. The ticker runs each `tick()` on a worker thread. One-shot routines delete their `.json.last` and `.lock` sidecars.
- Routines and reminders store channel and user. Relay delivers Telegram chat ids; other channels, including HTTP `anonymous`, stay local.
- Ask-mode approvals apply when an approver is configured, not only while Telegram is polling.
- Telegram polling refuses to start without `TELEGRAM_ALLOWED_CHAT_IDS` unless `KLANKER_TELEGRAM_OPEN=1`.
- Docker socket access uses the socket group instead of mode `666`. Skills directory is created on the data volume.
- Ground system prompt in Local Agent Memory terminology, document file_id parameters for mcp.memory.read, and explicitly forbid tool-failure content hallucination.
- Requires `agents-harness[mcp]>=0.1.0`, `agents-relay>=0.1.0`, `agents-memory>=1.2.0`, `agents-traces>=0.1.0`, `agents-calendar>=0.1.0`, `agents-docs>=0.45.0`, and `agents-terminal>=0.0.5`. The Docker image builds from `main` by default instead of `dev`; `SUITE_REF` and the per-package `*_REF` build args override it.

### Removed
- Unused `morph.py` schedule synthesizer.
- Stale `klanker[memory]` extra from the system prompt (memory is a core dependency).

### Fixed
- `save_system_prompt` respects `AGENTS_HOME` (same as the rest of the suite) instead of the unused `AGENTS_DIR`.
- Set `AGENTS_MODULES_DIR` so harness loads overlay modules (including `mcp.schedule.add`). Skip Klanker's `.tick.lock` when harness locks `tick.lock` inside `tick()`.
- `KLANKER_TELEGRAM_OPEN=1` sets `AGENTS_RELAY_ALLOW_ANYONE=1`. Routine delivery passes `allow_anyone`.
- `klanker routine add` defaults the timezone from the harness / `AGENTS_TIMEZONE` / `TZ`. Routine turn timeout sits under the job timeout.
- Routine default timeout covers the harness approval wait plus 330 seconds (645 with the default approver) instead of 300, which was shorter than the 315-second approval wait. `mcp.schedule.add` routines without a timeout get the same default.
- `klanker sense` expands `${VAR}` in MCP config before probing. Image installs `agents-harness[mcp]` and accepts `CACHE_BUST` / `SUITE_REF`.
- Clean up plaintext token `insteadOf` configs from `.gitconfig` in favor of secure `credential.helper store` with 0600 file permissions.
- Forward `SIGTERM` and OS signals cleanly in `entrypoint.sh` using `setpriv` instead of `su`, preventing dual-polling 409 conflict errors on container restart.

## [0.0.2] - 2026-09-27

### Added
- Cordis modules `mcp.calendar.list|add|update|delete|calendars` (calendar is core, not an extra).
- Forward `agents-terminal` as core suite module and preserve container environment variables across `su` in `entrypoint.sh`.
- Auto-configure git authentication and `/data/.git-credentials` from `GITHUB_TOKEN` / `GH_TOKEN` on startup.
- Telegram reminders: `mcp.schedule.add` overlay writes a one-shot verb that calls `agents-relay send` instead of an LLM turn. Host must tick `python -m runner.schedule tick`.
- Explicit workspace filesystem grounding (`/data/workspace` or `~/.agents/workspace`) and inbox directory initialization in `entrypoint.sh`.

### Changed
- CI runs only on pull requests to `main`.
- PR-only CI added (ubuntu-latest `pytest` on pull requests to `main`/`dev`). Feature-merge notifications on squash into `dev`. No publish pipeline.
- `agents-calendar` is a core dependency (same as terminal/memory). Extra `[calendar]` stays as an install alias. VPS/container uses Coolify env `CALDAV_*`.
- System prompt treats the clock as the calendar (weekday + local date) and drops the slimemold greeting.
- System prompt instructs autonomous multi-step tool execution without early turn stops on partial outputs.
- Telegram replies: human prose (no CLI status / ASCII boxes / checkmark glyphs). `mcp.memory.add` is documented as `fact`, not `text`.
- Product copy drops the slimemold analogy. Klanker is an adaptive agent distribution on the suite.
- System prompt instructs proactive memory persistence for scheduled briefings and recommendations via `mcp.memory.add`.

## [0.0.1] - 2026-09-05

### Added
- Initial setup and alignment with Autonomous GitHub Standard.
- Universal, adaptive AI agent shell and terminal companion.

[Unreleased]: https://github.com/Lolaplex/klanker/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Lolaplex/klanker/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Lolaplex/klanker/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Lolaplex/klanker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lolaplex/klanker/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/Lolaplex/klanker/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Lolaplex/klanker/releases/tag/v0.0.1
