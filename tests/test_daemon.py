"""Daemon lifecycle: ensure/spawn/stop semantics for bare `klanker`."""

import json
import os
import tempfile
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

    def test_ensure_daemon_spawns_and_writes_serve_json(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "run" / "serve.json"
            health = iter([False, False, True])
            with patch.object(
                daemon, "relay_health", side_effect=lambda *a, **k: next(health)
            ), patch.object(
                daemon, "discover_live_serve", return_value=None
            ), patch.object(
                daemon, "_spawn_detached", return_value=_FakeProc(pid=9876)
            ), patch.object(
                daemon, "serve_state_path", return_value=state_file
            ), patch("time.sleep", return_value=None):
                self.assertTrue(daemon.ensure_daemon("http://127.0.0.1:8787/"))
            data = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertEqual(data["pid"], 9876)
            self.assertEqual(data["port"], 8787)
            self.assertEqual(data["url"], "http://127.0.0.1:8787")
            self.assertIn("host_id", data)

    def test_ensure_daemon_parses_custom_and_default_port(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "run" / "serve.json"
            with patch.object(
                daemon, "relay_health", side_effect=[False, True, False, True]
            ), patch.object(
                daemon, "discover_live_serve", return_value=None
            ), patch.object(
                daemon, "_spawn_detached", return_value=_FakeProc(pid=2468)
            ), patch.object(
                daemon, "serve_state_path", return_value=state_file
            ), patch("time.sleep", return_value=None):
                self.assertTrue(daemon.ensure_daemon("http://127.0.0.1:9123"))
                custom = json.loads(state_file.read_text(encoding="utf-8"))
                self.assertEqual(custom["port"], 9123)
                self.assertEqual(custom["url"], "http://127.0.0.1:9123")

                self.assertTrue(daemon.ensure_daemon("http://localhost"))
                defaulted = json.loads(state_file.read_text(encoding="utf-8"))
                self.assertEqual(defaulted["port"], 8787)
                self.assertEqual(defaulted["url"], "http://localhost")

    def test_ensure_daemon_returns_false_when_proc_dies(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "run" / "serve.json"
            with patch.object(daemon, "relay_health", return_value=False), \
                 patch.object(
                     daemon, "_spawn_detached",
                     return_value=_FakeProc(exit_code=1),
                 ), patch.object(
                     daemon, "serve_state_path", return_value=state_file
                 ), patch("time.sleep", return_value=None):
                self.assertFalse(daemon.ensure_daemon("http://127.0.0.1:8787"))

    def test_discover_live_serve_accepts_same_host_on_any_port(self):
        """klanker#126: serve.json url + /health host_id match -> live url."""
        import io
        import urllib.request
        with tempfile.TemporaryDirectory() as td:
            from agents_workspace import Host

            host = Host(dir=Path(td) / "host")
            host.host_id()
            host.run.mkdir(parents=True, exist_ok=True)
            (host.run / "serve.json").write_text(
                json.dumps(
                    {
                        "pid": 111,
                        "port": 19123,
                        "url": "http://127.0.0.1:19123",
                        "host_id": host.host_id(),
                    }
                ),
                encoding="utf-8",
            )

            class _Resp:
                status = 200

                def read(self):
                    return json.dumps({"host_id": host.host_id()}).encode()

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

            with patch.object(
                daemon.urllib.request, "urlopen", return_value=_Resp()
            ) as opener:
                self.assertEqual(
                    daemon.discover_live_serve(host), "http://127.0.0.1:19123"
                )
                opener.assert_called_once()
                self.assertIn("/health", opener.call_args[0][0])

    def test_discover_live_serve_rejects_foreign_host_id(self):
        """Falsifying: host_id mismatch -> None, never attach foreign serve."""
        with tempfile.TemporaryDirectory() as td:
            from agents_workspace import Host

            host = Host(dir=Path(td) / "host")
            host.host_id()
            host.run.mkdir(parents=True, exist_ok=True)
            (host.run / "serve.json").write_text(
                json.dumps(
                    {
                        "pid": 111,
                        "port": 19123,
                        "url": "http://127.0.0.1:19123",
                        "host_id": "other-host",
                    }
                ),
                encoding="utf-8",
            )

            class _Resp:
                status = 200

                def read(self):
                    return b'{"host_id": "other-host"}'

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

            with patch.object(daemon.urllib.request, "urlopen", return_value=_Resp()):
                self.assertIsNone(daemon.discover_live_serve(host))

    def test_discover_live_serve_none_without_state_or_health(self):
        with tempfile.TemporaryDirectory() as td:
            from agents_workspace import Host

            host = Host(dir=Path(td) / "host")
            self.assertIsNone(daemon.discover_live_serve(host))
            host.run.mkdir(parents=True, exist_ok=True)
            (host.run / "serve.json").write_text(
                json.dumps(
                    {"pid": 1, "port": 9, "url": "http://127.0.0.1:9"}
                ),
                encoding="utf-8",
            )
            with patch.object(
                daemon.urllib.request, "urlopen", side_effect=OSError("down")
            ):
                self.assertIsNone(daemon.discover_live_serve(host))

    def test_ensure_daemon_reuses_live_serve_without_spawn(self):
        """klanker#126: a running same-host serve on :19123 must not spawn."""
        with patch.object(
            daemon, "discover_live_serve", return_value="http://127.0.0.1:19123"
        ), patch.object(daemon, "_spawn_detached") as spawn:
            self.assertEqual(
                daemon.ensure_daemon("http://127.0.0.1:8787"),
                "http://127.0.0.1:19123",
            )
        spawn.assert_not_called()

    def test_release_pid_file_only_removes_own_pid(self):
        with tempfile.TemporaryDirectory() as td:
            plain_file = Path(td) / "serve.pid"
            plain_file.write_text("111", encoding="utf-8")
            daemon.release_pid_file(plain_file, 222)
            self.assertTrue(plain_file.exists())
            daemon.release_pid_file(plain_file, 111)
            self.assertFalse(plain_file.exists())

            json_file = Path(td) / "serve.json"
            json_file.write_text(
                json.dumps({"pid": 333, "port": 8787, "url": "http://127.0.0.1:8787"}),
                encoding="utf-8",
            )
            daemon.release_pid_file(json_file, 444)
            self.assertTrue(json_file.exists())
            daemon.release_pid_file(json_file, 333)
            self.assertFalse(json_file.exists())

    def test_stop_daemon_kills_serve_json_process(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "serve.json"
            state_file.write_text(
                json.dumps({"pid": 5555, "port": 8787, "url": "http://127.0.0.1:8787"}),
                encoding="utf-8",
            )
            with patch.object(daemon, "serve_state_path", return_value=state_file), \
                 patch.object(daemon, "_legacy_host_pid_path", return_value=Path(td) / "none.pid"), \
                 patch.object(daemon, "_legacy_pid_path", return_value=Path(td) / "none2.pid"), \
                 patch.object(daemon, "relay_health", return_value=False), \
                 patch("subprocess.run") as run, \
                 patch("time.sleep", return_value=None):
                rc = daemon.stop_daemon("http://127.0.0.1:8787")
            self.assertEqual(rc, 0)
            self.assertFalse(state_file.exists())
            if os.name == "nt":
                run.assert_called_once()
                self.assertIn("5555", run.call_args[0][0])
            else:
                run.assert_not_called()

    def test_stop_daemon_no_pidfile(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(daemon, "serve_state_path", return_value=Path(td) / "nope.json"), \
                 patch.object(daemon, "_legacy_host_pid_path", return_value=Path(td) / "nope.pid"), \
                 patch.object(daemon, "_legacy_pid_path", return_value=Path(td) / "nope2.pid"):
                self.assertEqual(daemon.stop_daemon(), 1)

    def test_pid_and_log_paths_per_host(self):
        """Two AGENTS_HOST_DIR values -> two independent serve state and log files (C41)."""
        with tempfile.TemporaryDirectory() as td:
            h1 = Path(td) / "h1"
            h2 = Path(td) / "h2"
            with patch.dict(os.environ, {"AGENTS_HOST_DIR": str(h1)}):
                s1 = daemon.serve_state_path()
                p1 = daemon.daemon_pid_path()
                l1 = daemon.serve_log_path()
            with patch.dict(os.environ, {"AGENTS_HOST_DIR": str(h2)}):
                s2 = daemon.serve_state_path()
                p2 = daemon.daemon_pid_path()
                l2 = daemon.serve_log_path()
        self.assertNotEqual(s1, s2)
        self.assertEqual(s1, h1 / "run" / "serve.json")
        self.assertEqual(p1, s1)
        self.assertEqual(l1, h1 / "logs" / "serve.log")
        self.assertEqual(s2, h2 / "run" / "serve.json")
        self.assertEqual(p2, s2)
        self.assertEqual(l2, h2 / "logs" / "serve.log")

    def test_read_pid_precedence_and_legacy_fallbacks(self):
        """serve.json > <host>/run/serve.pid > ~/.klanker/daemon.pid."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            state_json = root / "run" / "serve.json"
            host_pid = root / "run" / "serve.pid"
            klanker_pid = root / "daemon.pid"
            state_json.parent.mkdir(parents=True, exist_ok=True)
            klanker_pid.write_text("1001", encoding="utf-8")
            with patch.object(daemon, "serve_state_path", return_value=state_json), \
                 patch.object(daemon, "_legacy_host_pid_path", return_value=host_pid), \
                 patch.object(daemon, "_legacy_pid_path", return_value=klanker_pid):
                daemon._legacy_pid_warned = False
                self.assertEqual(daemon._read_pid(), 1001)
                host_pid.write_text("2002", encoding="utf-8")
                self.assertEqual(daemon._read_pid(), 2002)
                state_json.write_text("3003", encoding="utf-8")
                self.assertEqual(daemon._read_pid(), 3003)
                state_json.write_text(json.dumps({"pid": 4004, "port": 8787}), encoding="utf-8")
                self.assertEqual(daemon._read_pid(), 4004)

    def test_stop_daemon_reads_legacy_pid_once(self):
        """Legacy ~/.klanker/daemon.pid still stops, with one warning."""
        import warnings
        with tempfile.TemporaryDirectory() as td:
            legacy = Path(td) / "daemon.pid"
            legacy.write_text("7777", encoding="utf-8")
            daemon._legacy_pid_warned = False
            with patch.object(
                daemon, "serve_state_path", return_value=Path(td) / "new.json"
            ), patch.object(
                daemon, "_legacy_host_pid_path", return_value=Path(td) / "new.pid"
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
        if os.name == "nt":
            run.assert_called_once()
        self.assertTrue(
            any("agents-workspace migrate" in str(w.message) for w in seen)
        )

    def test_stop_daemon_posix_signals_process_group(self):
        """POSIX stop signals the daemon's process group, not just the pid
        (C42: no orphan loop child)."""
        import signal
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "serve.json"
            state_file.write_text(
                json.dumps({"pid": 4242, "port": 8787, "url": "http://127.0.0.1:8787"}),
                encoding="utf-8",
            )
            calls = []
            none_pid = Path(td) / "none"
            fake_os = patch.object(daemon.os, "name", "posix")
            with fake_os, patch.object(
                daemon, "serve_state_path", return_value=state_file
            ), patch.object(
                daemon, "_legacy_host_pid_path", return_value=none_pid
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
        self.assertFalse(state_file.exists())
        self.assertIn(("killpg", 5242, signal.SIGTERM), calls)

    def test_no_autospawn_refuses_detach_and_ensure_daemon_returns_none(self):
        with patch.dict(os.environ, {"AGENTS_NO_AUTOSPAWN": "1"}), patch.object(
            daemon, "discover_live_serve", return_value=None
        ), patch.object(daemon, "relay_health", return_value=False):
            with self.assertRaises(RuntimeError):
                daemon._spawn_detached(["klanker", "serve"])
            self.assertIsNone(daemon.ensure_daemon("http://127.0.0.1:8787"))


if __name__ == "__main__":
    unittest.main()
