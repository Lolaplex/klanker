#!/usr/bin/env python3
"""One-time seed for /volume1/docker/klanker on SigmaNAS.

Runs ON the NAS via:  ssh sigmanas python3 - < scripts/nas-seed.py

- Copies assistant .agents (memory, docs, rules, skills, identity.json)
  into klanker's data dir. Missing files only — never overwrites, so it
  is safe to re-run after klanker has started writing its own memory.
- Writes klanker .env from the assistant .env, keeping only keys the
  relay/serve path reads. TELEGRAM_* is dropped on purpose: the assistant
  owns telegram polling; klanker serve would poll the same bot twice.
- Ingests assistant.db messages -> klanker traces as agents-traces
  `message` events (origin "ingested", session telegram-<chat_id>),
  split into daily YYYY-MM-DD.jsonl files. Idempotent via sentinel.

Nothing here mutates the assistant project. Reads are read-only.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timezone

ASSISTANT = "/volume1/docker/agents-assistant"
KLANKER = "/volume1/docker/klanker"
COPY_DIRS = ["memory", "docs", "rules", "skills"]
COPY_FILES = ["identity.json"]
KEEP_ENV_PREFIXES = ("GATEWAY_", "RELAY_", "LLM_", "OPENAI_", "OPENROUTER_", "AGENTS_IDENTITY")
DROP_ENV_PREFIXES = ("TELEGRAM_", "DB_PATH", "HOST_ADAPTER", "AGENTS_MEMORY_PATH", "AGENTS_TRACES_DIR", "AGENTS_HOME")
SENTINEL = os.path.join(KLANKER, "data/.agents/traces/.assistant-ingest")


def seed_agents(src_root: str, dst_root: str) -> int:
    copied = 0
    for name in COPY_DIRS:
        src, dst = os.path.join(src_root, name), os.path.join(dst_root, name)
        if not os.path.isdir(src):
            continue
        for root, _dirs, files in os.walk(src):
            rel = os.path.relpath(root, src)
            target_dir = os.path.join(dst, rel) if rel != "." else dst
            os.makedirs(target_dir, exist_ok=True)
            for f in files:
                s, d = os.path.join(root, f), os.path.join(target_dir, f)
                if not os.path.exists(d):
                    shutil.copy2(s, d)
                    copied += 1
    for name in COPY_FILES:
        s, d = os.path.join(src_root, name), os.path.join(dst_root, name)
        if os.path.isfile(s) and not os.path.exists(d):
            shutil.copy2(s, d)
            copied += 1
    return copied


def seed_env() -> int:
    src, dst = os.path.join(ASSISTANT, ".env"), os.path.join(KLANKER, ".env")
    if os.path.exists(dst) or not os.path.isfile(src):
        return 0
    kept = []
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key = stripped.split("=", 1)[0].strip()
            if any(key.startswith(p) for p in DROP_ENV_PREFIXES):
                continue
            if any(key.startswith(p) for p in KEEP_ENV_PREFIXES):
                kept.append(stripped)
    with open(dst, "w", encoding="utf-8") as fh:
        fh.write("# seeded from agents-assistant/.env (filtered) by nas-seed.py\n")
        fh.write("\n".join(kept) + "\n")
    return len(kept)


def ingest_messages() -> int:
    db_path = os.path.join(ASSISTANT, "data/assistant.db")
    if not os.path.isfile(db_path):
        print("no assistant.db — nothing to ingest")
        return 0
    last_id = 0
    if os.path.isfile(SENTINEL):
        last_id = int(open(SENTINEL, encoding="utf-8").read().strip() or 0)
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT id, chat_id, role, content, created_at FROM messages WHERE id > ? ORDER BY id",
        (last_id,),
    ).fetchall()
    con.close()
    if not rows:
        print("messages: nothing new")
        return 0
    traces_dir = os.path.join(KLANKER, "data/.agents/traces")
    os.makedirs(traces_dir, exist_ok=True)
    written = 0
    for mid, chat_id, role, content, created_at in rows:
        body = content or ""
        sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
        try:
            ts = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
        except ValueError:
            ts = datetime.now(timezone.utc)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        event = {
            "ts": ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "session": f"telegram-{chat_id}",
            "type": "message",
            "origin": "ingested",
            "metadata": {
                "role": role or "user",
                "content": body,
                "digest": sha[:12],
                "sha256": sha,
                "chars": len(body),
                "source": "telegram",
            },
        }
        day = ts.astimezone(timezone.utc).strftime("%Y-%m-%d")
        with open(os.path.join(traces_dir, f"{day}.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")
        written += 1
        last_id = mid
    with open(SENTINEL, "w", encoding="utf-8") as fh:
        fh.write(str(last_id))
    return written


def main() -> int:
    os.makedirs(os.path.join(KLANKER, "data/.agents"), exist_ok=True)
    copied = seed_agents(os.path.join(ASSISTANT, "data/.agents"),
                         os.path.join(KLANKER, "data/.agents"))
    print(f"agents files seeded (new): {copied}")
    env_keys = seed_env()
    print(f".env keys seeded: {env_keys}" if env_keys else ".env exists — untouched")
    ingested = ingest_messages()
    print(f"messages ingested -> traces: {ingested}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
