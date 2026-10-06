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

`klanker serve` runs a ticker every 60 seconds. `KLANKER_TICK=0` turns it off. The ticker calls `runner.schedule.tick()` under an exclusive lock file:

`~/.agents/schedules/.tick.lock` (or `$AGENTS_SCHEDULES_DIR/.tick.lock`)

Routines are job files with `"kind": "routine"`. The verb is `python -m klanker routine run <name> --scheduled`, so a current harness tick still runs them. A same-minute duplicate is dropped via `<name>.json.last`. Replies that are exactly `NO_UPDATE` (or start with it) are not sent. Anything else goes out through `agents-relay send`.

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

Older deploys run `python -m runner.schedule tick` as a Coolify scheduled task, which is why only that host had reminders. After this build the ticker is in `klanker serve`, so every install gets it.

1. Preferred: delete the Coolify scheduled task. One ticker is enough.
2. If you keep it during rollout, routines will not double-send in the same minute. Fixed-text reminders can still double-fire until agents-harness flocks the same `.tick.lock` and stores a last-run minute. Remove the external task unless that harness build is deployed.

## Approvals

With Telegram actually polling, serve sets (without overriding values you already exported):

```bash
AGENTS_APPROVAL_CMD='agents-relay approve --user {user} --timeout 300'
AGENTS_APPROVAL_MODE=ask
```

The harness substitutes `{user}`. Mutating tools wait for Approve / Deny. A denial is final.

Telegram refuses to start when `TELEGRAM_BOT_TOKEN` is set and `TELEGRAM_ALLOWED_CHAT_IDS` is empty. Opt in to an open bot with `KLANKER_TELEGRAM_OPEN=1` (the relay allowlist still applies once that side enforces it).

## MCP servers and skills

External MCP servers use Claude/Cursor-shaped `~/.agents/mcp.json` (override `AGENTS_MCP_CONFIG`). An example is [`examples/mcp.json`](examples/mcp.json). `klanker sense` lists each server and a lightweight health check (command on `PATH`, or the URL accepts a connection).

The harness reads `~/.agents/skills/*/SKILL.md` (`AGENTS_SKILLS_DIR`). In the container, `HOME=/data`, and `entrypoint.sh` creates `/data/.agents/skills` on the data volume.

## Docker

The image installs `agents-browser` (CDP client: `mcp` + `websockets`). It does not install Chromium. Set `AGENTS_BROWSER_BIN` or install a browser on the host if you use it. `agents-browser` has no `--help-json` yet; `search`, `read`, `snapshot`, `open`, and `screenshot` are hand-written manifests.

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
