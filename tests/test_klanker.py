"""Unit tests for Klanker nucleus, sensing, and CLI."""

import unittest
from klanker import __version__
from klanker.sensing import probe_host, HostCapabilities
from klanker.nucleus import Nucleus
from klanker.__main__ import build_parser


class TestKlanker(unittest.TestCase):
    def test_probe_host(self):
        caps = probe_host()
        self.assertIsInstance(caps, HostCapabilities)
        summary = caps.summary()
        self.assertIn("os_name", summary)
        self.assertIn("python_executable", summary)
        self.assertIn("runtimes", summary)
        self.assertIn("suite_modules", summary)
        self.assertTrue(bool(caps.python_executable))
        self.assertTrue(hasattr(caps, "has_git"))
        self.assertTrue(hasattr(caps, "has_sync"))
        self.assertIn("sync", caps.suite_modules)

    def test_nucleus_sense(self):
        n = Nucleus()
        sense = n.sense()
        self.assertIsInstance(sense, dict)
        self.assertIn("python_version", sense)
        self.assertIn("python_executable", sense)

    def test_cli_parser(self):
        from klanker.__main__ import parse_cli_args
        args, direct_prompt = parse_cli_args(["sense", "--json"])
        self.assertEqual(args.command, "sense")
        self.assertTrue(args.json)
        self.assertEqual(direct_prompt, "")

        # Direct prompt argument test
        args, direct_prompt = parse_cli_args(["Wer bist du?"])
        self.assertIsNone(args.command)
        self.assertEqual(direct_prompt, "Wer bist du?")

        # Empty prompt test (triggers REPL)
        args, direct_prompt = parse_cli_args([])
        self.assertIsNone(args.command)
        self.assertEqual(direct_prompt, "")

    def test_serve_no_auth_flag_and_token_autogen(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from klanker.__main__ import _maybe_generate_web_token, parse_cli_args

        args, _ = parse_cli_args(["serve", "--no-auth"])
        self.assertTrue(args.no_auth)
        args, _ = parse_cli_args(["serve"])
        self.assertFalse(args.no_auth)

        with tempfile.TemporaryDirectory() as td:
            fake_home = Path(td) / "home"
            fake_home.mkdir()
            env = {k: v for k, v in os.environ.items()
                   if k not in ("RELAY_WEB_TOKEN", "RELAY_NO_AUTH", "RELAY_HOST", "RELAY_PORT")}
            env["AGENTS_HOST_DIR"] = str(Path(td) / "host")
            with patch.dict(os.environ, env, clear=True), \
                 patch("pathlib.Path.home", return_value=fake_home):
                url = _maybe_generate_web_token(False)
                self.assertTrue(url.startswith("http://127.0.0.1:8787/?token="))
                self.assertTrue(os.environ["RELAY_WEB_TOKEN"])
                # second call: token already set, nothing new
                self.assertEqual(_maybe_generate_web_token(False), "")
                # explicit token respected
                os.environ["RELAY_WEB_TOKEN"] = "mine"
                self.assertEqual(_maybe_generate_web_token(False), "")
                # opt-out
                del os.environ["RELAY_WEB_TOKEN"]
                self.assertEqual(_maybe_generate_web_token(True), "")
                self.assertNotIn("RELAY_WEB_TOKEN", os.environ)
                os.environ["RELAY_NO_AUTH"] = "1"
                self.assertEqual(_maybe_generate_web_token(False), "")
                self.assertNotIn("RELAY_WEB_TOKEN", os.environ)

    def test_web_token_uses_host_vault_and_never_writes_klanker_dir(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from agents_workspace import Host, write_secret
        from agents_workspace.secrets import secrets_host_file
        from klanker.__main__ import _maybe_generate_web_token

        with tempfile.TemporaryDirectory() as td:
            fake_home = Path(td) / "home"
            fake_home.mkdir()
            host_dir = Path(td) / "host"
            base_env = {
                k: v for k, v in os.environ.items()
                if k not in ("RELAY_WEB_TOKEN", "RELAY_NO_AUTH", "RELAY_HOST", "RELAY_PORT")
            }
            base_env["AGENTS_HOST_DIR"] = str(host_dir)

            # 1. Fresh mint writes ONLY <host>/secrets/host.json, never ~/.klanker or <host>/secrets.json
            with patch.dict(os.environ, dict(base_env), clear=True), \
                 patch("pathlib.Path.home", return_value=fake_home):
                url = _maybe_generate_web_token(False)
                minted = os.environ["RELAY_WEB_TOKEN"]
                self.assertEqual(url, f"http://127.0.0.1:8787/?token={minted}")
            vault_path = secrets_host_file(Host.open(host_dir))
            self.assertTrue(vault_path.is_file())
            self.assertEqual(json.loads(vault_path.read_text(encoding="utf-8"))["RELAY_WEB_TOKEN"], minted)
            self.assertFalse((fake_home / ".klanker").exists())
            self.assertFalse((host_dir / "secrets.json").exists())

            # 2. Existing vault secret wins over legacy ~/.klanker/relay-secret
            write_secret("RELAY_WEB_TOKEN", "vault-token-abc", host=Host.open(host_dir), scope="host")
            legacy_pin = fake_home / ".klanker" / "relay-secret"
            legacy_pin.parent.mkdir(parents=True, exist_ok=True)
            legacy_pin.write_text("legacy-token-xyz\n", encoding="utf-8")
            with patch.dict(os.environ, dict(base_env), clear=True), \
                 patch("pathlib.Path.home", return_value=fake_home):
                url2 = _maybe_generate_web_token(False)
                self.assertEqual(url2, "http://127.0.0.1:8787/?token=vault-token-abc")
                self.assertEqual(os.environ["RELAY_WEB_TOKEN"], "vault-token-abc")
            self.assertEqual(legacy_pin.read_text(encoding="utf-8"), "legacy-token-xyz\n")

        # 3. Empty vault falls back read-only to ~/.klanker/relay-secret and persists to vault
        with tempfile.TemporaryDirectory() as td:
            fake_home = Path(td) / "home"
            host_dir = Path(td) / "host"
            legacy_pin = fake_home / ".klanker" / "relay-secret"
            legacy_pin.parent.mkdir(parents=True, exist_ok=True)
            legacy_pin.write_text("legacy-only-token\n", encoding="utf-8")
            env = {
                k: v for k, v in os.environ.items()
                if k not in ("RELAY_WEB_TOKEN", "RELAY_NO_AUTH", "RELAY_HOST", "RELAY_PORT")
            }
            env["AGENTS_HOST_DIR"] = str(host_dir)
            with patch.dict(os.environ, env, clear=True), \
                 patch("pathlib.Path.home", return_value=fake_home):
                url = _maybe_generate_web_token(False)
                self.assertEqual(url, "http://127.0.0.1:8787/?token=legacy-only-token")
                self.assertEqual(os.environ["RELAY_WEB_TOKEN"], "legacy-only-token")
            vault_path = secrets_host_file(Host.open(host_dir))
            self.assertEqual(
                json.loads(vault_path.read_text(encoding="utf-8"))["RELAY_WEB_TOKEN"],
                "legacy-only-token",
            )
            self.assertFalse((host_dir / "secrets.json").exists())

    def test_serve_command_writes_and_releases_serve_json(self):
        import json
        import os
        import sys
        import tempfile
        import types
        from pathlib import Path
        from unittest.mock import patch

        from agents_workspace import Host
        from klanker.__main__ import main as cli_main
        from klanker.sensing import HostCapabilities

        with tempfile.TemporaryDirectory() as td:
            fake_home = Path(td) / "home"
            fake_home.mkdir()
            host_dir = Path(td) / "host"
            Host.open(host_dir).create("default")
            state_file = host_dir / "run" / "serve.json"
            observed: dict[str, object] = {}

            def fake_relay_main(argv):
                observed["argv"] = argv
                observed["state"] = json.loads(state_file.read_text(encoding="utf-8"))
                return 0

            fake_relay_pkg = types.ModuleType("agents_relay")
            fake_relay_main_mod = types.ModuleType("agents_relay.__main__")
            fake_relay_main_mod.main = fake_relay_main
            fake_relay_pkg.__main__ = fake_relay_main_mod

            caps = HostCapabilities(
                os_name="test",
                is_tty=False,
                python_version="3.10.0",
                suite_modules={"relay": True, "harness": False},
                has_workspace=True,
            )
            env = {
                k: v for k, v in os.environ.items()
                if k not in ("RELAY_WEB_TOKEN", "RELAY_NO_AUTH", "AGENTS_WORKSPACE")
            }
            env.update({
                "AGENTS_HOST_DIR": str(host_dir),
                "RELAY_HOST": "127.0.0.1",
                "RELAY_PORT": "9123",
                "AGENTS_NO_UPDATE_CHECK": "1",
            })
            with patch.dict(os.environ, env, clear=True), \
                 patch("pathlib.Path.home", return_value=fake_home), \
                 patch("klanker.nucleus.probe_host", return_value=caps), \
                 patch("klanker.mgmt.install", return_value=True), \
                 patch.dict(sys.modules, {
                     "agents_relay": fake_relay_pkg,
                     "agents_relay.__main__": fake_relay_main_mod,
                 }):
                rc = cli_main(["serve", "--no-telegram"])
            self.assertEqual(rc, 0)
            self.assertEqual(observed["argv"], ["serve", "--no-telegram"])
            self.assertEqual(
                observed["state"],
                {"pid": os.getpid(), "port": 9123, "url": "http://127.0.0.1:9123"},
            )
            self.assertFalse(state_file.exists())
            self.assertFalse((fake_home / ".klanker").exists())

    def test_serve_stdout_redacts_token_when_non_tty_and_prints_when_tty(self):
        import io
        import os
        import sys
        import tempfile
        import types
        from contextlib import redirect_stdout
        from pathlib import Path
        from unittest.mock import patch

        from agents_workspace import Host
        from klanker.__main__ import main as cli_main
        from klanker.sensing import HostCapabilities

        class _FakeOut(io.StringIO):
            def __init__(self, tty: bool):
                super().__init__()
                self._tty = tty

            def isatty(self):
                return self._tty

        with tempfile.TemporaryDirectory() as td:
            fake_home = Path(td) / "home"
            fake_home.mkdir()
            host_dir = Path(td) / "host"
            Host.open(host_dir).create("default")

            fake_relay_pkg = types.ModuleType("agents_relay")
            fake_relay_main_mod = types.ModuleType("agents_relay.__main__")
            fake_relay_main_mod.main = lambda _argv: 0
            fake_relay_pkg.__main__ = fake_relay_main_mod

            caps = HostCapabilities(
                os_name="test",
                is_tty=False,
                python_version="3.10.0",
                suite_modules={"relay": True, "harness": False},
                has_workspace=True,
            )
            base_env = {
                k: v for k, v in os.environ.items()
                if k not in ("RELAY_WEB_TOKEN", "RELAY_NO_AUTH", "AGENTS_WORKSPACE")
            }
            base_env.update({
                "AGENTS_HOST_DIR": str(host_dir),
                "RELAY_HOST": "127.0.0.1",
                "RELAY_PORT": "9124",
                "AGENTS_NO_UPDATE_CHECK": "1",
            })

            non_tty = _FakeOut(False)
            with patch.dict(os.environ, dict(base_env), clear=True), \
                 patch("pathlib.Path.home", return_value=fake_home), \
                 patch("klanker.nucleus.probe_host", return_value=caps), \
                 patch("klanker.mgmt.install", return_value=True), \
                 patch.dict(sys.modules, {
                     "agents_relay": fake_relay_pkg,
                     "agents_relay.__main__": fake_relay_main_mod,
                 }), \
                 redirect_stdout(non_tty):
                rc = cli_main(["serve", "--no-telegram"])
            self.assertEqual(rc, 0)
            self.assertNotIn("?token=", non_tty.getvalue())
            self.assertIn("token stored in host vault", non_tty.getvalue())

            # Remove minted token env override before re-running on TTY to verify print behavior.
            tty_out = _FakeOut(True)
            (host_dir / "secrets" / "host.json").unlink(missing_ok=True)
            with patch.dict(os.environ, dict(base_env), clear=True), \
                 patch("pathlib.Path.home", return_value=fake_home), \
                 patch("klanker.nucleus.probe_host", return_value=caps), \
                 patch("klanker.mgmt.install", return_value=True), \
                 patch.dict(sys.modules, {
                     "agents_relay": fake_relay_pkg,
                     "agents_relay.__main__": fake_relay_main_mod,
                 }), \
                 redirect_stdout(tty_out):
                rc = cli_main(["serve", "--no-telegram"])
            self.assertEqual(rc, 0)
            self.assertIn("?token=", tty_out.getvalue())

    def test_send_verb_quotes_text(self):
        from klanker.remind import build_send_verb

        verb = build_send_verb("12345", 'hello "world"', channel="telegram")
        self.assertTrue(verb.startswith("python -m agents_relay send"))
        self.assertIn("--user", verb)
        self.assertIn("12345", verb)
        self.assertNotIn("runner.loop", verb)
        local = build_send_verb("anonymous", "hello", channel="http")
        self.assertNotIn("agents_relay", local)
        self.assertIn("hello", local)

    def test_prompt_uses_clock_as_calendar(self):
        from klanker.prompt import build_system_prompt
        from klanker.sensing import probe_host

        text = build_system_prompt(probe_host())
        self.assertIn("clock is the calendar", text)
        self.assertIn(f"v{__version__}", text)
        self.assertNotIn("v0.0.1", text)
        self.assertNotIn("klanker[memory]", text)
        self.assertNotIn("pip install agents-memory", text)
        self.assertNotIn("Execute directly", text)
        self.assertIn("NO_UPDATE", text)
        self.assertIn("untrusted", text)
        self.assertIn("Alles läuft lokal", text)
        self.assertIn("Autonomous Self-Equipping", text)
        self.assertIn("Python executable:", text)
        self.assertNotIn("slimemold", text.lower())
        self.assertNotIn("Slimemold", text)
        self.assertIn("human prose", text)
        self.assertIn("`fact`", text)
        self.assertIn("TraceStore", text)
        self.assertIn("mcp.traces.audit", text)

    def test_cli_parser_audit_and_seal(self):
        from klanker.__main__ import parse_cli_args

        args, direct_prompt = parse_cli_args(["audit", "ses_123", "--json"])
        self.assertEqual(args.command, "audit")
        self.assertEqual(args.target, "ses_123")
        self.assertTrue(args.json)

        args, direct_prompt = parse_cli_args(["chat", "hello", "--seal"])
        self.assertEqual(args.command, "chat")
        self.assertEqual(args.message, "hello")
        self.assertTrue(args.seal)

    def test_nucleus_run_turn_seal_arg(self):
        from unittest.mock import patch
        from klanker.sensing import HostCapabilities

        caps = HostCapabilities(
            os_name="Linux",
            is_tty=False,
            python_version="3.10.0",
            suite_modules={"harness": True},
        )
        n = Nucleus(caps=caps)
        with patch("klanker.nucleus.probe_host", return_value=caps), patch("subprocess.run") as mock_run:
            n.run_turn(message="test message", seal=True)
            self.assertTrue(mock_run.called)
            cmd = mock_run.call_args[0][0]
            self.assertIn("--seal", cmd)
            self.assertIn("klanker.turn", cmd)


if __name__ == "__main__":
    unittest.main()
