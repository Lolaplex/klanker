# Klanker 🤖

**The Adaptive Agent Distribution on the Lolaplex Suite.**

Klanker ist eine schlanke, adaptive Agenten-Distribution auf Basis des **Slimemold-Paradigmas**. Aufsetzend auf dem deterministischen Motor von `agents-harness` formt sich Klanker nach Bedarf:
- Vom autarken Server-Worker (`klanker cron`),
- über den direkten Terminal-Begleiter (`klanker chat`),
- bis zum vollwertigen VPS-Assistenten via Telegram & HTTP (`klanker serve`).

## Quickstart

```bash
# Clone & install (installiert den kompletten Agents Core Stack: harness, gateway, memory, traces, docs)
pip install -e .

# Optional extras (calendar is core, already in pip install -e .)
pip install -e ".[browser]"   # CDP Browser Automation
pip install -e ".[keys]"      # Ed25519 Agent Keys
pip install -e ".[suite]"     # Volle Lolaplex Suite

# 1. Umgebung & Fühler prüfen
klanker sense

# 2. Dynamischen System-Prompt einsehen
klanker prompt

# 3. Interaktiver Chat (REPL)
klanker

# 4. Direkter Turn im Terminal
klanker "Wer bist du?"

# 5. I/O-Gateway starten (HTTP & Telegram)
klanker serve

# 6. Geplante Koru-Harness-Flows ausführen
klanker cron
```


## Die Architektur

1. **Das Brain (`agents-harness`)** — Motor, LLM-Streaming, Cordis-Kernel, Koru-Schedules, lokales Gedächtnis (`agents-memory`), JSONL-Observability & Chat-Rekonstruktion (`agents-traces`) und lokales Markdown-RAG (`agents-docs`).
2. **Die I/O-Schicht (`agents-relay`)** — Universelle Ein- und Ausgabe via HTTP (`/v1/turn`) und Telegram Long-Poll.
3. **Die User-App (`klanker`)** — Verbindet Brain & Relay zu einer adaptiven Slimemold-Shell.
4. **Kalender (core)** — CalDAV via `agents-calendar`. Overlay-Module `mcp.calendar.*` sind immer da. Desktop: `~/.agents/calendar.json`. VPS/`klanker serve`: Coolify env `CALDAV_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD`.
5. **Optionale Tools & Fühler** — CDP-Browser (`agents-browser`), Ed25519-Keys (`agents-keys`), oder beliebige MCP-Tools.


