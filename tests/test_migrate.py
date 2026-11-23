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


def test_default_keeps_sources(tmp_path):
    """The runtime still reads personas/config/memory from files: a
    default run must not move them away."""
    ws = _ws(tmp_path)
    src = ws / "personas" / "coder" / "persona.json"
    src.write_text(json.dumps({"id": "coder"}))
    cfg = ws / "config.json"
    cfg.write_text(json.dumps({"model": "k2"}))
    mem = ws / "memory" / "A.md"
    mem.write_text("# A")
    stats = migrate_to_store(ws)
    assert stats["personas"]["imported"] == 1
    assert stats["personas"]["archived"] == 0
    assert src.is_file() and cfg.is_file() and mem.is_file()
    assert not (ws / "archive").exists()


def test_nested_secrets_never_import(tmp_path):
    ws = _ws(tmp_path)
    (ws / "config.json").write_text(json.dumps({
        "theme": "dark",
        "providers": {
            "openrouter": {"api_key": "sk-or-NESTED1", "model": "x/y"},
            "local": {"url": "http://127.0.0.1:1234", "api_key": "LOCAL_KEY",
                      "headers": {"Authorization": "Bearer NESTED2"}},
            "list": [{"token": "NESTED3"}, "ghp_NESTED4abcdefgh", "ok"],
        },
        "hotkey": "ctrl+space",
    }))
    (ws / "personas" / "coder" / "persona.json").write_text(json.dumps(
        {"id": "coder", "env": {"GITHUB_TOKEN": "gho_NESTED5"},
         "mcp": [{"password": "NESTED6"}]}))
    stats = migrate_to_store(ws)
    assert stats["config"]["skipped_secret"] == 5  # 4 values + 1 env ref
    assert stats["personas"]["skipped_secret"] == 2
    conn = connect(ws / "store.db")
    blob = " ".join(str(r[0]) for r in conn.execute("SELECT v FROM datom"))
    for n in range(1, 7):
        assert f"NESTED{n}" not in blob
    store = Store(conn, "t")
    prov = json.loads(_view(store, "cfg:providers")["cfg:value"])
    assert prov["openrouter"] == {"model": "x/y"}
    assert prov["list"] == [{}, "ok"]
    assert "api_key" not in prov["local"]
    assert _view(store, "cfg:providers.local.api_key")["cfg:key_env"] == "LOCAL_KEY"
    assert _view(store, "cfg:hotkey")["cfg:value"] == "ctrl+space"
    conn.close()


def test_import_actor_is_host_scoped(tmp_path):
    ws = _ws(tmp_path)
    (ws / "config.json").write_text(json.dumps({"model": "k2"}))
    migrate_to_store(ws, node="hostA")
    conn = connect(ws / "store.db")
    actors = {r[0] for r in conn.execute(
        "SELECT origin_actor FROM tx WHERE origin_actor IS NOT NULL")}
    assert actors == {"import@hostA:config:model"}
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


# -- scrubbing: memory md/yaml, key tokens, value patterns -------------------

import pytest  # noqa: E402

from klanker.migrate import (REDACTED, _is_secret_key, redact_text,  # noqa: E402
                             scrub_secrets)

FAKE_SK = "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2"
FAKE_GHP = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
FAKE_XOX = "xoxb-" + "1234567890-0987654321-AbCdEfGhIjKl"
FAKE_AKIA = "AKIA" + "IOSFODNN7EXAMPLE"
FAKE_ENTROPY = "Zq8Xv2Lm9Pt4Rw7Ks1Nd6Hf3Jb5Gc0Ty"


def _blob(ws):
    conn = connect(ws / "store.db")
    try:
        return " ".join(str(r[0]) for r in conn.execute("SELECT v FROM datom"))
    finally:
        conn.close()


@pytest.mark.parametrize("archive", [False, True])
def test_memory_md_tokens_redacted(tmp_path, archive):
    ws = _ws(tmp_path)
    (ws / "memory" / "NOTES.md").write_text(
        f"# Notes\n\nopenai key is {FAKE_SK} for now\n"
        f"- token: {FAKE_GHP}\n")
    stats = migrate_to_store(ws, archive=archive)
    assert stats["memory"]["imported"] == 1
    assert stats["memory"]["redacted"] >= 2
    blob = _blob(ws)
    assert FAKE_SK not in blob and FAKE_GHP not in blob
    assert "openai key is [REDACTED] for now" in blob
    assert "Notes" in blob
    if archive:
        assert (ws / "archive" / "pre-store" / "memory" / "NOTES.md").is_file()


