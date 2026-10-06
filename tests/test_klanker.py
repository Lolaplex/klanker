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
        self.assertIn("runtimes", summary)
        self.assertIn("suite_modules", summary)
        self.assertTrue(hasattr(caps, "has_git"))

    def test_nucleus_sense(self):
        n = Nucleus()
        sense = n.sense()
        self.assertIsInstance(sense, dict)
        self.assertIn("python_version", sense)

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
        self.assertNotIn("Execute directly", text)
        self.assertIn("NO_UPDATE", text)
        self.assertIn("untrusted", text)
        self.assertIn("Alles läuft lokal", text)
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
        with patch("subprocess.run") as mock_run:
            n.run_turn(message="test message", seal=True)
            self.assertTrue(mock_run.called)
            cmd = mock_run.call_args[0][0]
            self.assertIn("--seal", cmd)
            self.assertIn("klanker.turn", cmd)


if __name__ == "__main__":
    unittest.main()
