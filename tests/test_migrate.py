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



def _can_symlink(tmp_path):
    probe = tmp_path / ".symlink-probe"
    try:
        probe.symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        return False
    probe.unlink()
    return True

def test_persona_import(tmp_path):
    ws = _ws(tmp_path)
    (ws / "personas" / "coder" / "persona.json").write_text(json.dumps(
        {"id": "coder", "name": "Coder", "system": "be terse"}), encoding="utf-8")
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
    }), encoding="utf-8")
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
    (ws / "memory" / "PROJECTS.md").write_text("# Projects\n\n- klanker", encoding="utf-8")
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
    src.write_text(json.dumps({"id": "coder"}), encoding="utf-8")
    cfg = ws / "config.json"
    cfg.write_text(json.dumps({"model": "k2"}), encoding="utf-8")
    mem = ws / "memory" / "A.md"
    mem.write_text("# A", encoding="utf-8")
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
    }), encoding="utf-8")
    (ws / "personas" / "coder" / "persona.json").write_text(json.dumps(
        {"id": "coder", "env": {"GITHUB_TOKEN": "gho_NESTED5"},
         "mcp": [{"password": "NESTED6"}]}), encoding="utf-8")
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
    (ws / "config.json").write_text(json.dumps({"model": "k2"}), encoding="utf-8")
    migrate_to_store(ws, node="hostA")
    conn = connect(ws / "store.db")
    actors = {r[0] for r in conn.execute(
        "SELECT origin_actor FROM tx WHERE origin_actor IS NOT NULL")}
    assert actors == {"import@hostA:store"}
    conn.close()


def test_import_seq_is_monotonic_and_deterministic(tmp_path):
    """origin_seq runs 1..N in (domain, relpath, line) order — never mtime."""
    ws = _ws(tmp_path)
    (ws / "config.json").write_text(json.dumps({"b": "2", "a": "1"}), encoding="utf-8")
    (ws / "personas" / "coder" / "persona.json").write_text(
        json.dumps({"id": "coder"}), encoding="utf-8")
    (ws / "memory" / "N.md").write_text("# n", encoding="utf-8")
    migrate_to_store(ws, node="h")
    conn = connect(ws / "store.db")
    seqs = [r[0] for r in conn.execute(
        "SELECT origin_seq FROM tx WHERE origin_actor = 'import@h:store'"
        " ORDER BY origin_seq")]
    assert seqs == list(range(1, len(seqs) + 1))
    # a second run with an unchanged tree adds no new tx
    n_tx = conn.execute("SELECT COUNT(*) FROM tx").fetchone()[0]
    conn.close()
    stats = migrate_to_store(ws, node="h")
    assert stats["config"]["dupes"] == 2
    conn = connect(ws / "store.db")
    assert conn.execute("SELECT COUNT(*) FROM tx").fetchone()[0] == n_tx
    # a changed file re-imports under the NEXT seq — not a reused mtime
    (ws / "config.json").write_text(json.dumps({"b": "2", "a": "9"}), encoding="utf-8")
    stats = migrate_to_store(ws, node="h")
    assert stats["config"]["imported"] == 1
    seqs = [r[0] for r in conn.execute(
        "SELECT origin_seq FROM tx WHERE origin_actor = 'import@h:store'"
        " ORDER BY origin_seq")]
    assert seqs == list(range(1, len(seqs) + 1))
    conn.close()


