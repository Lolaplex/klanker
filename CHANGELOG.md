# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- In-process schedule ticker in `klanker serve` (60s, `KLANKER_TICK=0` disables) with `.tick.lock`, plus `klanker routine add|list|remove|run`. Routines run a full turn in `routine:<name>` and drop `NO_UPDATE` replies.
- `mcp.schedule.add` prompt mode (routine) beside fixed-text reminders.
- Startup overlay generation from suite `--help-json`, with read/mutate classification. Hand-written manifests win. `agents-browser` is installed in the image; keys stay read-only unless `KLANKER_KEYS_WRITE=1`.
- `klanker sense` reports `~/.agents/mcp.json` servers and `~/.agents/skills`. Example config at `examples/mcp.json`.
- Telegram serve defaults `AGENTS_APPROVAL_MODE=ask` and `AGENTS_APPROVAL_CMD` for `agents-relay approve`.
- Auto-derive Git user identity and email via `git_identity` module from GitHub API or environment, setting up `/data/.gitconfig` and credentials with secure file permissions.
- Configurable Dockerfile build arguments (`HARNESS_REF`, `RELAY_REF`, `MEMORY_REF`, `TRACES_REF`, `DOCS_REF`, `TERMINAL_REF`, `CALENDAR_REF`) defaulting to `dev` to allow building from custom feature branches or tags.
- `klanker audit` CLI subcommand to run integrity verification and replay analysis via `agents-traces`.
- `--seal` CLI flag on `klanker chat` and REPL to forward cryptographic turn sealing to `runner.loop`.
- System prompt section on Observability, Integrity & Sealing guiding Klanker to use `mcp.traces.audit` and `mcp.traces.seal`.

### Changed
- System prompt uses the package version, describes approvals and untrusted tool data, and no longer says to execute mutating tools directly.
- `mcp.schedule.add` sets `approval_ask: false`. The ticker runs each `tick()` on a worker thread. One-shot routines delete their `.json.last` and `.lock` sidecars.
- Routines and reminders store channel and user. Relay delivers Telegram chat ids; other channels, including HTTP `anonymous`, stay local.
- Ask-mode approvals apply when an approver is configured, not only while Telegram is polling.
- Telegram polling refuses to start without `TELEGRAM_ALLOWED_CHAT_IDS` unless `KLANKER_TELEGRAM_OPEN=1`.
- Docker socket access uses the socket group instead of mode `666`. Skills directory is created on the data volume.
- Ground system prompt in Local Agent Memory terminology, document file_id parameters for mcp.memory.read, and explicitly forbid tool-failure content hallucination.

### Removed
- Unused `morph.py` schedule synthesizer.
- Stale `klanker[memory]` extra from the system prompt (memory is a core dependency).

### Fixed
- Set `AGENTS_MODULES_DIR` so harness loads overlay modules (including `mcp.schedule.add`). Skip Klanker's `.tick.lock` when harness locks `tick.lock` inside `tick()`.
- `KLANKER_TELEGRAM_OPEN=1` sets `AGENTS_RELAY_ALLOW_ANYONE=1`. Routine delivery passes `allow_anyone`.
- `klanker routine add` defaults the timezone from the harness / `AGENTS_TIMEZONE` / `TZ`. Routine turn timeout sits under the job timeout.
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
- Universal, adaptive AI agent shell on the Lolaplex suite.

[Unreleased]: https://github.com/Lolaplex/klanker/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/Lolaplex/klanker/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Lolaplex/klanker/releases/tag/v0.0.1