def test_memory_nested_md_and_yaml_read_and_scrubbed(tmp_path):
    ws = _ws(tmp_path)
    (ws / "memory" / "proj" / "deep").mkdir(parents=True)
    (ws / "memory" / "proj" / "deep" / "INFRA.md").write_text(
        f"# Infra\naws {FAKE_AKIA}\nslack {FAKE_XOX}\n")
    (ws / "memory" / "proj" / "creds.yaml").write_text(
        "service:\n"
        "  url: postgres://app:hunter2pass@db:5432/x\n"
        "  password: hunter2\n"
        "  api_key: OPENAI_API_KEY\n"
        "  author: Felix\n"
        "  private_key: |\n"
        "    MIIEvQIBADANBgkq\n"
        "    AbCdEf\n"
        "  model: k2\n")
    (ws / "memory" / "settings.yml").write_text(f"client_secret: '{FAKE_ENTROPY}'\n")
    stats = migrate_to_store(ws)
    assert stats["memory"]["imported"] == 3
    conn = connect(ws / "store.db")
    store = Store(conn, "t")
    infra = _view(store, "mem:proj/deep/INFRA")
    assert infra["mem:file"] == "proj/deep/INFRA.md"
    assert FAKE_AKIA not in infra["mem:text"] and FAKE_XOX not in infra["mem:text"]
    y = _view(store, "mem:proj/creds.yaml")["mem:text"]
    assert "hunter2" not in y
    assert "MIIEvQIBADANBgkq" not in y and "AbCdEf" not in y
    assert "postgres://app:[REDACTED]@db:5432/x" in y
    assert "api_key: OPENAI_API_KEY" in y       # env indirection kept
    assert "author: Felix" in y                 # harmless key kept
    assert "model: k2" in y                     # block ended correctly
    s = _view(store, "mem:settings.yml")["mem:text"]
    assert FAKE_ENTROPY not in s
    conn.close()


