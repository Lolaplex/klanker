<h1 align="center">klanker</h1>

<p align="center">
  <a href="https://github.com/Lolaplex/klanker/releases"><img src="https://img.shields.io/badge/version-0.1.0-blue.svg?style=flat-square" alt="Version 0.1.0"></a>
  <a href="https://python.org"><img src="https://img.shields.io/badge/Python-3.10+-3776AB.svg?style=flat-square&logo=python&logoColor=white" alt="Python 3.10+"></a>
  <a href="https://pypi.org/project/klanker/"><img src="https://img.shields.io/pypi/v/klanker.svg?style=flat-square" alt="PyPI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <strong>Adaptive agent distribution on the Lolaplex stack.</strong><br>
  Terminal companion, background care runner, and self-hosted assistant on agents-harness.
</p>

---

## Quickstart

```bash
pip install klanker
```

Optional suite extras:

```bash
pip install "klanker[browser]"   # CDP browser automation
pip install "klanker[keys]"      # Ed25519 agent key minting and DID resolution
pip install "klanker[suite]"     # Complete Lolaplex suite
```

> [!TIP]
> **🤖 Agent-Driven Setup:**
> Give your coding agent **this repo** (clone or URL), then tell it to **"install klanker, sense host capabilities, and run your personal assistant."**

---

## Architecture

| Layer | Responsibility | Stack / Package |
| :--- | :--- | :--- |
| **Brain** | Deterministic loop, LLM streaming, Cordis kernel, Koru schedules | `agents-harness` |
| **Memory & Docs** | Persistent local markdown memory, typed facts, header-aware BM25 doc search | `agents-memory`, `agents-docs` |
| **Observability** | Append-only JSONL event logging & turn reconstruction | `agents-traces` |
| **I/O Gateway** | Universal inbound/outbound HTTP (`/v1/turn`, `/v1/inject`) and Telegram long-poll | `agents-relay` |
| **Tools & Feelers** | Jailed execution, CalDAV calendar, CDP browser, agent DID keys | `agents-terminal`, `agents-calendar`, `agents-browser`, `agents-keys` |

- **Brain (`agents-harness`)**: Deterministic execution loop, LLM completions, Cordis job catalog, and Koru scheduled flows.
- **Memory & Docs (`agents-memory`, `agents-docs`)**: Persistent local markdown memory and header-aware documentation search.
- **Tracing (`agents-traces`)**: Zero-bloat JSONL observability and turn reconstruction.
- **Relay (`agents-relay`)**: Stdlib HTTP and Telegram gateway for turns, alerts, and notifications.
- **Calendar & Tools (`agents-calendar`, `agents-terminal`, optional `agents-browser`, `agents-keys`)**: Pre-wired capabilities for schedules, safe commands, and web interaction.

---

## Capabilities & Roadmap

### Core Capabilities (Implemented)

- [x] **Adaptive Host Sensing (`klanker sense`)**: Automatic host inspection and runtime discovery.
- [x] **Dynamic System Prompt (`klanker prompt`)**: Context-aware prompt generation grounded in host capabilities and time.
- [x] **Multi-Surface Shell**: Interactive REPL, one-shot CLI turns, background care worker (`cron`), and gateway server (`serve`).
- [x] **Full Suite Integration**: Core bindings for `agents-harness`, `agents-relay`, `agents-memory`, `agents-docs`, `agents-traces`, `agents-terminal`, and `agents-calendar`.
- [x] **Telegram Reminders**: Dynamic reminder scheduling routed to `agents-relay send`.

### Planned (Roadmap)

- [ ] **Graphic Architecture Map**: Visual system diagram asset hosted on GitHub.
- [ ] **Autonomous Mesh Coordination**: Distributed multi-instance task delegation via A2A.
- [ ] **Desktop Companion GUI**: Native workbench integration with `klanker-desktop`.

---

## Commands

