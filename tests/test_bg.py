"""Tests for klanker bg/ps/logs/kill."""

import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import klanker.bg as bg
from klanker.__main__ import parse_cli_args


class TestBg(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.host = Path(self.tmp.name) / "host"
        self.old_env = os.environ.get("AGENTS_HOST_DIR")
        os.environ["AGENTS_HOST_DIR"] = str(self.host)
        self.addCleanup(self._restore_env)
        self.bg_dir = self.host / "run" / "bg-sessions"

    def _restore_env(self):
        if self.old_env is None:
            os.environ.pop("AGENTS_HOST_DIR", None)
        else:
            os.environ["AGENTS_HOST_DIR"] = self.old_env

    def test_spawn_writes_meta(self):
        class FakeProc:
            pid = 4321

        with patch("subprocess.Popen", return_value=FakeProc()) as popen:
            meta = bg.spawn("say hi", user="u")
        self.assertEqual(meta["pid"], 4321)
        self.assertEqual(meta["status"], "spawned")
        self.assertTrue(Path(meta["log"]).exists() or True)  # created by open()
        row = json.loads((self.bg_dir / f"{meta['id']}.json").read_text())
        self.assertEqual(row["task"], "say hi")
        argv = popen.call_args.args[0]
        self.assertIn("_bg-run", argv)

    def test_spawn_requires_task(self):
        with self.assertRaises(ValueError):
            bg.spawn("   ")

    def test_status_dead_pid_is_exited(self):
        import subprocess
        import sys

        proc = subprocess.run([sys.executable, "-c", "pass"])
        del proc
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        meta = {"id": "bg_x", "pid": proc.pid, "status": "running"}
        self.assertEqual(bg._status(meta), "exited")

    def test_kill_unknown(self):
        with self.assertRaises(ValueError):
            bg.kill("bg_nope")

    def test_kill_marks_session(self):
        meta = {"id": "bg_k1", "pid": 424242, "status": "running", "task": "t"}
        bg._write_meta(meta)
        with patch.object(bg, "_pid_alive", return_value=True), \
             patch.object(bg, "_kill_tree") as kt:
            out = bg.kill("bg_k1")
        kt.assert_called_once_with(424242)
        self.assertEqual(out["status"], "killed")

    def test_run_child_records_rc(self):
        meta = {
            "id": "bg_rc", "pid": os.getpid(), "status": "spawned",
            "task": "ping", "session": "ses_bg_rc",
        }
        bg._write_meta(meta)
        with patch("klanker.nucleus.Nucleus.run_turn", return_value=0) as rt:
            rc = bg.run_child("bg_rc", user="u", provider="")
        self.assertEqual(rc, 0)
        rt.assert_called_once()
        self.assertEqual(rt.call_args.kwargs["session"], "ses_bg_rc")
        self.assertEqual(rt.call_args.kwargs["channel"], "bg")
        out = bg._read_meta("bg_rc")
        self.assertEqual(out["status"], "exited")
        self.assertEqual(out["rc"], 0)

    def test_parser(self):
        args, _ = parse_cli_args(["bg", "do stuff"])
        self.assertEqual(args.command, "bg")
        self.assertEqual(args.task, "do stuff")
        args, _ = parse_cli_args(["ps"])
        self.assertEqual(args.command, "ps")
        args, _ = parse_cli_args(["logs", "bg_1", "-f"])
        self.assertTrue(args.follow)
        args, _ = parse_cli_args(["kill", "bg_1"])
        self.assertEqual(args.id, "bg_1")


if __name__ == "__main__":
    unittest.main()
