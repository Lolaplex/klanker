import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from klanker import mgmt


class FakeHandler:
    def __init__(self, path: str, body: dict | None = None):
        self.path = path
        self.relay_secret = ""
        self.headers = {}
        self.config = None
        self.status: int | None = None
        self.written: dict | None = None
        self._body = json.dumps(body or {}).encode()

    def _read_json(self):
        return json.loads(self._body)

    def _write_json(self, data, status):
        self.written = data
        self.status = status

    def send_error(self, code, msg=""):
        self.status = code


def _fake_ws(tmp: str) -> SimpleNamespace:
    root = Path(tmp) / "ws"
    (root / "skills" / "demo").mkdir(parents=True)
    (root / "skills" / "demo" / "SKILL.md").write_text("x", encoding="utf-8")
    (root / "memory" / "notes").mkdir(parents=True)
    (root / "memory" / "notes" / "a.md").write_text("hello", encoding="utf-8")
    return SimpleNamespace(dir=root, skills=root / "skills", memory=root / "memory")


class MgmtGetTests(unittest.TestCase):
    def test_skills_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _fake_ws(tmp)
            with patch("klanker.mgmt._resolve_ws", return_value=ws):
                h = FakeHandler("/v1/klanker/skills")
                self.assertTrue(mgmt._dispatch(h, "GET"))
        self.assertEqual(h.status, 200)
        self.assertEqual(h.written["skills"][0]["name"], "demo")

    def test_memory_file_read_and_traversal_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _fake_ws(tmp)
            with patch("klanker.mgmt._resolve_ws", return_value=ws):
                h = FakeHandler("/v1/klanker/memory/file?path=notes/a.md")
                mgmt._dispatch(h, "GET")
                self.assertEqual(h.written["content"], "hello")
                h = FakeHandler("/v1/klanker/memory/file?path=../../etc/passwd")
                mgmt._dispatch(h, "GET")
        self.assertEqual(h.status, 404)

    def test_non_klanker_path_passthrough(self):
        h = FakeHandler("/v1/workspaces")
        self.assertFalse(mgmt._dispatch(h, "GET"))


class MgmtDeleteTests(unittest.TestCase):
    def test_delete_skill_and_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _fake_ws(tmp)
            with patch("klanker.mgmt._resolve_ws", return_value=ws):
                h = FakeHandler("/v1/klanker/skills/demo")
                mgmt._dispatch(h, "DELETE")
                self.assertEqual(h.status, 200)
                self.assertFalse((ws.skills / "demo").exists())
                h = FakeHandler("/v1/klanker/memory/file?path=notes/a.md")
                mgmt._dispatch(h, "DELETE")
                self.assertEqual(h.status, 200)
                self.assertFalse((ws.memory / "notes" / "a.md").exists())


class MgmtRoutineTests(unittest.TestCase):
    def test_create_routine(self):
        h = FakeHandler(
            "/v1/klanker/routines",
            {"name": "n1", "prompt": "do x", "cron": "*/5 * * * *"},
        )
        fake_job = {"name": "n1", "kind": "routine", "_file": "/x"}
        with patch("klanker.routine.add_routine", return_value=fake_job):
            mgmt._dispatch(h, "POST")
        self.assertEqual(h.status, 200)
        self.assertNotIn("_file", h.written["routine"])

    def test_routine_action_unknown(self):
        h = FakeHandler("/v1/klanker/routines/n1", {"action": "explode"})
        mgmt._dispatch(h, "POST")
        self.assertEqual(h.status, 400)


if __name__ == "__main__":
    unittest.main()
