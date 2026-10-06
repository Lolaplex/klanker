# klanker

<p align="center">
  <a href="https://github.com/Lolaplex/klanker/releases"><img src="https://img.shields.io/badge/version-0.0.2-blue.svg?style=flat-square" alt="Version 0.0.2"></a>
  <a href="https://python.org"><img src="https://img.shields.io/badge/Python-3.10+-3776AB.svg?style=flat-square&logo=python&logoColor=white" alt="Python 3.10+"></a>
  <a href="https://pypi.org/project/klanker/"><img src="https://img.shields.io/pypi/v/klanker.svg?style=flat-square" alt="PyPI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <strong>Adaptive agent distribution on the Lolaplex suite.</strong><br>
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
| `klanker remind add --user <chat> --at <when> --text <msg>` | Fixed-text Telegram reminder |
| `klanker routine add\|list\|remove\|run` | LLM routines (`prompt` + `at` or `cron`) |

---

## Schedules

`klanker serve` runs a ticker every 60 seconds. `KLANKER_TICK=0` turns it off. The ticker calls `runner.schedule.tick()`.

A harness that exposes `register_routine_handler` locks `<schedules>/tick.lock` inside `tick()`. Klanker does not lock that file. A second flock on it in the same process deadlocks. On older harness builds (no handler), the ticker takes a non-blocking lock on a different file, `~/.agents/schedules/.tick.lock` (or `$AGENTS_SCHEDULES_DIR/.tick.lock`), so two Klanker processes do not overlap. An external Coolify tick does not share `.tick.lock`.

Routines are job files with `"kind": "routine"`. The verb is `python -m klanker routine run <name> --scheduled`, so a verb-only harness tick still runs them. A same-minute duplicate is dropped via `<name>.json.last`. Replies that are exactly `NO_UPDATE` (or start with it) are not sent. Anything else goes out through `agents-relay send`. `klanker routine add` without `--timezone` stores `runner.schedule.configured_timezone()` (`AGENTS_TIMEZONE`, then `TZ`, then `~/.agents/config.json`, else UTC). The routine turn subprocess timeout is 30 seconds under the job `timeout_sec`.

`klanker serve` sets `AGENTS_MODULES_DIR` to the overlay directory (`~/.agents/modules`, or `/data/.agents/modules` in the image) when it is unset. Harness ignores overlay modules, including `mcp.schedule.add`, unless that variable is set. A custom `LOOP_CMD` skips Klanker's system prompt and `klanker.turn` shims; serve logs a warning when it is set.

```bash
klanker remind add --user 123456 --at +10m --text "stand up"
klanker remind add --user 123456 --cron "0 8 * * 1" --prompt "Weekly review" --timezone Europe/Berlin
klanker routine add --name morning --user 123456 --cron "0 8 * * *" --timezone Europe/Berlin --prompt "Anything new?"
klanker routine list
klanker routine run morning
klanker routine remove morning
```

The schedule tool `mcp.schedule.add` accepts `text` (fixed reminder) or `prompt` (routine). Passing `prompt` through the model tool depends on the harness forwarding that argument. `klanker.turn` appends `--prompt` when the current harness special-case drops it.

### Coolify migration

Older deploys run `python -m runner.schedule tick` as a Coolify scheduled task, which is why only that host had reminders. After this build the ticker is in `klanker serve`.

1. Set `TELEGRAM_ALLOWED_CHAT_IDS` before deploying the relay that refuses an empty allowlist. `KLANKER_TELEGRAM_OPEN=1` also sets `AGENTS_RELAY_ALLOW_ANYONE=1` (relay denies the open bot otherwise). Do not leave the allowlist empty unless that opt-in is intentional.
2. Delete the Coolify task `python -m runner.schedule tick` in the same deploy. Do not point it at `.tick.lock` or `tick.lock`. The new harness locks `tick.lock` inside `tick()`, and Klanker must not flock that file in-process.
3. Rebuild the image with no Docker cache, or bump the `CACHE_BUST` / `SUITE_REF` build args, so the git installs of harness and relay are not a stale layer. `agents-harness` is installed with the `[mcp]` extra. In the container, `pip freeze | grep agents-` should show git commits, not an old cached revision.

## Approvals

With Telegram actually polling, serve sets (without overriding values you already exported):

```bash
AGENTS_APPROVAL_CMD='agents-relay approve --user {user} --timeout 300'
AGENTS_APPROVAL_MODE=ask
```

The harness substitutes `{user}`. Mutating tools wait for Approve / Deny. A denial is final.

Telegram refuses to start when `TELEGRAM_BOT_TOKEN` is set and `TELEGRAM_ALLOWED_CHAT_IDS` is empty. Opt in to an open bot with `KLANKER_TELEGRAM_OPEN=1`. That also sets `AGENTS_RELAY_ALLOW_ANYONE=1` when it is unset, which is what relay requires before it will poll with an empty allowlist. Routine delivery passes `allow_anyone` through to `send_to_user`.

## MCP servers and skills

External MCP servers use Claude/Cursor-shaped `~/.agents/mcp.json` (override `AGENTS_MCP_CONFIG`). An example is [`examples/mcp.json`](examples/mcp.json). `klanker sense` expands `${VAR}` in `url`, `command`, `args`, and `env` the same way the harness does, then lists each server and a lightweight health check (command on `PATH`, or the URL accepts a connection).

The harness reads `~/.agents/skills/*/SKILL.md` (`AGENTS_SKILLS_DIR`). In the container, `HOME=/data`, and `entrypoint.sh` creates `/data/.agents/skills` on the data volume.

## Docker

The image installs `agents-harness[mcp]` (stdio and HTTP MCP client) and `agents-browser` (CDP client: `mcp` + `websockets`). It does not install Chromium. Set `AGENTS_BROWSER_BIN` or install a browser on the host if you use it. `agents-browser` has no `--help-json` yet; `search`, `read`, `snapshot`, `open`, and `screenshot` are hand-written manifests.

Git installs are cached by Docker layer. Coolify will keep an old harness/relay until you rebuild with `--no-cache` or change `CACHE_BUST` / `SUITE_REF`. After deploy, `pip freeze | grep agents-` should list the git commits from that build. `AGENTS_VISION=1` makes image attachments vision parts (see `.env.example`).

`agents-traces --help-json` is a raw argparse dump and does not list subcommands. `stats`, `inspect`, `sessions`, `verify`, and `cleanup` are hand-written. `audit` and `seal` stay the harness modules. Anything else is `mcp.traces.argv` after generation.

`agents-keys` is not in the image. If you install it, only read verbs (`did`, `resolve`, `ssh-pubkey`) are exposed unless `KLANKER_KEYS_WRITE=1`. `vand` is exposed only when it is installed.

The entrypoint does not `chmod 666` the Docker socket. As root it adds `klanker` to the socket's group (`setpriv --init-groups` keeps that group). If that still fails, set Coolify/compose `group_add` to the host socket gid (`stat -c %g /var/run/docker.sock`).

---

## Tests

```bash
pytest
```

---

## License

MIT. See [LICENSE](LICENSE).