def test_idempotent_and_archive(tmp_path):
    ws = _ws(tmp_path)
    src = ws / "personas" / "coder" / "persona.json"
    src.write_text(json.dumps({"id": "coder"}), encoding="utf-8")
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
    cfg.write_text(json.dumps({"model": "k1"}), encoding="utf-8")
    migrate_to_store(ws, archive=False)
    time.sleep(0.01)
    os.utime(cfg, (time.time() + 5, time.time() + 5))
    cfg.write_text(json.dumps({"model": "k2"}), encoding="utf-8")
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
        f"- token: {FAKE_GHP}\n", encoding="utf-8")
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
        f"# Infra\naws {FAKE_AKIA}\nslack {FAKE_XOX}\n", encoding="utf-8")
    (ws / "memory" / "proj" / "creds.yaml").write_text(
        "service:\n"
        "  url: postgres://app:hunter2pass@db:5432/x\n"
        "  password: hunter2\n"
        "  api_key: OPENAI_API_KEY\n"
        "  author: Felix\n"
        "  private_key: |\n"
        "    MIIEvQIBADANBgkq\n"
        "    AbCdEf\n"
        "  model: k2\n", encoding="utf-8")
    (ws / "memory" / "settings.yml").write_text(f"client_secret: '{FAKE_ENTROPY}'\n", encoding="utf-8")
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
    if not _can_symlink(tmp_path):
        pytest.skip("symlink privilege required")
    ws = _ws(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("# outside", encoding="utf-8")
    (ws / "memory" / "link.md").symlink_to(outside)
    (ws / "memory" / ".git").mkdir()
    (ws / "memory" / ".git" / "x.md").write_text("# hidden", encoding="utf-8")
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
    (ws / "memory" / "SMALL.md").write_text("# small", encoding="utf-8")
    big = ws / "memory" / "BIG.md"
    big.write_text("x" * 2048, encoding="utf-8")
    stats = migrate_to_store(ws, archive=True, memory_max_bytes=1024)
    assert stats["memory"]["imported"] == 1
    assert stats["memory"]["skipped_large"] == 1
    assert any("BIG.md" in w for w in stats["warnings"])
    assert big.exists()  # skipped files are not archived either
    assert "xxxx" not in _blob(ws)
    # env knob
    ws2 = tmp_path / "ws2"
    (ws2 / "memory").mkdir(parents=True)
    (ws2 / "memory" / "BIG.md").write_text("y" * 600, encoding="utf-8")
    monkeypatch.setenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", "500")
    assert migrate_to_store(ws2)["memory"]["skipped_large"] == 1
    monkeypatch.setenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", "0")  # 0 = no limit
    assert migrate_to_store(ws2)["memory"]["imported"] == 1


def test_default_memory_limit_is_one_mib(tmp_path, monkeypatch):
    monkeypatch.delenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", raising=False)
    ws = _ws(tmp_path)
    (ws / "memory" / "HUGE.md").write_text("z" * (1024 * 1024 + 1), encoding="utf-8")
    (ws / "memory" / "OK.md").write_text("z" * (1024 * 1024), encoding="utf-8")
    stats = migrate_to_store(ws)
    assert stats["memory"]["skipped_large"] == 1
    assert stats["memory"]["imported"] == 1


def test_cli_warns_sources_keep_raw_tokens(tmp_path, monkeypatch, capsys):
    import sys

    from klanker import __main__ as cli

    ws = _ws(tmp_path)
    (ws / "memory" / "N.md").write_text("# n", encoding="utf-8")
    (ws / "memory" / "BIG.md").write_text("q" * 64, encoding="utf-8")

    class _WS:
        dir = ws
        root = ws

    import agents_workspace
    from klanker import updates
    monkeypatch.setattr(updates, "check_for_updates", lambda *a, **k: None)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
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
], ids=["z1m", "a_colon", "x500k_url", "sk_rep", "kv1m"])
def test_redact_text_linear_on_large_input(text):
    t0 = time.time()
    redact_text(text)
    assert time.time() - t0 < 5.0


@pytest.mark.parametrize("bad", [-1, -1024, True, 1.5, "10"])
def test_negative_or_invalid_memory_limit_rejected(tmp_path, bad):
    ws = _ws(tmp_path)
    (ws / "memory" / "N.md").write_text("# n", encoding="utf-8")
    with pytest.raises(ValueError):
        migrate_to_store(ws, memory_max_bytes=bad)
    assert not (ws / "store.db").exists()  # failed before touching the store


@pytest.mark.parametrize("raw", ["-1", "-5000", "abc", "1.5"])
def test_negative_or_invalid_memory_limit_env_rejected(tmp_path, monkeypatch,
                                                       raw):
    ws = _ws(tmp_path)
    monkeypatch.setenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", raw)
    with pytest.raises(ValueError, match="KLANKER_MIGRATE_MEMORY_MAX_BYTES"):
        migrate_to_store(ws)


def _cli_env(tmp_path, monkeypatch, ws):
    import agents_workspace
    from klanker import updates

    class _WS:
        dir = ws
        root = ws

    monkeypatch.setattr(updates, "check_for_updates", lambda *a, **k: None)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    monkeypatch.setattr(agents_workspace.Workspace, "from_env",
                        classmethod(lambda cls: _WS()))


def test_cli_rejects_negative_memory_limit(tmp_path, monkeypatch, capsys):
    from klanker import __main__ as cli

    ws = _ws(tmp_path)
    _cli_env(tmp_path, monkeypatch, ws)
    with pytest.raises(SystemExit) as exc:
        cli.main(["migrate", "--to-store", "--memory-max-bytes", "-1"])
    assert exc.value.code == 2
    assert "must be an integer >= 0" in capsys.readouterr().err
    assert not (ws / "store.db").exists()


def test_cli_rejects_negative_memory_limit_env(tmp_path, monkeypatch, capsys):
    from klanker import __main__ as cli

    ws = _ws(tmp_path)
    _cli_env(tmp_path, monkeypatch, ws)
    monkeypatch.setenv("KLANKER_MIGRATE_MEMORY_MAX_BYTES", "-1")
    assert cli.main(["migrate", "--to-store"]) == 2
    assert "KLANKER_MIGRATE_MEMORY_MAX_BYTES" in capsys.readouterr().err
    assert not (ws / "store.db").exists()


