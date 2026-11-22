"""migrate --to-store: personas/config/memory -> store.db, idempotent."""
import json
import os
import time

from agents_store.db import connect
from agents_store.store import Store

from klanker.migrate import migrate_to_store


def _ws(tmp_path):
    ws = tmp_path / "ws"
    (ws / "personas" / "coder").mkdir(parents=True)
    (ws / "memory").mkdir(parents=True)
    return ws


def _view(store, e):
    return store.view(e)


def test_persona_import(tmp_path):
    ws = _ws(tmp_path)
    (ws / "personas" / "coder" / "persona.json").write_text(json.dumps(
        {"id": "coder", "name": "Coder", "system": "be terse"}))
    stats = migrate_to_store(ws, archive=False)
    assert stats["personas"]["imported"] == 1
    conn = connect(ws / "store.db")
    view = _view(Store(conn, "t"), "persona:coder")
    assert view["persona:name"] == "Coder"
    assert json.loads(view["persona:json"])["system"] == "be terse"
    conn.close()


def test_config_secrets_never_import_values(tmp_path):
    ws = _ws(tmp_path)
    (ws / "config.json").write_text(json.dumps({
        "model": "k2",
        "openai_api_key": "sk-live-secret",
        "relay_token": "RELAY_TOKEN",   # env indirection, allowed
    }))
    stats = migrate_to_store(ws, archive=False)
    assert stats["config"]["skipped_secret"] == 2
    conn = connect(ws / "store.db")
    store = Store(conn, "t")
    assert "cfg:value" not in _view(store, "cfg:openai_api_key")
    assert _view(store, "cfg:model")["cfg:value"] == "k2"
    assert _view(store, "cfg:relay_token")["cfg:key_env"] == "RELAY_TOKEN"
    # raw secret nowhere in the db
    for row in conn.execute("SELECT v FROM datom"):
        assert "sk-live-secret" not in str(row[0])
    conn.close()


def test_memory_md_import(tmp_path):
    ws = _ws(tmp_path)
    (ws / "memory" / "PROJECTS.md").write_text("# Projects\n\n- klanker")
    stats = migrate_to_store(ws, archive=False)
    assert stats["memory"]["imported"] == 1
    conn = connect(ws / "store.db")
    view = _view(Store(conn, "t"), "mem:PROJECTS")
    assert "- klanker" in view["mem:text"]
    assert view["mem:title"] == "Projects"
    conn.close()


def test_idempotent_and_archive(tmp_path):
    ws = _ws(tmp_path)
    src = ws / "personas" / "coder" / "persona.json"
    src.write_text(json.dumps({"id": "coder"}))
    first = migrate_to_store(ws, archive=True)
    assert first["personas"]["imported"] == 1
    assert first["personas"]["archived"] == 1
    assert not src.exists()
    assert (ws / "archive" / "pre-store" / "personas" / "coder"
            / "persona.json").is_file()
    # re-run: nothing left to import, no crash on missing dir entries
    second = migrate_to_store(ws, archive=True)
    assert second["personas"]["imported"] == 0


def test_changed_file_reimports(tmp_path):
    ws = _ws(tmp_path)
    cfg = ws / "config.json"
    cfg.write_text(json.dumps({"model": "k1"}))
    migrate_to_store(ws, archive=False)
    time.sleep(0.01)
    os.utime(cfg, (time.time() + 5, time.time() + 5))
    cfg.write_text(json.dumps({"model": "k2"}))
    os.utime(cfg, (time.time() + 5, time.time() + 5))
    stats = migrate_to_store(ws, archive=False)
    assert stats["config"]["imported"] == 1
    conn = connect(ws / "store.db")
    assert _view(Store(conn, "t"), "cfg:model")["cfg:value"] == "k2"
    conn.close()


def test_missing_domains_empty_stats(tmp_path):
    ws = tmp_path / "empty"
    ws.mkdir()
    stats = migrate_to_store(ws, archive=False)
    assert stats["personas"]["imported"] == 0
