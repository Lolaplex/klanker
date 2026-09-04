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

1. **Das Paket / Brain (`clanker` Base)** — Der komplette Kern: `agents-harness` (Motor/Loop), `agents-gateway` (I/O, HTTP & Telegram), `agents-memory` (Gedächtnis), `agents-traces` (JSONL-Observability & Chat-Rekonstruktion), `agents-docs` (Local Markdown RAG).
2. **Optionale Fühler (`[browser]`, `[keys]`)** — Browser-Steuerung (`agents-browser`), Ed25519 DID Key-Minting (`agents-keys`).


