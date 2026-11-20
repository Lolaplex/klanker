import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from klanker.suite_update import Row, _git_root, apply_update, plan_updates


class GitRootTests(unittest.TestCase):
    def test_finds_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            (repo / ".git").mkdir(parents=True)
            deep = repo / "src" / "pkg"
            deep.mkdir(parents=True)
            self.assertEqual(_git_root(deep / "mod.py"), repo)

    def test_none_without_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(_git_root(Path(tmp)))


class PlanTests(unittest.TestCase):
    def test_plan_shapes(self):
        fake_modules = {"traces": "agents_traces", "relay": "agents_relay"}
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "suite"
            (repo / ".git").mkdir(parents=True)
            mod = repo / "agents_traces"
            mod.mkdir()
            (mod / "__init__.py").write_text("", encoding="utf-8")

            site = Path(tmp) / "lib" / "site-packages" / "agents_relay"
            site.mkdir(parents=True)
            (site / "__init__.py").write_text("", encoding="utf-8")

            def fake_path(module):
                return {
                    "agents_traces": mod / "__init__.py",
                    "agents_relay": site / "__init__.py",
                }.get(module)

            with patch.dict("klanker.suite_update.SUITE_MODULES", fake_modules, clear=True), \
                 patch("klanker.suite_update._module_path", side_effect=fake_path), \
                 patch("klanker.suite_update._is_uv_tool", return_value=False):
                rows = plan_updates()
        pull = [r for r in rows if r.action == "pull"]
        upg = [r for r in rows if r.action == "upgrade"]
        self.assertEqual(len(pull), 1)
        self.assertEqual({r.name for r in upg}, {"agents-relay"})


class ApplyTests(unittest.TestCase):
    def test_pull_ok(self):
        row = Row("x", "pull", detail="C:/repo")
        calls: list[list[str]] = []

        def fake_run(cmd, cwd=None, timeout=120):
            calls.append(cmd)
            if "rev-parse" in cmd:
                return 0, "abc123def456"
            return 0, "Already up to date."

        with patch("klanker.suite_update._run", side_effect=fake_run):
            apply_update(row)
        self.assertEqual(row.status, "current")
        self.assertTrue(any("pull" in c for c in calls))

    def test_pull_error(self):
        row = Row("x", "pull", detail="C:/repo")
        with patch("klanker.suite_update._run", return_value=(1, "conflict")):
            apply_update(row)
        self.assertEqual(row.status, "error")

    def test_upgrade_pip(self):
        row = Row("agents-x", "upgrade")
        with patch("klanker.suite_update._is_uv_tool", return_value=False), \
             patch("klanker.suite_update._run", return_value=(0, "done")) as m:
            apply_update(row)
        self.assertEqual(row.status, "ok")
        self.assertIn("pip", m.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