| Command | Description |
| :--- | :--- |
| `klanker` | Start interactive multi-turn REPL chat |
| `klanker "message"` | Run a single turn directly in terminal |
| `klanker sense [--json]` | Probe host capabilities, suite packages, MCP servers, and skills |
| `klanker prompt` | Inspect dynamic system prompt generated for current host |
| `klanker serve [--no-telegram]` | Start HTTP (`/v1/turn`), Telegram long-poll, and the schedule ticker |
| `klanker cron [--flow <name>]` | Run scheduled care flows via harness executor |
| `klanker remind add --user <user> --channel <channel> --at <when> --text <msg>` | Fixed-text reminder on that channel |
| `klanker routine add\|list\|remove\|run` | LLM routines (`prompt` + `at` or `cron`) |

---

## Schedules

`klanker serve` runs a ticker every 60 seconds. `KLANKER_TICK=0` turns it off. The ticker calls `runner.schedule.tick()`.

A harness that exposes `register_routine_handler` locks `<schedules>/tick.lock` inside `tick()`. Klanker does not lock that file. A second flock on it in the same process deadlocks. On older harness builds (no handler), the ticker takes a non-blocking lock on a different file, `~/.agents/schedules/.tick.lock` (or `$AGENTS_SCHEDULES_DIR/.tick.lock`), so two Klanker processes do not overlap. The scheduler starts each `tick()` on its own thread so a long job cannot push the next cron slot past the grace window.

Routines are job files with `"kind": "routine"`. The verb is `python -m klanker routine run <name> --scheduled`, so a verb-only harness tick still runs them. Each job stores the originating `channel` and `user` (the turn channel, or `KLANKER_CHANNEL`, or `local`). A same-minute duplicate is dropped via `<name>.json.last`. Replies that are exactly `NO_UPDATE` (or start with it) are not sent. Telegram chat ids go out through `agents-relay send`. Any other channel is printed locally, including an HTTP user such as `anonymous`. `klanker routine add` without `--timezone` stores `runner.schedule.configured_timezone()` (`AGENTS_TIMEZONE`, then `TZ`, then `~/.agents/config.json`, else UTC). The routine turn subprocess timeout is 30 seconds under the job `timeout_sec`. The default `timeout_sec` is the harness approval wait (`AGENTS_APPROVAL_TIMEOUT`, else the approver `--timeout` plus 15 seconds) plus 330 seconds, 645 with the default approver, so a turn waiting on an approval is not killed first. Routines added through `mcp.schedule.add` without a timeout get the same default. When the installed harness accepts `--detached-session`, routine turns pass it.

`klanker serve` sets `AGENTS_MODULES_DIR` to the overlay directory (`~/.agents/modules`, or `/data/.agents/modules` in the image) when it is unset. Harness ignores overlay modules, including `mcp.schedule.add`, unless that variable is set. A custom `LOOP_CMD` skips Klanker's system prompt and `klanker.turn` shims; serve logs a warning when it is set.

```bash
klanker remind add --user 123456 --channel telegram --at +10m --text "stand up"
klanker remind add --user 123456 --channel telegram --cron "0 8 * * 1" --prompt "Weekly review" --timezone UTC
klanker routine add --name morning --user 123456 --channel telegram --cron "0 8 * * *" --timezone UTC --prompt "Anything new?"
klanker routine list
klanker routine run morning
klanker routine remove morning
```

The schedule tool `mcp.schedule.add` accepts `text` (fixed reminder) or `prompt` (routine). Passing `prompt` through the model tool depends on the harness forwarding that argument. `klanker.turn` appends `--prompt` when the current harness special-case drops it.

### External schedulers (cron, systemd timer, PaaS scheduled task)

`klanker serve` already ticks. Remove external `python -m runner.schedule tick` tasks.

If you keep one, it must run as the service user. A root shell (`docker exec` without a user) creates root-owned lock and state files. Approvals are opt-in in the service environment; a shell that does not inherit `AGENTS_APPROVAL_MODE` stays ungated. Example: `setpriv --reuid=<service user> --regid=<service group> --init-groups python -m runner.schedule tick`.

