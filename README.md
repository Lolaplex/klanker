# Clanker 🤖

**The Adaptive Agent Distribution on the Lolaplex Suite.**

Clanker ist eine schlanke, adaptive Agenten-Distribution auf Basis des **Slimemold-Paradigmas**. Aufsetzend auf dem deterministischen Motor von `agents-harness` formt sich Clanker nach Bedarf:
- Vom autarken Server-Worker (`clanker cron`),
- über den direkten Terminal-Begleiter (`clanker chat`),
- bis zum vollwertigen VPS-Assistenten via Telegram & HTTP (`clanker serve`).

## Quickstart

```bash
# Clone & install (installiert den Core Brain Stack: harness, gateway, memory, traces, docs)
pip install -e .

# Optional: Host-spezifische Fühler nach Bedarf aktivieren
pip install -e ".[browser]"   # Minimaler CDP-Browser
pip install -e ".[keys]"      # Ed25519 Host-Key-Minting & Challenge-Response
pip install -e ".[suite]"     # Alle Fühler

# 1. Umgebung & Fühler prüfen
clanker sense

# 2. Dynamischen System-Prompt einsehen
clanker prompt

# 3. Interaktiver Chat (REPL)
clanker

# 4. Direkter Turn im Terminal
clanker "Wer bist du?"

# 5. I/O-Gateway starten (Telegram & HTTP)
clanker serve

# 6. Geplante Koru-Harness-Flows ausführen
clanker cron
```

## Die Architektur

1. **Core Brain Stack (Standard):**
   - `agents-harness` — Runner-Loop, LLM-Streaming, Cordis Tools, Koru-Schedules.
   - `agents-gateway` — Telegram Long-Poll & HTTP I/O Gateway.
   - `agents-memory` — Lokales Markdown-Gedächtnis & Fakten-Extraktion.
   - `agents-traces` — Append-Only JSONL Tracing & Session/Identitäts-Reconstruction.
   - `agents-docs` — Ultra-schnelles lokales BM25 Dokumentations-RAG.

2. **Adaptive Host-Fühler (Slimemold):**
   - `agents-browser` — Lokale Chrome/Edge Steuerung via CDP.
   - `agents-keys` — Ed25519 Host Agent Key Minting & Board-Proofing.


