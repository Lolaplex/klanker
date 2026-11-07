"""Daemon lifecycle: ensure/spawn/stop semantics for bare `klanker`."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from klanker import daemon


class _FakeProc:
    def __init__(self, pid=4321, exit_code=None):
        self.pid = pid
        self._exit_code = exit_code

    def poll(self):
        return self._exit_code


class DaemonTests(unittest.TestCase):
    def test_is_loopback(self):
        self.assertTrue(daemon._is_loopback("http://127.0.0.1:8787"))
        self.assertTrue(daemon._is_loopback("http://localhost:8787"))
        self.assertFalse(daemon._is_loopback("https://pvs.tailnet.ts.net"))
        self.assertFalse(daemon._is_loopback("http://192.168.1.5:8787"))

    def test_ensure_daemon_skips_spawn_when_healthy(self):
        with patch.object(daemon, "relay_health", return_value=True), \
             patch.object(daemon, "_spawn_detached") as spawn:
            self.assertTrue(daemon.ensure_daemon("http://127.0.0.1:8787"))
        spawn.assert_not_called()

    def test_ensure_daemon_never_spawns_remote(self):
        with patch.object(daemon, "relay_health", return_value=False), \
             patch.object(daemon, "_spawn_detached") as spawn:
            self.assertFalse(
                daemon.ensure_daemon("https://pvs.tailnet.ts.net")
            )
        spawn.assert_not_called()

    def test_ensure_daemon_spawns_and_writes_pidfile(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            pid_file = Path(td) / "daemon.pid"
            health = iter([False, False, True])
            with patch.object(
                daemon, "relay_health", side_effect=lambda *a, **k: next(health)
            ), patch.object(
                daemon, "_spawn_detached", return_value=_FakeProc(pid=9876)
            ), patch.object(
                daemon, "daemon_pid_path", return_value=pid_file
            ), patch("time.sleep", return_value=None):
                self.assertTrue(daemon.ensure_daemon("http://127.0.0.1:8787"))
            self.assertEqual(pid_file.read_text().strip(), "9876")

    def test_ensure_daemon_returns_false_when_proc_dies(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            pid_file = Path(td) / "daemon.pid"
            with patch.object(daemon, "relay_health", return_value=False), \
                 patch.object(
                     daemon, "_spawn_detached",
                     return_value=_FakeProc(exit_code=1),
                 ), patch.object(
                     daemon, "daemon_pid_path", return_value=pid_file
                 ), patch("time.sleep", return_value=None):
                self.assertFalse(daemon.ensure_daemon("http://127.0.0.1:8787"))

    def test_release_pid_file_only_removes_own_pid(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            pid_file = Path(td) / "daemon.pid"
            pid_file.write_text("111")
            daemon.release_pid_file(pid_file, 222)
            self.assertTrue(pid_file.exists())
            daemon.release_pid_file(pid_file, 111)
            self.assertFalse(pid_file.exists())

    def test_stop_daemon_kills_pidfile_process(self):
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            pid_file = Path(td) / "daemon.pid"
            pid_file.write_text("5555")
            with patch.object(daemon, "daemon_pid_path", return_value=pid_file), \
                 patch.object(daemon, "relay_health", return_value=False), \
                 patch("os.kill") as kill, \
                 patch("time.sleep", return_value=None):
                rc = daemon.stop_daemon("http://127.0.0.1:8787")
            self.assertEqual(rc, 0)
            self.assertFalse(pid_file.exists())
            kill.assert_called_once()
            self.assertEqual(kill.call_args[0][0], 5555)

    def test_stop_daemon_no_pidfile(self):
        with patch.object(daemon, "daemon_pid_path", return_value=Path("nope.pid")):
            self.assertEqual(daemon.stop_daemon(), 1)


if __name__ == "__main__":
    unittest.main()