# -- W13 hardening -----------------------------------------------------------


def test_secret_named_container_redacts_all_leaves(tmp_path):
    ws = _ws(tmp_path)
    (ws / "config.json").write_text(json.dumps({
        "model": "k2",
        "secrets": {"db": "plain", "other": {"deep": "hidden"}},
        "vault": ["a1", {"x": "b2"}, 3],
    }), encoding="utf-8")
    stats = migrate_to_store(ws)
    conn = connect(ws / "store.db")
    try:
        blob = " ".join(str(r[0]) for r in conn.execute(
            "SELECT v FROM datom"))
    finally:
        conn.close()
    for leaked in ("plain", "hidden", "a1", "b2"):
        assert leaked not in blob
    assert stats["config"]["skipped_secret"] >= 2
    store = Store(conn2 := connect(ws / "store.db"), "t")
    prov = json.loads(_view(store, "cfg:secrets")["cfg:value"])
    assert prov == {"db": "[REDACTED]", "other": {"deep": "[REDACTED]"}}
    conn2.close()


def test_redact_text_inline_comment_before_whitespace():
    red, n = redact_text("api_key: secret123 # prod")
    assert n == 1
    assert "secret123" not in red and "prod" not in red
    assert "api_key:" in red
    # quoted values keep an inner #
    red, n = redact_text('token: "abc # not a comment"')
    assert "# not a comment" not in red or n == 1


def test_redact_text_telegram_and_webhooks():
    tg = "123456789:AAFakesfakefakesfakefakesfakefake12"
    red, n = redact_text(f"bot {tg} here")
    assert n >= 1 and tg not in red
    for url in (
            "https://hooks.slack.com/services/T000AAA/B000BBB/xxsecret",
            "https://discord.com/api/webhooks/1234567890/AbCdEfGh-secret",
            "https://discordapp.com/api/webhooks/1234567890/AbCdEf-secret"):
        red, n = redact_text(f"post {url} now")
        assert n >= 1 and url.split("/")[-1] not in red, url


def test_redact_text_hex32_under_secret_key():
    h = "0123456789abcdef0123456789abcdef"
    for text in (f"secret_key = '{h}'", f"client_secret: {h}",
                 f"api_secret={h}"):
        red, n = redact_text(text)
        assert n >= 1 and h not in red, text
    # a bare hex digest (git sha) stays
    red, n = redact_text(f"commit {h} is fine")
    assert (red, n) == (f"commit {h} is fine", 0)


def test_archive_collision_free_bak(tmp_path):
    ws = _ws(tmp_path)
    src = ws / "personas" / "coder" / "persona.json"
    for i in range(3):
        src.write_text(json.dumps({"id": "coder", "v": i}), encoding="utf-8")
        migrate_to_store(ws, archive=True)
        # put the source back as if the file were re-created between runs
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_text(json.dumps({"id": "coder", "v": i}), encoding="utf-8")
    base = ws / "archive" / "pre-store" / "personas" / "coder"
    names = sorted(p.name for p in base.iterdir())
    assert "persona.json" in names
    assert "persona.json.bak.1" in names
    assert "persona.json.bak.2" in names
    # no overwrite: three distinct files survived
    assert len(list(base.iterdir())) == 3


def test_cli_workspace_accepts_directory(tmp_path, monkeypatch, capsys):
    """`migrate --to-store --workspace <dir>` treats the dir as the ws."""
    import sys

    from klanker import __main__ as cli

    ws = _ws(tmp_path)
    (ws / "memory" / "N.md").write_text("# n", encoding="utf-8")
    _cli_env(tmp_path, monkeypatch, ws)
    monkeypatch.setattr(
        sys, "argv",
        ["klanker", "migrate", "--to-store", "--workspace", str(ws)])
    rc = cli.main()
    assert rc in (0, None)
    assert (ws / "store.db").is_file()


def test_cli_workspace_unknown_id_errors(tmp_path, monkeypatch, capsys):
    from klanker import __main__ as cli

    ws = _ws(tmp_path)
    _cli_env(tmp_path, monkeypatch, ws)
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    assert cli.main(
        ["migrate", "--to-store", "--workspace", "no-such-ws"]) == 2
    assert "unknown workspace" in capsys.readouterr().err


