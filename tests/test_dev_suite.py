import importlib.util
import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "dev-suite.py"
_SPEC = importlib.util.spec_from_file_location("dev_suite", _SCRIPT)
assert _SPEC and _SPEC.loader
dev_suite = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(dev_suite)


class DevSuiteRefTests(unittest.TestCase):
    def test_suite_ref_applies_to_all_emitted_deps(self):
        env = {k: v for k, v in os.environ.items() if not k.endswith("_REF")}
        env["SUITE_REF"] = "feat/x"
        buf = io.StringIO()
        with patch.dict(os.environ, env, clear=True), \
             patch.object(sys, "argv", ["dev-suite.py", "--emit"]), \
             redirect_stdout(buf):
            rc = dev_suite.main()
        self.assertEqual(rc, 0)
        lines = [line for line in buf.getvalue().splitlines() if line.strip()]
        self.assertTrue(any(line.startswith("agents-store @ ") for line in lines))
        for line in lines:
            self.assertTrue(line.endswith("@feat/x"), line)

    def test_short_ref_overrides_suite_ref(self):
        env = {"SUITE_REF": "feat/x", "STORE_REF": "dev"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(dev_suite.ref_for("agents-store"), "dev")
            self.assertEqual(dev_suite.ref_for("agents-relay"), "feat/x")

    def test_full_ref_beats_short_ref(self):
        env = {"SUITE_REF": "feat/x", "STORE_REF": "dev", "AGENTS_STORE_REF": "custom"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(dev_suite.ref_for("agents-store"), "custom")


if __name__ == "__main__":
    unittest.main()
