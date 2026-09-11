# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Forward `agents-terminal` as core suite module and preserve container environment variables across `su` in `entrypoint.sh`.
- Auto-configure git authentication and `/data/.git-credentials` from `GITHUB_TOKEN` / `GH_TOKEN` on startup.
- Telegram reminders: `mcp.schedule.add` overlay writes a one-shot verb that calls `agents-relay send` instead of an LLM turn. Host must tick `python -m runner.schedule tick`.

### Changed
- System prompt treats the clock as the calendar (weekday + local date) and drops the slimemold greeting.
- System prompt instructs autonomous multi-step tool execution without early turn stops on partial outputs.

## [0.0.1] - 2026-09-05

### Added
- Initial setup and alignment with Autonomous GitHub Standard.
- Universal, adaptive AI agent shell on the Lolaplex suite.