def test_render_memory_projection(tmp_path):
    from klanker.migrate import (GENERATED_MARKER, project_memory,
                                 render_memory_projection)

    ws = _ws(tmp_path)
    (ws / "memory" / "A.md").write_text("# Alpha\n\n- fact one", encoding="utf-8")
    conn = connect(ws / "store.db")
    try:
        project_memory(conn, ws, node="h")
        stats = render_memory_projection(conn, ws)
        assert stats["written"] == 1
        out = ws / "memory" / "projection" / "A.md"
        text = out.read_text(encoding="utf-8")
        assert GENERATED_MARKER in text
        assert "fact one" in text
        # idempotent second render
        assert render_memory_projection(conn, ws)["unchanged"] == 1
        # projection never feeds back through project_memory
        stats = project_memory(conn, ws, node="h")
        assert stats["projected"] == 0
    finally:
        conn.close()


def test_projection_skips_marker_files(tmp_path):
    from klanker.migrate import GENERATED_MARKER, migrate_to_store

    ws = _ws(tmp_path)
    (ws / "memory" / "gen.md").write_text(f"{GENERATED_MARKER}\n\n# g", encoding="utf-8")
    (ws / "memory" / "real.md").write_text("# real", encoding="utf-8")
    stats = migrate_to_store(ws)
    assert stats["memory"]["imported"] == 1
    blob = _blob(ws)
    assert "mem:gen" not in blob


# -- klanker#155 (R11) oracles ------------------------------------------------

def test_redact_text_quoted_value_with_trailing_comment():
    """Oracle: `api_key: "sec" # comment` redacts — a quoted value with
    a trailing comment must not slip past the whitespace check."""
    from klanker.migrate import REDACTED, redact_text

    for text in ('api_key: "sec" # comment',
                 "api_key: 'sec' # rotated",
                 'client_secret = "abc123XYZ"   # prod'):
        red, n = redact_text(text)
        assert n >= 1, text
        assert "#" not in red  # trailing comment folds into the marker
        assert REDACTED in red
        # the quoted credential is gone
        for leak in ('"sec"', "'sec'", "abc123XYZ"):
            assert leak not in red


def test_import_ords_are_node_qualified_hlc(tmp_path):
    """Import datoms carry real ``<ms>.<ctr>.<node>`` ords — the old
    synthetic ``*.import`` suffix collided across hosts (klanker#155)."""
    from agents_store.hlc import is_hlc

    ws = _ws(tmp_path)
    (ws / "memory" / "A.md").write_text("# A", encoding="utf-8")
    migrate_to_store(ws, node="hostA")
    conn = connect(ws / "store.db")
    try:
        ords = [r[0] for r in conn.execute("SELECT ord FROM datom")]
        assert ords
        for o in ords:
            assert is_hlc(o), o
            assert o.rsplit(".", 1)[-1] == "hostA"
    finally:
        conn.close()


def test_deleted_memory_file_retracts_and_projection_removes(tmp_path):
    """A deleted memory file retracts its mem:* datoms (host-scoped) and
    the generated projection file is removed on the same run."""
    ws = _ws(tmp_path)
    note = ws / "memory" / "gone.md"
    note.write_text("# gone\n\n- fact", encoding="utf-8")
    stats = migrate_to_store(ws, node="h1")
    assert stats["memory"]["imported"] == 1
    proj = ws / "memory" / "projection" / "gone.md"
    assert stats["projection"]["written"] == 1
    assert proj.is_file()

    note.unlink()
    stats = migrate_to_store(ws, node="h1")
    assert stats["memory"]["retracted"] == 1
    conn = connect(ws / "store.db")
    try:
        rows = conn.execute(
            "SELECT e, a, v FROM v_current WHERE e = 'mem:gone'"
        ).fetchall()
        assert rows == []
    finally:
        conn.close()
    assert stats["projection"]["removed"] == 1
    assert not proj.exists()


def test_memory_entity_of_other_host_never_retracted(tmp_path):
    """A mem entity another host imported must survive this host's scan
    even when the file never existed on this disk."""
    ws = _ws(tmp_path)
    note = ws / "memory" / "shared.md"
    note.write_text("# shared", encoding="utf-8")
    migrate_to_store(ws, node="peerB")   # peerB owns the import
    note.unlink()
    stats = migrate_to_store(ws, node="h1")  # this host never owned it
    assert stats["memory"]["retracted"] == 0
    conn = connect(ws / "store.db")
    try:
        n = conn.execute(
            "SELECT COUNT(*) FROM v_current WHERE e = 'mem:shared'"
        ).fetchone()[0]
        assert n > 0
    finally:
        conn.close()


def test_memory_import_stamps_mem_host(tmp_path):
    ws = _ws(tmp_path)
    (ws / "memory" / "A.md").write_text("# A", encoding="utf-8")
    migrate_to_store(ws, node="h1")
    conn = connect(ws / "store.db")
    try:
        v = conn.execute(
            "SELECT v FROM v_current WHERE e = 'mem:A' AND a = 'mem:host'"
        ).fetchone()
        assert v and v[0] == "h1"
    finally:
        conn.close()
