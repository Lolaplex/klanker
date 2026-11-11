"""P2 gate (klanker#25): two equal personas, one workspace, separate sessions.

Proves over the CLI surface and over the relay HTTP surface:
- creating a workspace yields first persona ``default``
- two personas in one workspace get separate sessions (same user)
- sessions live under ``<ws>/personas/<p>/sessions/``
- no implicit default-persona privilege (equal personas)
"""
import json
import os
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

from agents_workspace import Host

from klanker import __main__ as cli


class _Relay:
    def __init__(self):
        from agents_relay.config import RelayConfig
        from agents_relay.http_adapter import serve_http

        cfg = RelayConfig(
            loop_cmd=("python", "-c", "print('skip')"),
            loop_provider="echo",
            relay_secret="expected",
            telegram_bot_token="",
            telegram_allowed_chat_ids=(),
            relay_host="127.0.0.1",
            relay_port=0,
            telegram_poll_timeout=1,
        )
        self.server = serve_http(cfg)
        self.host, self.port = self.server.server_address
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.thread.join(timeout=2)

    def request(self, method, path, body=None):
        conn = HTTPConnection(self.host, self.port, timeout=10)
        payload = json.dumps(body) if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        headers["X-Relay-Secret"] = "expected"
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read().decode())


class PersonaGate(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.host_dir = Path(self._tmp.name) / "host"
        self.env = {"AGENTS_HOST_DIR": str(self.host_dir)}

    def tearDown(self):
        self._tmp.cleanup()

    def test_cli_two_personas_separate_sessions(self):
        try:
            from agents_traces.identity import IdentityStore
        except ImportError:
            self.skipTest("agents-traces not installed")
        with patch.dict(os.environ, self.env, clear=False):
            # first persona 'default' comes with the workspace
            self.assertEqual(cli.main(["persona", "add", "cos"]), 0)
            ws = Host(dir=self.host_dir).select_workspace()
            self.assertEqual(ws.id, "default")
            self.assertTrue(
                (ws.personas / "default" / "persona.json").is_file())
            self.assertTrue(
                (ws.personas / "cos" / "persona.json").is_file())

            # same user, two personas -> two distinct sessions
            store = IdentityStore(workspace=ws)
            ses_default = store.resolve(user="me", persona="default",
                                        channel="cli").session
            ses_cos = store.resolve(user="me", persona="cos",
                                    channel="cli").session
            self.assertNotEqual(ses_default.id, ses_cos.id)
            self.assertTrue(
                (ws.personas / "default" / "sessions" /
                 f"{ses_default.id}.json").is_file())
            self.assertTrue(
                (ws.personas / "cos" / "sessions" /
                 f"{ses_cos.id}.json").is_file())
            # the (ws,user,persona) key is visible in the session store
            from agents_traces.identity import SessionStore
            sessions = SessionStore(ws)
            self.assertEqual(
                [r.id for r in sessions.list(persona="cos")], [ses_cos.id])
            self.assertEqual(
                [r.id for r in sessions.list(persona="default")],
                [ses_default.id])
            # resume: explicit session id returns the same record
            self.assertEqual(
                store.resolve(session=ses_cos.id).session.id, ses_cos.id)

    def test_http_two_personas_separate_sessions(self):
        try:
            import agents_traces  # noqa: F401
        except ImportError:
            self.skipTest("agents-traces not installed")
        with patch.dict(os.environ, self.env, clear=False):
            relay = _Relay()
            try:
                status, data = relay.request(
                    "POST", "/v1/workspaces", {"id": "demo"})
                self.assertEqual(status, 201)
                # ws create yields first persona 'default'
                self.assertTrue(
                    (self.host_dir / "workspaces" / "demo" / "personas"
                     / "default" / "persona.json").is_file())
                status, _ = relay.request(
                    "POST", "/v1/workspaces/demo/personas", {"id": "cos"})
                self.assertEqual(status, 201)
                base = "/v1/workspaces/demo/personas"
                status, a = relay.request(
                    "POST", base + "/default/sessions",
                    {"user": "me", "channel": "http"})
                self.assertEqual(status, 201)
                status, b = relay.request(
                    "POST", base + "/cos/sessions",
                    {"user": "me", "channel": "http"})
                self.assertEqual(status, 201)
                self.assertNotEqual(
                    a["session"]["id"], b["session"]["id"])
                self.assertEqual(a["session"]["persona"], "default")
                self.assertEqual(b["session"]["persona"], "cos")
                # per-persona lists stay disjoint
                _, rows = relay.request("GET", base + "/default/sessions")
                self.assertEqual(
                    [s["id"] for s in rows["sessions"]],
                    [a["session"]["id"]])
                _, rows = relay.request("GET", base + "/cos/sessions")
                self.assertEqual(
                    [s["id"] for s in rows["sessions"]],
                    [b["session"]["id"]])
            finally:
                relay.close()

    def test_equal_personas_no_default_privilege(self):
        with patch.dict(os.environ, self.env, clear=False):
            cli.main(["persona", "add", "cos"])
            ws = Host(dir=self.host_dir).select_workspace()
            from agents_workspace.inbox import create_task, list_inbox, task_owner
            # a task routed straight to cos never touches default
            task = create_task(ws, "cos", "direct")
            self.assertEqual(task_owner(ws, task["id"]), "cos")
            self.assertEqual(list_inbox(ws, "default"), [])


if __name__ == "__main__":
    unittest.main()
