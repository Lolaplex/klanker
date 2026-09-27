"""Unit tests for Klanker nucleus, sensing, and CLI."""

import unittest
from klanker.sensing import probe_host, HostCapabilities
from klanker.morph import synthesize_schedule
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

    def test_synthesize_schedule(self):
        manifest = synthesize_schedule(
            name="test_flow",
            verb="python -m test",
            cadence="daily",
        )
        self.assertEqual(manifest["name"], "test_flow")
        self.assertEqual(manifest["expected_exit"], 0)

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

        verb = build_send_verb("12345", 'hello "world"')
        self.assertTrue(verb.startswith("python -m agents_relay send"))
        self.assertIn("--user", verb)
        self.assertIn("12345", verb)
        self.assertNotIn("runner.loop", verb)

    def test_prompt_uses_clock_as_calendar(self):
        from klanker.prompt import build_system_prompt
        from klanker.sensing import probe_host

        text = build_system_prompt(probe_host())
        self.assertIn("clock is the calendar", text)
        self.assertNotIn("slimemold", text.lower())
        self.assertNotIn("Slimemold", text)
        self.assertIn("human prose", text)
        self.assertIn("`fact`", text)


if __name__ == "__main__":
    unittest.main()
