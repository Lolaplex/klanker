# Clanker 🤖

**The Adaptive Agent Distribution on the Lolaplex Suite.**

Clanker ist eine schlanke, adaptive Agenten-Distribution auf Basis des **Slimemold-Paradigmas**. Aufsetzend auf dem deterministischen Motor von `agents-harness` formt sich Clanker nach Bedarf:
- Vom autarken Server-Worker (`clanker cron`),
- über den direkten Terminal-Begleiter (`clanker chat`),
- bis zum vollwertigen VPS-Assistenten via Telegram & HTTP (`clanker serve`).

## Quickstart

```bash
# Clone & install (installiert den kompletten Agents Core Stack: harness, gateway, memory, traces, docs)
pip install -e .

# Optional: Zusätzliche Slimemold-Fühler aktivieren
pip install -e ".[browser]"   # CDP Browser Automation
pip install -e ".[keys]"      # Ed25519 Agent Keys
pip install -e ".[suite]"     # Volle Lolaplex Suite

# 1. Umgebung & Fühler prüfen
clanker sense

# 2. Dynamischen System-Prompt einsehen
clanker prompt

# 3. Interaktiver Chat (REPL)
clanker

# 4. Direkter Turn im Terminal
clanker "Wer bist du?"

# 5. I/O-Gateway starten (HTTP & Telegram)
clanker serve

# 6. Geplante Koru-Harness-Flows ausführen
clanker cron
```


## Die Architektur

1. **Das Brain (`agents-harness`)** — Motor, LLM-Streaming, Cordis-Kernel, Koru-Schedules, lokales Gedächtnis (`agents-memory`), JSONL-Observability & Chat-Rekonstruktion (`agents-traces`) und lokales Markdown-RAG (`agents-docs`).
2. **Die I/O-Schicht (`agents-gateway`)** — Universelle Ein- und Ausgabe via HTTP (`/v1/turn`) und Telegram Long-Poll.
3. **Die User-App (`clanker`)** — Verbindet Brain & Gateway zu einer adaptiven Slimemold-Shell.
4. **Optionale Tools & Fühler** — Externe Fähigkeiten wie CDP-Browser (`agents-browser`), Ed25519-Keys (`agents-keys`), Jailed Terminal (`agents-terminal`) oder beliebige MCP-Tools, die Clanker bei Bedarf vorschlägt oder einbindet.


