"""Entry routing: bare `klanker` on a TTY reaches the agent shell."""

import sys
import unittest
from unittest.mock import patch

import klanker.__main__ as cli


class _TtyStdin:
    def isatty(self):
        return True

    def read(self):
        return ""


class _PipeStdin:
    def __init__(self, data: str):
        self._data = data

    def isatty(self):
        return False

    def read(self):
        return self._data


class _FakeNucleus:
    def __init__(self):
        self.turns = []

    def run_turn(self, **kwargs):
        self.turns.append(kwargs)
        return 0


class ShellEntryTests(unittest.TestCase):
    def _patch_shell(self, calls):
        def fake_shell(**kwargs):
            calls.update(kwargs)
            return 0

        return patch(
            "klanker.shell.repl.loop.run_interactive_shell", side_effect=fake_shell
        )

    def test_bare_klanker_tty_routes_to_shell(self):
        calls = {}
        with self._patch_shell(calls), \
             patch.object(sys, "stdin", _TtyStdin()), \
             patch("klanker.overlay.ensure_default_overlay", return_value=None):
            rc = cli.main([])
        self.assertEqual(rc, 0)
        self.assertIn("user", calls)
        self.assertIn("provider", calls)

    def test_shell_subcommand_passes_flags(self):
        calls = {}
        with self._patch_shell(calls):
            rc = cli.main(
                [
                    "shell",
                    "--plain",
                    "--stream",
                    "--url",
                    "http://127.0.0.1:9999",
                    "--no-gateway",
                ]
            )
        self.assertEqual(rc, 0)
        self.assertTrue(calls["plain"])
        self.assertTrue(calls["stream"])
        self.assertEqual(calls["url"], "http://127.0.0.1:9999")
        self.assertTrue(calls["no_gateway"])

    def test_piped_stdin_still_runs_local_turn(self):
        nucleus = _FakeNucleus()
        with patch.object(cli, "Nucleus", return_value=nucleus), \
             patch.object(sys, "stdin", _PipeStdin("hello there")), \
             patch("klanker.overlay.ensure_default_overlay", return_value=None):
            rc = cli.main([])
        self.assertEqual(rc, 0)
        self.assertEqual(len(nucleus.turns), 1)
        self.assertEqual(nucleus.turns[0]["message"], "hello there")


if __name__ == "__main__":
    unittest.main()
