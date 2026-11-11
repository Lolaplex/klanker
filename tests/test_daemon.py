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
                 patch("subprocess.run") as run, \
                 patch("time.sleep", return_value=None):
                rc = daemon.stop_daemon("http://127.0.0.1:8787")
            self.assertEqual(rc, 0)
            self.assertFalse(pid_file.exists())
            run.assert_called_once()
            self.assertIn("5555", run.call_args[0][0])

    def test_stop_daemon_no_pidfile(self):
        with patch.object(daemon, "daemon_pid_path", return_value=Path("nope.pid")):
            self.assertEqual(daemon.stop_daemon(), 1)

    def test_pid_path_per_host(self):
        """Two AGENTS_HOST_DIR values -> two independent pid files (C41)."""
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            h1 = Path(td) / "h1"
            h2 = Path(td) / "h2"
            with patch.dict(os.environ, {"AGENTS_HOST_DIR": str(h1)}):
                p1 = daemon.daemon_pid_path()
            with patch.dict(os.environ, {"AGENTS_HOST_DIR": str(h2)}):
                p2 = daemon.daemon_pid_path()
        self.assertNotEqual(p1, p2)
        self.assertEqual(p1, h1 / "run" / "serve.pid")
        self.assertEqual(p2, h2 / "run" / "serve.pid")

    def test_stop_daemon_reads_legacy_pid_once(self):
        """Legacy ~/.klanker/daemon.pid still stops, with one warning."""
        import tempfile
        import warnings
        with tempfile.TemporaryDirectory() as td:
            legacy = Path(td) / "daemon.pid"
            legacy.write_text("7777")
            daemon._legacy_pid_warned = False
            with patch.object(
                daemon, "daemon_pid_path", return_value=Path(td) / "new.pid"
            ), patch.object(
                daemon, "_legacy_pid_path", return_value=legacy
            ), patch.object(
                daemon, "relay_health", return_value=False
            ), patch("subprocess.run") as run, patch(
                "time.sleep", return_value=None
            ), warnings.catch_warnings(record=True) as seen:
                warnings.simplefilter("always")
                rc = daemon.stop_daemon("http://127.0.0.1:8787")
        self.assertEqual(rc, 0)
        self.assertFalse(legacy.exists())
        run.assert_called_once()
        self.assertTrue(
            any("agents-workspace migrate" in str(w.message) for w in seen)
        )

    def test_stop_daemon_posix_signals_process_group(self):
        """POSIX stop signals the daemon's process group, not just the pid
        (C42: no orphan loop child)."""
        import os
        import signal
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            pid_file = Path(td) / "daemon.pid"
            pid_file.write_text("4242")
            calls = []
            none_pid = Path(td) / "none"
            fake_os = patch.object(daemon.os, "name", "posix")
            real_kill = daemon.os.kill
            with fake_os, patch.object(
                daemon, "daemon_pid_path", return_value=pid_file
            ), patch.object(
                daemon, "_legacy_pid_path", return_value=none_pid
            ), patch.object(
                daemon.os, "killpg",
                create=True,
                side_effect=lambda pgid, sig: calls.append(("killpg", pgid, sig)),
            ), patch.object(
                daemon.os, "getpgid",
                create=True,
                side_effect=lambda pid: pid + 1000,
            ), patch.object(
                daemon.os, "kill",
                side_effect=ProcessLookupError,
            ), patch.object(
                daemon, "relay_health", return_value=False
            ), patch("time.sleep", return_value=None):
                rc = daemon.stop_daemon("http://127.0.0.1:8787")
        self.assertEqual(rc, 0)
        self.assertIn(("killpg", 5242, signal.SIGTERM), calls)


if __name__ == "__main__":
    unittest.main()