Do not flock `tick.lock` around that command. The harness locks it inside `tick()`, and a second flock in the same process deadlocks. `.tick.lock` is only the outer lock for harness builds that have no `register_routine_handler`.

## Approvals

`klanker serve` does not enable the approval gate. When `AGENTS_APPROVAL_MODE` is unset, mutating tools run with no Telegram Approve/Deny prompt.

Opt in by setting the mode to `ask` or `strict`. If `AGENTS_APPROVAL_CMD` is unset, serve fills the default `agents-relay approve` command. An exported command is left as-is.

```bash
AGENTS_APPROVAL_MODE=ask
AGENTS_APPROVAL_CMD='agents-relay approve --user {user} --timeout 300'
```

The harness substitutes `{user}`. With `ask` or `strict`, mutating tools wait for Approve / Deny. A denial is final.

Telegram refuses to start when `TELEGRAM_BOT_TOKEN` is set and `TELEGRAM_ALLOWED_CHAT_IDS` is empty. Opt in to an open bot with `KLANKER_TELEGRAM_OPEN=1`. That also sets `AGENTS_RELAY_ALLOW_ANYONE=1` when it is unset, which is what relay requires before it will poll with an empty allowlist. Routine delivery passes `allow_anyone` through to `send_to_user`.

## MCP servers and skills

External MCP servers use Claude/Cursor-shaped `~/.agents/mcp.json` (override `AGENTS_MCP_CONFIG`). An example is [`examples/mcp.json`](examples/mcp.json). `klanker sense` expands `${VAR}` in `url`, `command`, `args`, and `env` the same way the harness does, then lists each server and a lightweight health check (command on `PATH`, or the URL accepts a connection).

The harness reads `~/.agents/skills/*/SKILL.md` (`AGENTS_SKILLS_DIR`). In the container, `HOME=/data`, and `entrypoint.sh` creates `/data/.agents/skills` on the data volume.

## Docker

The image installs `agents-harness[mcp]` (stdio and HTTP MCP client) and `agents-browser` (CDP client: `mcp` + `websockets`). It does not install Chromium. Set `AGENTS_BROWSER_BIN` or install a browser on the host if you use it. `agents-browser` has no `--help-json` yet; `search`, `read`, `snapshot`, `open`, and `screenshot` are hand-written manifests.

Git installs are cached by the image layer. Rebuild with `--no-cache`, or change `CACHE_BUST` / `SUITE_REF`, or the harness and relay commits stay stale. After the image is running, `pip freeze | grep agents-` should list git commits. `AGENTS_VISION=1` makes image attachments vision parts (see `.env.example`).

Dependency floors: `agents-harness[mcp]>=0.1.0`, `agents-relay>=0.1.0`, `agents-memory>=1.2.0`, `agents-traces>=0.1.0`, `agents-calendar>=0.1.0`. The image installs the suite from git `main` (the latest releases) by default. Set `SUITE_REF`, or a per-package ref such as `HARNESS_REF`, to build from another branch or tag.

`agents-traces --help-json` is a raw argparse dump and does not list subcommands. `stats`, `inspect`, `sessions`, `verify`, and `cleanup` are hand-written. `audit` and `seal` stay the harness modules. Anything else is `mcp.traces.argv` after generation.

`agents-keys` is not in the image. If you install it, only read verbs (`did`, `resolve`, `ssh-pubkey`) are exposed unless `KLANKER_KEYS_WRITE=1`. `vand` is exposed only when it is installed.

The entrypoint does not `chmod 666` the Docker socket. As root it adds `klanker` to the socket's group (`setpriv --init-groups` keeps that group). If that still fails, set the service `group_add` to the host socket gid (`stat -c %g /var/run/docker.sock`).

---

## Tests

```bash
pytest
```

---

## License

MIT. See [LICENSE](LICENSE).
