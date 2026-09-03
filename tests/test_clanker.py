"""Unit tests for Clanker nucleus, sensing, and CLI."""

import unittest
from clanker.sensing import probe_host, HostCapabilities
from clanker.morph import synthesize_schedule
from clanker.nucleus import Nucleus
from clanker.__main__ import build_parser


class TestClanker(unittest.TestCase):
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
        from clanker.__main__ import parse_cli_args
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


if __name__ == "__main__":


    unittest.main()
