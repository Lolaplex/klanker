"""Scheduler, help-json overlays, approvals, and serve safety."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from klanker import __version__
from klanker.gating import apply_approval_env, telegram_refusal
from klanker.helpjson import (
    build_manifests,
    generate_overlays,
    harness_as_tool_names,
    is_read_verb,
    schema_from_usage,
)
from klanker.routine import (
    add_routine,
    claim_minute,
    harness_owns_tick_lock,
    is_no_update,
    list_routines,
    perform_routine,
    remove_routine,
    run_due_schedules,
    start_ticker,
    ticker_enabled,
    turn_timeout_sec,
    _send_to_user,
)
from klanker.shim import argv_from_schema, extend_schedule_argv


MEMORY_SPEC = {
    "name": "agents-memory",
    "commands": {
        "search": {
            "description": "Lexical search",
            "usage": "python -m agents_memory search QUERY [--project SLUG | --all]",
        },
        "delete": {
            "description": "Delete one hit",
            "usage": "python -m agents_memory delete MEMORY_ID",
        },
        "write": {
            "description": "Overwrite a file",
            "usage": "python -m agents_memory write FILE_ID [--file PATH]",
        },
        "related": {"description": "Follow refs", "usage": "python -m agents_memory related MEMORY_ID"},
        "inventory": {"description": "Compare roots", "usage": "python -m agents_memory inventory"},
        "serve": {"description": "browser", "usage": "python -m agents_memory serve"},
        "remote": {
            "description": "Cloud mirror",
            "usage": "python -m agents_memory remote",
            "subcommands": {
                "status": {"description": "status", "usage": "python -m agents_memory remote status"},
                "push": {"description": "publish", "usage": "python -m agents_memory remote push"},
            },
        },
    },
}

KEYS_SPEC = {
    "commands": {
        "mint": {"usage": "agents-keys mint SLUG", "description": "Write a key"},
        "did": {"usage": "agents-keys did SLUG", "description": "Print did:key"},
        "resolve": {"usage": "agents-keys resolve LOCATOR", "description": "Fetch did.json"},
        "sign": {"usage": "agents-keys sign SLUG NONCE", "description": "Sign"},
    }
}

RELAY_SPEC = {
    "commands": {
        "send": {
            "description": "Send one Telegram message",
            "flags": ["--user", "--text"],
        }
    }
}

TRACES_SPEC = {
    "command": "agents-traces",
    "description": "traces",
    "arguments": [
        {"dest": "help", "option_strings": ["-h", "--help"], "help": "show", "required": False}
    ],
}

VAND_SPEC = {
    "commands": [
        {
            "name": "replicate",
            "description": "Pin a source",
            "arguments": [{"name": "target", "dest": "target", "help": "clone", "required": True}],
            "options": [
                {
                    "dest": "force",
                    "flags": ["--force"],
                    "kind": "flag",
                    "help": "overwrite",
                    "required": False,
                }
            ],
        }
    ]
}

DOCS_SPEC = {
    "command": "agents-docs",
    "commands": [{"name": "list", "help": "List docsets"}, {"name": "search", "help": "BM25"}],
}


class TestHelpJson(unittest.TestCase):
    def test_read_verbs_and_usage_flags(self):
        self.assertTrue(is_read_verb("search"))
        self.assertTrue(is_read_verb("remote.status"))
        self.assertFalse(is_read_verb("delete"))
        schema = schema_from_usage("agents-calendar list [--calendar NAME] --from ISO --to ISO")
        props = schema["properties"]
        self.assertIn("from", props)
        self.assertEqual(props["from"]["x-cli"], "--from")
        self.assertIn("to", props)
        self.assertNotIn("iso", props)

    def test_shapes(self):
        memory = {row["name"]: row for row in build_manifests(MEMORY_SPEC, alias="memory", module="agents_memory")}
        self.assertIn("mcp.memory.delete", memory)
        self.assertTrue(memory["mcp.memory.delete"]["mutates"])
        self.assertFalse(memory["mcp.memory.search"]["mutates"])
        self.assertFalse(memory["mcp.memory.related"]["mutates"])
        self.assertFalse(memory["mcp.memory.inventory"]["mutates"])
        self.assertTrue(memory["mcp.memory.write"]["mutates"])
        self.assertNotIn("mcp.memory.serve", memory)
        self.assertFalse(memory["mcp.memory.remote.status"]["mutates"])
        self.assertTrue(memory["mcp.memory.remote.push"]["mutates"])
        self.assertIn("mcp.memory.argv", memory)
        self.assertIn("x-help-json", memory["mcp.memory.argv"]["parameters"])

        relay = build_manifests(RELAY_SPEC, alias="relay", module="agents_relay")
        send = next(row for row in relay if row["name"] == "mcp.relay.send")
        self.assertEqual(send["parameters"]["properties"]["text"]["x-cli"], "--text")
        self.assertEqual(iter_names(TRACES_SPEC, "traces", "agents_traces"), ["mcp.traces.argv"])

        vand = {row["name"]: row for row in build_manifests(VAND_SPEC, alias="vand", module="vand")}
        self.assertIn("mcp.vand.replicate", vand)
        self.assertEqual(vand["mcp.vand.replicate"]["parameters"]["properties"]["force"]["type"], "boolean")
        self.assertTrue(vand["mcp.vand.replicate"]["mutates"])

        docs = {row["name"]: row for row in build_manifests(DOCS_SPEC, alias="docs", module="agents_docs")}
        self.assertIn("mcp.docs.list", docs)
        self.assertFalse(docs["mcp.docs.list"]["mutates"])

    def test_keys_read_only_by_default(self):
        env = {k: v for k, v in os.environ.items() if k != "KLANKER_KEYS_WRITE"}
        with patch.dict(os.environ, env, clear=True):
            rows = build_manifests(KEYS_SPEC, alias="keys", module="agents_keys", read_only=True)
        names = {row["name"] for row in rows}
        self.assertIn("mcp.keys.did", names)
        self.assertIn("mcp.keys.resolve", names)
        self.assertNotIn("mcp.keys.mint", names)
        self.assertNotIn("mcp.keys.sign", names)
        self.assertNotIn("mcp.keys.argv", names)
        self.assertTrue(all(row["mutates"] is False for row in rows))

        with patch.dict(os.environ, {"KLANKER_KEYS_WRITE": "1"}):
            rows = build_manifests(KEYS_SPEC, alias="keys", module="agents_keys", read_only=True)
        names = {row["name"] for row in rows}
        self.assertIn("mcp.keys.mint", names)
        self.assertIn("mcp.keys.argv", names)
        mint = next(row for row in rows if row["name"] == "mcp.keys.mint")
        self.assertTrue(mint["mutates"])

    def test_hand_written_wins_and_generated_refreshes(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            hand = dest / "mcp.memory.delete.json"
            hand.write_text(json.dumps({"name": "mcp.memory.delete", "hand": True}), encoding="utf-8")
            packages = ({"alias": "memory", "module": "agents_memory", "read_only": False},)

            def fetch(module: str):
                return MEMORY_SPEC if module == "agents_memory" else None

            generate_overlays(dest, packages=packages, fetcher=fetch)
            self.assertTrue(json.loads(hand.read_text(encoding="utf-8"))["hand"])
            write = json.loads((dest / "mcp.memory.write.json").read_text(encoding="utf-8"))
            self.assertEqual(write["generated_by"], "klanker")
            self.assertTrue(write["mutates"])
            search = dest / "mcp.memory.search.json"
            if "mcp.memory.search" in harness_as_tool_names():
                self.assertFalse(search.exists())
            else:
                self.assertFalse(json.loads(search.read_text(encoding="utf-8"))["mutates"])

            stale = dest / "mcp.memory.write.json"
            stale.write_text(
                json.dumps({"name": "mcp.memory.write", "generated_by": "klanker", "old": True}),
                encoding="utf-8",
            )
            generate_overlays(dest, packages=packages, fetcher=fetch)
            self.assertNotIn("old", json.loads(stale.read_text(encoding="utf-8")))


def iter_names(spec, alias, module):
    return [row["name"] for row in build_manifests(spec, alias=alias, module=module)]


class TestShim(unittest.TestCase):
    def test_argv_from_schema(self):
        mod = {
            "name": "mcp.memory.delete",
            "parameters": {
                "type": "object",
                "properties": {
                    "memory_id": {"type": "string", "x-cli": "positional"},
                    "force": {"type": "boolean", "x-cli": "--force"},
                },
            },
        }
        self.assertEqual(
            argv_from_schema(mod, {"memory_id": "a.md:1", "force": True}),
            ["a.md:1", "--force"],
        )
        self.assertEqual(argv_from_schema(mod, {"argv": ["custom"]}), ["custom"])

    def test_schedule_prompt_is_forwarded(self):
        out = extend_schedule_argv(["--at", "+10m", "--text", "hi"], {"prompt": "scan", "timeout": 120})
        self.assertEqual(out, ["--at", "+10m", "--text", "hi", "--prompt", "scan", "--timeout", "120"])
        again = extend_schedule_argv(["--prompt", "scan"], {"prompt": "scan"})
        self.assertEqual(again.count("--prompt"), 1)


class TestRoutines(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._old = os.environ.get("AGENTS_SCHEDULES_DIR")
        os.environ["AGENTS_SCHEDULES_DIR"] = self.tmp.name

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AGENTS_SCHEDULES_DIR", None)
        else:
            os.environ["AGENTS_SCHEDULES_DIR"] = self._old
        self.tmp.cleanup()

    def test_add_list_remove(self):
        row = add_routine(
            name="morning",
            prompt="Scan the inbox",
            user="42",
            cron="0 8 * * *",
            timezone_name="Europe/Berlin",
        )
        self.assertEqual(row["session"], "routine:morning")
        self.assertEqual(row["kind"], "routine")
        self.assertIn("--scheduled", row["verb"])
        self.assertEqual(len(list_routines()), 1)
        self.assertTrue(remove_routine("morning"))
        self.assertEqual(list_routines(), [])

    def test_no_update_and_delivery(self):
        job = add_routine(name="pulse", prompt="check", user="7", at="2026-01-01T00:00:00Z")
        sent: list[str] = []

        def turn(_job):
            return 0, "NO_UPDATE"

        result = perform_routine(job, force=True, turn=turn, deliver=lambda user, text: sent.append(text))
        self.assertEqual(result["status"], "no_update")
        self.assertEqual(sent, [])

        job = add_routine(name="pulse2", prompt="check", user="7", cron="0 9 * * *")
        result = perform_routine(
            job,
            force=True,
            turn=lambda _job: (0, "Ship the notes"),
            deliver=lambda user, text: sent.append(f"{user}:{text}"),
        )
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(sent, ["7:Ship the notes"])
        self.assertTrue(is_no_update("NO_UPDATE\nstill quiet"))

    def test_same_minute_dedupe_and_retry_after_failure(self):
        job = add_routine(name="dedupe", prompt="check", user="7", cron="* * * * *")
        path = Path(job["_file"])
        calls = {"n": 0}

        def turn(_job):
            calls["n"] += 1
            return 0, "hello"

        perform_routine(job, force=False, turn=turn, deliver=lambda *_a: None)
        second = perform_routine(job, force=False, turn=turn, deliver=lambda *_a: None)
        self.assertEqual(calls["n"], 1)
        self.assertEqual(second["status"], "skipped")

        def fail(_job):
            calls["n"] += 1
            return 1, "boom"

        failed = perform_routine(job, force=True, turn=fail, deliver=lambda *_a: None)
        self.assertEqual(failed["status"], "failed")
        again = perform_routine(job, force=False, turn=turn, deliver=lambda *_a: None)
        self.assertEqual(again["status"], "delivered")
        self.assertTrue(path.is_file())

    def test_tick_lock_skips_when_held(self):
        import fcntl

        ran: list[int] = []
        lock = Path(self.tmp.name) / ".tick.lock"
        fh = open(lock, "a+b")
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            with patch("klanker.routine.harness_owns_tick_lock", return_value=False):
                self.assertFalse(run_due_schedules(lambda: ran.append(1)))
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            fh.close()
        self.assertEqual(ran, [])
        with patch("klanker.routine.harness_owns_tick_lock", return_value=False):
            self.assertTrue(run_due_schedules(lambda: ran.append(1)))
        self.assertEqual(ran, [1])

    def test_new_harness_skips_outer_lock(self):
        import fcntl
        import types

        ran: list[int] = []
        lock = Path(self.tmp.name) / ".tick.lock"
        fh = open(lock, "a+b")
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            with patch("klanker.routine.harness_owns_tick_lock", return_value=True):
                self.assertTrue(run_due_schedules(lambda: ran.append(1)))
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            fh.close()
        self.assertEqual(ran, [1])

        runner = types.ModuleType("runner")
        sched = types.ModuleType("runner.schedule")
        sched.register_routine_handler = lambda handler: handler
        runner.schedule = sched
        bare = types.ModuleType("runner.schedule")
        bare_runner = types.ModuleType("runner")
        bare_runner.schedule = bare
        with patch.dict("sys.modules", {"runner": runner, "runner.schedule": sched}):
            self.assertTrue(harness_owns_tick_lock())
        with patch.dict("sys.modules", {"runner": bare_runner, "runner.schedule": bare}):
            self.assertFalse(harness_owns_tick_lock())

    def test_timezone_defaults_and_turn_timeout(self):
        with patch.dict(os.environ, {"AGENTS_TIMEZONE": "Europe/Berlin", "TZ": "UTC"}):
            row = add_routine(name="zoned", prompt="p", user="1", cron="0 8 * * *")
        self.assertEqual(row["timezone"], "Europe/Berlin")
        self.assertEqual(turn_timeout_sec({"timeout_sec": 300}), 270)
        self.assertLess(turn_timeout_sec({"timeout_sec": 300}), 300)
        self.assertEqual(turn_timeout_sec({"timeout_sec": 10}), 9)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AGENTS_APPROVAL_TIMEOUT", None)
            os.environ.pop("AGENTS_APPROVAL_CMD", None)
            self.assertEqual(turn_timeout_sec({}), 615)

    def test_routine_timeout_outlasts_approval_wait(self):
        from klanker.__main__ import build_parser
        from klanker.gating import approval_wait_sec
        from klanker.remind import build_parser as remind_parser
        from klanker.routine import default_routine_timeout_sec

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AGENTS_APPROVAL_TIMEOUT", None)
            os.environ.pop("AGENTS_APPROVAL_CMD", None)
            wait = approval_wait_sec()
            self.assertEqual(wait, 315)
            default = default_routine_timeout_sec()
            self.assertEqual(default, 645)
            self.assertGreater(turn_timeout_sec({"timeout_sec": default}), wait)
            self.assertGreater(turn_timeout_sec({}), wait)
            row = add_routine(name="gated", prompt="p", user="1", cron="0 8 * * *")
            self.assertEqual(row["timeout_sec"], default)
            self.assertGreater(turn_timeout_sec(row), wait)
            args = build_parser().parse_args(["routine", "add", "--prompt", "p", "--user", "1", "--cron", "0 8 * * *"])
            self.assertIsNone(args.timeout_sec)
            self.assertIsNone(remind_parser().parse_args(["add", "--prompt", "p"]).timeout_sec)
            self.assertEqual(add_routine(name="short", prompt="p", user="1", cron="0 8 * * *", timeout_sec=120)["timeout_sec"], 120)
            out = extend_schedule_argv(["--at", "+10m"], {"prompt": "scan"})
            self.assertEqual(out[-2:], ["--timeout", str(default)])
            self.assertNotIn("--timeout", extend_schedule_argv(["--at", "+10m", "--text", "hi"], {}))
        with patch.dict(os.environ, {"AGENTS_APPROVAL_CMD": "notify --timeout 900"}):
            os.environ.pop("AGENTS_APPROVAL_TIMEOUT", None)
            self.assertEqual(approval_wait_sec(), 915)
            self.assertGreater(turn_timeout_sec({}), 915)
        with patch.dict(os.environ, {"AGENTS_APPROVAL_CMD": "notify", "AGENTS_APPROVAL_TIMEOUT": ""}):
            self.assertEqual(approval_wait_sec(), 330)
        with patch.dict(os.environ, {"AGENTS_APPROVAL_TIMEOUT": "1200"}):
            self.assertEqual(approval_wait_sec(), 1200)
            self.assertGreater(turn_timeout_sec({"timeout_sec": default_routine_timeout_sec()}), 1200)

    def test_harness_handler_keeps_minute_on_failure(self):
        job = add_routine(name="held", prompt="check", user="7", cron="* * * * *")
        calls = {"n": 0}

        def fail(_job):
            calls["n"] += 1
            return 1, "boom"

        failed = perform_routine(job, force=False, turn=fail, under_harness=True)
        self.assertEqual(failed["status"], "failed")
        again = perform_routine(
            job,
            force=False,
            turn=lambda _job: (0, "ok"),
            under_harness=True,
        )
        self.assertEqual(again["status"], "skipped")
        self.assertEqual(calls["n"], 1)

    def test_deliver_passes_allow_anyone(self):
        from types import SimpleNamespace

        captured: dict[str, object] = {}

        def send_to_user(*, token, chat_id, text, allowed, allow_anyone=False):
            captured["allow_anyone"] = allow_anyone
            captured["chat_id"] = chat_id

        cfg = SimpleNamespace(
            telegram_bot_token="t",
            telegram_allowed_chat_ids=(),
            allow_anyone=True,
        )
        _send_to_user(send_to_user, cfg, 7, "hi")
        self.assertIs(captured["allow_anyone"], True)

        def old_send(*, token, chat_id, text, allowed):
            captured["old"] = allowed

        _send_to_user(old_send, cfg, 7, "hi")
        self.assertEqual(captured["old"], ())

    def test_one_shot_removes_sidecars(self):
        job = add_routine(
            name="once",
            prompt="check",
            user="anonymous",
            at="2026-01-01T00:00:00Z",
            channel="http",
        )
        path = Path(job["_file"])
        result = perform_routine(job, force=True, turn=lambda _job: (0, "NO_UPDATE"))
        self.assertEqual(result["status"], "no_update")
        self.assertFalse(path.exists())
        self.assertFalse(path.with_name(path.name + ".last").exists())
        self.assertFalse(path.with_suffix(".lock").exists())

    def test_http_user_stays_local(self):
        job = add_routine(
            name="web",
            prompt="check",
            user="anonymous",
            cron="0 9 * * *",
            channel="http",
        )
        result = perform_routine(job, force=True, turn=lambda _job: (0, "hello from http"))
        self.assertEqual(result["status"], "local")
        self.assertEqual(job["channel"], "http")

    def test_routine_turn_uses_channel_and_detached_flag(self):
        from klanker.routine import default_turn

        job = add_routine(
            name="detached",
            prompt="check",
            user="anonymous",
            cron="0 9 * * *",
            channel="http",
        )
        captured: dict[str, list[str]] = {}

        def fake_run(cmd, **_kwargs):
            captured["cmd"] = list(cmd)
            return type("Proc", (), {"returncode": 0, "stdout": "ok"})()

        with patch("klanker.routine.loop_supports_detached_session", return_value=True):
            with patch("klanker.prompt.save_system_prompt", return_value=Path(self.tmp.name) / "prompt.txt"):
                with patch("klanker.sensing.probe_host", return_value=object()):
                    with patch("klanker.routine.subprocess.run", side_effect=fake_run):
                        default_turn(job)
        cmd = captured["cmd"]
        self.assertEqual(cmd[cmd.index("--channel") + 1], "http")
        self.assertEqual(cmd[cmd.index("--user") + 1], "anonymous")
        self.assertIn("--detached-session", cmd)

        captured.clear()
        with patch("klanker.routine.loop_supports_detached_session", return_value=False):
            with patch("klanker.prompt.save_system_prompt", return_value=Path(self.tmp.name) / "prompt.txt"):
                with patch("klanker.sensing.probe_host", return_value=object()):
                    with patch("klanker.routine.subprocess.run", side_effect=fake_run):
                        default_turn(job)
        self.assertNotIn("--detached-session", captured["cmd"])

    def test_ticker_runs_tick_on_a_worker_thread(self):
        import threading

        seen = threading.Event()
        names: list[str] = []

        def fake_run() -> bool:
            names.append(threading.current_thread().name)
            seen.set()
            return True

        with patch("klanker.routine.run_due_schedules", side_effect=fake_run):
            stop = start_ticker()
            self.assertIsNotNone(stop)
            self.assertTrue(seen.wait(2), "ticker did not start a worker")
            assert stop is not None
            stop.set()
        self.assertTrue(names)
        self.assertTrue(names[0].startswith("klanker-tick-run"))
        self.assertNotEqual(names[0], "klanker-tick")

    def test_ticker_disabled(self):
        with patch.dict(os.environ, {"KLANKER_TICK": "0"}):
            self.assertFalse(ticker_enabled())
            self.assertIsNone(start_ticker())

    def test_claim_minute_helper(self):
        path = Path(self.tmp.name) / "job.json"
        path.write_text("{}", encoding="utf-8")
        self.assertTrue(claim_minute(path, "2026-10-06T08:00", force=False))
        self.assertFalse(claim_minute(path, "2026-10-06T08:00", force=False))
        self.assertTrue(claim_minute(path, "2026-10-06T08:00", force=True))


class TestGatingAndDocs(unittest.TestCase):
    def test_telegram_refusal_and_approval_default(self):
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_ALLOWED_CHAT_IDS": ""}, clear=False):
            os.environ.pop("KLANKER_TELEGRAM_OPEN", None)
            os.environ.pop("AGENTS_APPROVAL_CMD", None)
            os.environ.pop("AGENTS_APPROVAL_MODE", None)
            self.assertIsNotNone(telegram_refusal(no_telegram=False))
            self.assertIsNone(telegram_refusal(no_telegram=True))
        with patch.dict(
            os.environ,
            {
                "TELEGRAM_BOT_TOKEN": "t",
                "TELEGRAM_ALLOWED_CHAT_IDS": "1",
                "KLANKER_TELEGRAM_OPEN": "",
            },
        ):
            os.environ.pop("AGENTS_APPROVAL_CMD", None)
            os.environ.pop("AGENTS_APPROVAL_MODE", None)
            self.assertIsNone(telegram_refusal(no_telegram=False))
            apply_approval_env(telegram=True)
            self.assertIn("{user}", os.environ["AGENTS_APPROVAL_CMD"])
            self.assertEqual(os.environ["AGENTS_APPROVAL_MODE"], "ask")
            os.environ["AGENTS_APPROVAL_MODE"] = "strict"
            apply_approval_env(telegram=True)
            self.assertEqual(os.environ["AGENTS_APPROVAL_MODE"], "strict")

    def test_open_opt_in(self):
        with patch.dict(
            os.environ,
            {"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_ALLOWED_CHAT_IDS": "", "KLANKER_TELEGRAM_OPEN": "1"},
        ):
            os.environ.pop("AGENTS_RELAY_ALLOW_ANYONE", None)
            self.assertIsNone(telegram_refusal(no_telegram=False))
            apply_approval_env(telegram=True)
            self.assertEqual(os.environ["AGENTS_RELAY_ALLOW_ANYONE"], "1")
            os.environ["AGENTS_RELAY_ALLOW_ANYONE"] = "0"
            apply_approval_env(telegram=True)
            self.assertEqual(os.environ["AGENTS_RELAY_ALLOW_ANYONE"], "0")

    def test_approval_follows_approver_not_only_telegram_poll(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TELEGRAM_BOT_TOKEN", None)
            os.environ.pop("AGENTS_RELAY_APPROVER", None)
            os.environ.pop("AGENTS_APPROVAL_CMD", None)
            os.environ.pop("AGENTS_APPROVAL_MODE", None)
            os.environ.pop("KLANKER_TELEGRAM_OPEN", None)
            apply_approval_env(telegram=False)
            self.assertNotIn("AGENTS_APPROVAL_CMD", os.environ)
        with patch.dict(
            os.environ,
            {
                "TELEGRAM_BOT_TOKEN": "t",
                "TELEGRAM_ALLOWED_CHAT_IDS": "",
                "AGENTS_RELAY_APPROVER": "42",
                "KLANKER_TELEGRAM_OPEN": "",
            },
        ):
            os.environ.pop("AGENTS_APPROVAL_CMD", None)
            os.environ.pop("AGENTS_APPROVAL_MODE", None)
            apply_approval_env(telegram=False)
            self.assertIn("{user}", os.environ["AGENTS_APPROVAL_CMD"])
            self.assertEqual(os.environ["AGENTS_APPROVAL_MODE"], "ask")

    def test_mcp_and_skills_sense(self):
        from klanker.config_sense import mcp_report, probe_server, skills_report
        from klanker.nucleus import Nucleus

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "mcp.json"
            cfg.write_text(
                json.dumps(
                    {
                        "mcpServers": {
                            "local": {"command": "definitely-missing-bin"},
                        }
                    }
                ),
                encoding="utf-8",
            )
            skill = root / "skills" / "demo"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("---\nname: demo\n---\n", encoding="utf-8")
            with patch.dict(os.environ, {"AGENTS_MCP_CONFIG": str(cfg), "AGENTS_SKILLS_DIR": str(root / "skills")}):
                report = mcp_report()
                self.assertEqual(report["mcp_servers"][0]["health"], "missing-command")
                self.assertEqual(
                    probe_server({"url": "http://example"}, open_url=lambda _url: None),
                    "ok",
                )
                self.assertEqual(
                    probe_server({"url": "http://example"}, open_url=lambda _url: (_ for _ in ()).throw(OSError("down"))),
                    "unreachable",
                )
                skills = skills_report()
                self.assertEqual(skills["skills"], ["demo"])
                sense = Nucleus().sense()
                self.assertIn("mcp_servers", sense)
                self.assertEqual(sense["skills"], ["demo"])

    def test_sense_expands_mcp_env(self):
        from klanker.config_sense import expand_env, probe_server

        seen: dict[str, str] = {}

        def open_url(url: str) -> None:
            seen["url"] = url

        with patch.dict(
            os.environ,
            {"SENSE_HOST": "probe.example", "SENSE_BIN": "klanker-bin", "SENSE_TOKEN": "sek"},
        ):
            os.environ.pop("UNSET_SENSE_VAR_ZZ", None)
            spec = expand_env(
                {
                    "command": "${SENSE_BIN}",
                    "args": ["--token", "${SENSE_TOKEN}"],
                    "env": {"TOKEN": "${SENSE_TOKEN}"},
                    "url": "https://${SENSE_HOST}/mcp",
                }
            )
            self.assertEqual(spec["command"], "klanker-bin")
            self.assertEqual(spec["args"], ["--token", "sek"])
            self.assertEqual(spec["env"]["TOKEN"], "sek")
            self.assertEqual(
                probe_server({"url": "https://${SENSE_HOST}/mcp"}, open_url=open_url),
                "ok",
            )
            self.assertEqual(seen["url"], "https://probe.example/mcp")
            self.assertEqual(
                probe_server(
                    {"command": "${SENSE_BIN}", "args": ["${SENSE_TOKEN}"]},
                    which=lambda cmd: "/bin/x" if cmd == "klanker-bin" else None,
                ),
                "ok",
            )
            self.assertEqual(probe_server({"command": "${UNSET_SENSE_VAR_ZZ}"}), "invalid")

    def test_docs_and_manifests(self):
        root = Path(__file__).resolve().parents[1]
        readme = (root / "README.md").read_text(encoding="utf-8")
        self.assertIn("klanker remind add", readme)
        self.assertNotIn("klanker remind <user>", readme)
        self.assertIn("klanker routine add", readme)
        self.assertIn(".tick.lock", readme)
        self.assertIn("mcp.json", readme)
        entry = (root / "entrypoint.sh").read_text(encoding="utf-8")
        self.assertNotIn("chmod 666", entry)
        self.assertIn(".agents/skills", entry)
        self.assertIn("dockerhost", entry)
        self.assertIn("AGENTS_MODULES_DIR", entry)
        self.assertNotIn("flocks the same", readme)
        docker = (root / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("agents-harness[mcp]", docker)
        self.assertIn("CACHE_BUST", docker)
        self.assertIn("SUITE_REF", docker)
        example_env = (root / ".env.example").read_text(encoding="utf-8")
        self.assertIn("# AGENTS_TIMEZONE=UTC", example_env)
        self.assertIn("# TZ=UTC", example_env)
        self.assertNotIn("Europe/Berlin", example_env)
        self.assertIn("AGENTS_VISION", example_env)
        self.assertIn("External schedulers", readme)
        self.assertNotIn("Coolify migration", readme)
        self.assertNotIn("Coolify", readme)
        schedule = json.loads((root / "src/klanker/modules/mcp.schedule.add.json").read_text(encoding="utf-8"))
        self.assertIs(schedule.get("approval_ask"), False)
        self.assertIn("channel", schedule["parameters"]["properties"])
        self.assertNotIn("Telegram chat id", json.dumps(schedule))
        self.assertIn("prompt", schedule["parameters"]["properties"])
        self.assertTrue(schedule["mutates"])
        self.assertFalse((root / "src/klanker/morph.py").exists())
        self.assertEqual(__version__, "0.1.0")
        example = json.loads((root / "examples/mcp.json").read_text(encoding="utf-8"))
        self.assertIn("mcpServers", example)

    def test_entrypoint_shell_syntax(self):
        import subprocess
        import sys

        root = Path(__file__).resolve().parents[1]
        proc = subprocess.run(["sh", "-n", str(root / "entrypoint.sh")], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(sys.executable)

    def test_modules_dir_and_loop_cmd_warning(self):
        import sys
        import types

        from klanker.__main__ import note_custom_loop_cmd
        from klanker.nucleus import Nucleus
        from klanker.sensing import HostCapabilities
        from klanker.turn import main as turn_main

        old = os.environ.pop("AGENTS_MODULES_DIR", None)
        try:
            loop = types.ModuleType("runner.loop")
            captured: dict[str, str | None] = {}

            def loop_main(argv: list[str]) -> int:
                captured["env"] = os.environ.get("AGENTS_MODULES_DIR")
                return 7

            loop.main = loop_main
            runner = types.ModuleType("runner")
            runner.loop = loop
            with patch.dict(sys.modules, {"runner": runner, "runner.loop": loop}):
                code = turn_main(["--message", "hi"])
            self.assertEqual(code, 7)
            self.assertTrue(captured["env"])

            caps = HostCapabilities(
                os_name="linux",
                is_tty=False,
                python_version="3.12",
                suite_modules={"harness": True},
            )
            os.environ.pop("AGENTS_MODULES_DIR", None)
            with patch("klanker.nucleus.subprocess.run") as run:
                run.return_value = types.SimpleNamespace(returncode=0)
                Nucleus(caps).run_turn(message="hi")
            self.assertTrue(os.environ.get("AGENTS_MODULES_DIR"))
        finally:
            if old is None:
                os.environ.pop("AGENTS_MODULES_DIR", None)
            else:
                os.environ["AGENTS_MODULES_DIR"] = old

        with patch.dict(os.environ, {"LOOP_CMD": "python -m runner.loop"}):
            with self.assertLogs("klanker", level="WARNING") as logs:
                note_custom_loop_cmd()
        self.assertTrue(any("bypasses" in line for line in logs.output))


if __name__ == "__main__":
    unittest.main()