def test_memory_symlinks_and_dotdirs_skipped(tmp_path):
    ws = _ws(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("# outside")
    (ws / "memory" / "link.md").symlink_to(outside)
    (ws / "memory" / ".git").mkdir()
    (ws / "memory" / ".git" / "x.md").write_text("# hidden")
    stats = migrate_to_store(ws)
    assert stats["memory"]["imported"] == 0


@pytest.mark.parametrize("key", [
    "author", "tokenizer", "max_tokens", "hotkey", "keyboard", "authority",
    "passive", "sort_key", "primary_key", "public_key", "monkey", "keys",
    "passages", "description", "key_id", "model_key",
])
def test_harmless_keys_not_secret(key):
    assert not _is_secret_key(key)


@pytest.mark.parametrize("key", [
    "token", "api_key", "apiKey", "OPENAI_API_KEY", "accessToken",
    "client_secret", "clientSecret", "password", "db_pass", "auth",
    "Authorization", "private_key", "aws_secret_access_key", "x-api-key",
    "session_id", "refresh-token", "GITHUB_TOKEN", "openai_key", "cookie",
])
def test_secret_keys_detected(key):
    assert _is_secret_key(key)


def test_harmless_keys_survive_scrub():
    doc = {"author": "Felix", "tokenizer": "cl100k", "max_tokens": 4096,
           "hotkey": "ctrl+k", "authority": "relay"}
    clean, refs, dropped = scrub_secrets(doc)
    assert clean == doc and refs == [] and dropped == 0


def test_token_inside_normal_string_redacted():
    doc = {"system": f"use {FAKE_SK} when calling", "notes": [
        f"curl -H 'Authorization: Bearer abcdefghijklmnop1234' x",
        f"aws {FAKE_AKIA} done", "plain text stays"]}
    clean, _, dropped = scrub_secrets(doc)
    assert clean["system"] == "use [REDACTED] when calling"
    assert FAKE_AKIA not in clean["notes"][1]
    assert "abcdefghijklmnop1234" not in clean["notes"][0]
    assert clean["notes"][2] == "plain text stays"
    assert dropped == 3


@pytest.mark.parametrize("secret", [
    FAKE_SK, FAKE_GHP, FAKE_XOX, FAKE_AKIA, FAKE_ENTROPY,
    "Bearer abcdefghijklmnop1234",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl",
])
def test_value_patterns_redacted_in_text(secret):
    red, n = redact_text(f"before {secret} after")
    assert n >= 1
    assert secret.split()[-1] not in red
    assert red.startswith("before ") and red.endswith(" after")


@pytest.mark.parametrize("text", [
    "commit 3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a is fine",  # hex sha
    "use scikit-learn and sk-learn style names",
    "Password: ask the admin, it is in the vault",             # prose
    "password: ${DB_PASSWORD}",
    "token: OPENAI_API_KEY",
    "https://example.com/a/b?c=d",
])
def test_no_false_positive_redaction(text):
    red, n = redact_text(text)
    assert (red, n) == (text, 0)


def test_no_false_positive_on_real_paths(tmp_path):
    deep = tmp_path / "projects" / "klanker" / "src" / "klanker"
    deep.mkdir(parents=True)
    text = f"path {deep / 'migrate.py'} and {tmp_path}"
    assert redact_text(text) == (text, 0)


def test_memory_size_limit_skips_and_warns(tmp_path, monkeypatch, caplog):
    ws = _ws(tmp_path)
    (ws / "memory" / "SMALL.md").write_text("# small")
    big = ws / "memory" / "BIG.md"
    big.write_text("x" * 2048)
    stats = migrate_to_store(ws, archive=True, memory_max_bytes=1024)
    assert stats["memory"]["imported"] == 1
    assert stats["memory"]["skipped_large"] == 1
    assert any("BIG.md" in w for w in stats["warnings"])
    assert big.exists()  # skipped files are not archived either
    assert "xxxx" not in _blob(ws)
    # env knob
    ws2 = tmp_path / "ws2"
    (ws2 / "memory").mkdir(parents=True)
    (ws2 / "memory" / "BIG.md").write_text("y" * 600)
    monkeypatch.setenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", "500")
    assert migrate_to_store(ws2)["memory"]["skipped_large"] == 1
    monkeypatch.setenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", "0")  # 0 = no limit
    assert migrate_to_store(ws2)["memory"]["imported"] == 1


def test_default_memory_limit_is_one_mib(tmp_path, monkeypatch):
    monkeypatch.delenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", raising=False)
    ws = _ws(tmp_path)
    (ws / "memory" / "HUGE.md").write_text("z" * (1024 * 1024 + 1))
    (ws / "memory" / "OK.md").write_text("z" * (1024 * 1024))
    stats = migrate_to_store(ws)
    assert stats["memory"]["skipped_large"] == 1
    assert stats["memory"]["imported"] == 1


def test_cli_warns_sources_keep_raw_tokens(tmp_path, monkeypatch, capsys):
    import sys

    from klanker import __main__ as cli

    ws = _ws(tmp_path)
    (ws / "memory" / "N.md").write_text("# n")
    (ws / "memory" / "BIG.md").write_text("q" * 64)

    class _WS:
        dir = ws
        root = ws

    import agents_workspace
    from klanker import updates
    monkeypatch.setattr(updates, "check_for_updates", lambda *a, **k: None)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    monkeypatch.setattr(agents_workspace.Workspace, "from_env",
                        classmethod(lambda cls: _WS()))
    monkeypatch.setattr(sys, "argv", ["klanker", "migrate", "--to-store",
                                      "--archive", "--memory-max-bytes", "32"])
    rc = cli.main()
    out = capsys.readouterr()
    assert rc in (0, None)
    assert "memory: " in out.out and "skipped_large=1" in out.out
    assert "warning: memory/BIG.md" in out.err
    assert "source files on disk still hold any raw tokens" in out.err
    assert "archive/pre-store" in out.err


@pytest.mark.parametrize("text", [
    "z" * (1 << 20), "a:" * (1 << 19), "x" * 500_000 + "://",
    "sk-" * 300_000, "k=" + "v" * (1 << 20),
])
def test_redact_text_linear_on_large_input(text):
    t0 = time.time()
    redact_text(text)
    assert time.time() - t0 < 5.0
