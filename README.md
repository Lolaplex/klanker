# Klanker 🤖

**The Adaptive Agent Distribution on the Lolaplex Suite.**

Klanker ist eine schlanke, adaptive Agenten-Distribution auf dem deterministischen Motor von `agents-harness`. Formt sich nach Host:
- Vom autarken Server-Worker (`klanker cron`),
- über den direkten Terminal-Begleiter (`klanker chat`),
- bis zum vollwertigen VPS-Assistenten via Telegram & HTTP (`klanker serve`).

## Quickstart

```bash
# Clone & install (core stack: harness, relay, memory, traces, docs, terminal)
pip install -e .

# Optional tool extras (only install when needed)
pip install -e ".[calendar]"   # CalDAV Kalender (CLI + MCP)
pip install -e ".[browser]"    # CDP Browser Automation
pip install -e ".[keys]"       # Ed25519 Agent Keys
pip install -e ".[tools]"      # Alle optionalen Tools (browser, keys, calendar)
pip install -e ".[suite]"      # Volle Lolaplex Suite

# 1. Umgebung & Fühler prüfen
klanker sense

# 2. Dynamischen System-Prompt einsehen
klanker prompt

# 3. Interaktiver Chat (REPL)
klanker

# 4. Direkter Turn im Terminal
klanker "Wer bist du?"

# 5. Relay starten (HTTP & Telegram)
klanker serve

# 6. Geplante Koru-Harness-Flows ausführen
klanker cron
```


## Die Architektur

1. **Das Brain (`agents-harness`)** — Motor, LLM-Streaming, Cordis-Kernel, Koru-Schedules, lokales Gedächtnis (`agents-memory`), JSONL-Observability & Chat-Rekonstruktion (`agents-traces`) und lokales Markdown-RAG (`agents-docs`).
2. **Die I/O-Schicht (`agents-relay`)** — Universelle Ein- und Ausgabe via HTTP (`/v1/turn`) und Telegram Long-Poll.
3. **Das Terminal (`agents-terminal`)** — Jailed CLI & Shell-Ausführung für autarke Host-Aktionen (`mcp.terminal`).
4. **Die User-App (`klanker`)** — Verbindet Brain, Relay & Terminal zu einer adaptiven Shell.
5. **Optionale Tools & Fühler (`agents-tools`)** — CalDAV-Kalender (`agents-calendar`), CDP-Browser (`agents-browser`), Ed25519-Keys (`agents-keys`). Werden nur installiert/geladen wenn benötigt. Desktop: `~/.agents/calendar.json`. VPS/`klanker serve`: Coolify env `CALDAV_*`.


