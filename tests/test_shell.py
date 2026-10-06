import os
import unittest
from pathlib import Path
from unittest.mock import patch

from klanker.shell.dispatch import process_line
from klanker.shell.parse import parse_line
from klanker.shell.resolve import resolve_line
from klanker.shell.state import ShellState


class ShellParseTests(unittest.TestCase):
    def test_pipeline(self):
        parsed = parse_line("echo hello | findstr hello")
        self.assertEqual(len(parsed.segments), 2)

    def test_quoted_args(self):
        parsed = parse_line('cd "C:\\Program Files"')
        self.assertEqual(parsed.segments[0][0], "cd")


class ShellResolveTests(unittest.TestCase):
    def test_cd_is_builtin(self):
        r = resolve_line("cd /tmp", env=os.environ.copy())
        self.assertEqual(r.route, "builtin")
        self.assertEqual(r.intent, "cd")

    def test_unknown_command_is_agent(self):
        r = resolve_line("please fix the failing test", env=os.environ.copy())
        self.assertEqual(r.route, "agent")

    def test_path_command_is_exec(self):
        env = os.environ.copy()
        with patch("klanker.shell.resolve.shutil.which", return_value="/bin/ls"):
            r = resolve_line("ls -la", env=env)
        self.assertEqual(r.route, "exec")

    def test_colon_meta(self):
        r = resolve_line(":session", env=os.environ.copy())
        self.assertEqual(r.route, "builtin")
        self.assertEqual(r.intent, "session")


class ShellDispatchTests(unittest.TestCase):
    def test_pwd_builtin(self):
        state = ShellState.from_os()
        _, lines = process_line(state, "pwd")
        self.assertEqual(lines, [str(state.cwd)])

    def test_cd_changes_cwd(self):
        state = ShellState.from_os()
        target = Path.cwd().root
        process_line(state, f"cd {target}")
        self.assertEqual(state.cwd.resolve(), Path(target).resolve())


if __name__ == "__main__":
    unittest.main()
