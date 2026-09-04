# Clanker 🤖

**The Adaptive Agent Distribution on the Lolaplex Suite.**

Clanker ist eine schlanke, adaptive Agenten-Distribution auf Basis des **Slimemold-Paradigmas**. Aufsetzend auf dem deterministischen Motor von `agents-harness` formt sich Clanker nach Bedarf:
- Vom autarken Server-Worker (`clanker cron`),
- über den direkten Terminal-Begleiter (`clanker chat`),
- bis zum vollwertigen VPS-Assistenten via Telegram & HTTP (`clanker serve`).

## Quickstart

```bash
# Clone & install (installiert nur agents-harness als minimalen Kern)
pip install -e .

# Optional: Fühler nach Bedarf aktivieren
pip install -e ".[gateway]"   # Telegram & HTTP Gateway
pip install -e ".[memory]"    # Lokales Gedächtnis & Fakten
pip install -e ".[suite]"     # Volle Lolaplex Suite

# 1. Umgebung & Fühler prüfen
clanker sense

# 2. Dynamischen System-Prompt einsehen
clanker prompt

# 3. Interaktiver Chat (REPL)
clanker

# 4. Direkter Turn im Terminal
clanker "Wer bist du?"

# 5. I/O-Gateway starten (erfordert agents-gateway)
clanker serve

# 6. Geplante Koru-Harness-Flows ausführen
clanker cron
```


## Die 3-Ebenen-Architektur

1. **Ebene 1: Essentieller Kern (`agents-harness`)** — Runner-Loop, LLM-Streaming, Tool-Dispatch, Koru-Schedules.
2. **Ebene 2: Fast immer sinnvoll (`agents-gateway`, `agents-memory`)** — Telegram/HTTP-Zugriff und persönliches Gedächtnis/Fakten.
3. **Ebene 3: Rein optional (`agents-docs`, `agents-traces`, `agents-browser`)** — Schnelles RAG, JSONL-Tracing, Browser-Automation.


