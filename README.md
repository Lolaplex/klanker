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
| `klanker sense [--json]` | Probe host capabilities, installed suite packages, and environment |
| `klanker prompt` | Inspect dynamic system prompt generated for current host |
| `klanker serve [--no-telegram]` | Start HTTP (`/v1/turn`) and Telegram long-poll gateway |
| `klanker cron [--flow <name>]` | Run scheduled care flows via harness executor |
| `klanker remind <user> <time> <msg>` | Schedule a one-shot outbound notification |

---

## Tests

```bash
pytest
```

---

## License

MIT. See [LICENSE](LICENSE).
