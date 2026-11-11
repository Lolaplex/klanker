"""P2: klanker persona CLI + persona threading into turns."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agents_workspace import Host

from klanker import __main__ as cli


def _caps():
    from klanker.sensing import HostCapabilities

    return HostCapabilities(
        os_name="nt", is_tty=False, python_version=sys.version.split()[0],
        suite_modules={"harness": True},
    )


class PersonaCli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.env = {"AGENTS_HOST_DIR": str(Path(self._tmp.name) / "host")}

    def tearDown(self):
        self._tmp.cleanup()

    def test_persona_add_list_roundtrip(self):
        with patch.dict(os.environ, self.env, clear=False):
            rc = cli.main(["persona", "add", "cos", "--role", "Chief of Staff"])
            self.assertEqual(rc, 0)
            rc = cli.main(["persona", "add", "ops"])
            self.assertEqual(rc, 0)
            import io
            buf = io.StringIO()
            import contextlib
            with contextlib.redirect_stdout(buf):
                rc = cli.main(["persona", "list"])
            self.assertEqual(rc, 0)
            out = buf.getvalue()
            self.assertIn("cos", out)
            self.assertIn("ops", out)
            self.assertIn("default", out)
            ws = Host(dir=Path(self.env["AGENTS_HOST_DIR"])).select_workspace()
            self.assertTrue(
                (ws.personas / "cos" / "persona.json").is_file())

    def test_persona_add_rejects_bad_id(self):
        with patch.dict(os.environ, self.env, clear=False):
            rc = cli.main(["persona", "add", "../evil"])
            self.assertEqual(rc, 2)

    def test_chat_persona_reaches_child_env(self):
        with patch.dict(os.environ, self.env, clear=False):
            Host.from_env().create("demo")
            os.environ["AGENTS_WORKSPACE"] = "demo"
            nucleus = cli.Nucleus(caps=_caps())
            with patch("klanker.nucleus.probe_host", return_value=_caps()), \
                 patch("subprocess.run") as mock_run:
                mock_run.return_value.returncode = 0
                rc = nucleus.run_turn(message="hi", persona="cos")
            self.assertEqual(rc, 0)
            argv = mock_run.call_args.args[0]
            self.assertIn("--persona", argv)
            self.assertEqual(argv[argv.index("--persona") + 1], "cos")
            child_env = mock_run.call_args.kwargs["env"]
            self.assertEqual(child_env["AGENTS_PERSONA"], "cos")
            self.assertEqual(child_env["AGENTS_WORKSPACE"], "demo")


if __name__ == "__main__":
    unittest.main()
