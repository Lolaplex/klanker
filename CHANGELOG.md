# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Auto-derive Git user identity and email via `git_identity` module from GitHub API or environment, setting up `/data/.gitconfig` and credentials with secure file permissions.
- `klanker audit` CLI subcommand to run integrity verification and replay analysis via `agents-traces`.
- `--seal` CLI flag on `klanker chat` and REPL to forward cryptographic turn sealing to `runner.loop`.
- System prompt section on Observability, Integrity & Sealing guiding Klanker to use `mcp.traces.audit` and `mcp.traces.seal`.

### Fixed
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
