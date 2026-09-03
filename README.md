# Clanker 🤖

**The Adaptive Agent Distribution on the Lolaplex Suite.**

Clanker ist eine schlanke, adaptive Agenten-Distribution auf Basis des **Slimemold-Paradigmas**. Aufsetzend auf dem deterministischen Motor von `agents-harness` formt sich Clanker nach Bedarf:
- Vom autarken Server-Worker (`clanker cron`),
- über den direkten Terminal-Begleiter (`clanker chat`),
- bis zum vollwertigen VPS-Assistenten via Telegram & HTTP (`clanker serve`).

## Quickstart

```bash
# Clone & install (installiert automatisch agents-harness als Kern)
pip install -e .

# Optional: Gateway (Telegram/HTTP) oder volle Suite installieren
pip install -e ".[gateway]"
pip install -e ".[suite]"

# 1. Umgebung & Fühler prüfen
clanker sense

# 2. Direkter Turn im Terminal (nutzt agents-harness runner.loop)
clanker chat "ping"

# 3. I/O-Gateway starten (erfordert agents-gateway)
clanker serve

# 4. Geplante Koru-Harness-Flows ausführen
clanker cron
```

## Die 3-Ebenen-Architektur

1. **Ebene 1: Essentieller Kern (`agents-harness`)** — Runner-Loop, LLM-Streaming, Tool-Dispatch, Koru-Schedules.
2. **Ebene 2: Fast immer sinnvoll (`agents-gateway`, `agents-memory`)** — Telegram/HTTP-Zugriff und persönliches Gedächtnis/Fakten.
3. **Ebene 3: Rein optional (`agents-docs`, `agents-traces`, `agents-browser`)** — Schnelles RAG, JSONL-Tracing, Browser-Automation.


