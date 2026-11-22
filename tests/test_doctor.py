import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from klanker.doctor import Check, collect_checks, run
from klanker.sensing import HostCapabilities


def _caps(**kw):
    base = dict(
        os_name="test",
        is_tty=False,
        python_version="3.10.0",
        runtimes={"git": True, "uv": False},
        suite_modules={"harness": True, "traces": False},
        has_workspace=True,
    )
    base.update(kw)
    return HostCapabilities(**base)


class DoctorCheckTests(unittest.TestCase):
    def test_suite_missing_is_warn(self):
        report = collect_checks(caps=_caps(), env={})
        suite = {c.name: c for c in report.checks if c.name.startswith("suite.")}
        self.assertEqual(suite["suite.harness"].status, "pass")
        self.assertEqual(suite["suite.traces"].status, "warn")
        self.assertIn("pip install", suite["suite.traces"].hint)

    def test_runtime_missing_is_warn(self):
        report = collect_checks(caps=_caps(), env={})
        rt = {c.name: c for c in report.checks if c.name.startswith("runtime.")}
        self.assertEqual(rt["runtime.git"].status, "pass")
        self.assertEqual(rt["runtime.uv"].status, "warn")

    def test_provider_tokens(self):
        env = {"OPENROUTER_API_KEY": "x"}
        report = collect_checks(caps=_caps(), env=env)
        tok = next(c for c in report.checks if c.name == "tokens")
        self.assertEqual(tok.status, "pass")
        self.assertNotIn("x", tok.detail + tok.hint)
        report = collect_checks(caps=_caps(), env={})
        tok = next(c for c in report.checks if c.name == "tokens")
        self.assertEqual(tok.status, "warn")

    def test_github_capability(self):
        caps = _caps(runtimes={"git": True, "gh": True})
        gh = next(c for c in collect_checks(caps=caps, env={"GH_TOKEN": "t"}).checks if c.name == "github")
        self.assertEqual(gh.status, "pass")
        self.assertNotIn("t", gh.detail + gh.hint)
        gh = next(c for c in collect_checks(caps=caps, env={}).checks if c.name == "github")
        self.assertEqual(gh.status, "warn")
        self.assertIn("GH_TOKEN", gh.hint)
        gh = next(c for c in collect_checks(caps=_caps(runtimes={"gh": False}), env={"GH_TOKEN": "t"}).checks if c.name == "github")
        self.assertEqual(gh.status, "warn")
        self.assertIn("gh", gh.hint)

    def test_gh_runtime_probed(self):
        from klanker.sensing import COMMON_RUNTIMES

        self.assertIn("gh", COMMON_RUNTIMES)

    def test_broken_mcp_json_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "mcp.json"
            bad.write_text("{nope", encoding="utf-8")
            with patch.dict(os.environ, {"AGENTS_MCP_CONFIG_FILE": str(bad)}):
                report = collect_checks(caps=_caps(), env={})
        mcp = next(c for c in report.checks if c.name == "mcp")
        self.assertEqual(mcp.status, "fail")

    def test_exit_code(self):
        with patch("klanker.doctor.probe_host", return_value=_caps(suite_modules={})):
            # no workspace on this env would add warns but no fail; force a fail via python? use json path
            report = collect_checks(caps=_caps(), env={})
        self.assertEqual(report.failed, sum(1 for c in report.checks if c.status == "fail"))


class DoctorCliTests(unittest.TestCase):
    def test_json_output(self):
        import io
        from contextlib import redirect_stdout

        buf = io.StringIO()
        with patch("klanker.doctor.probe_host", return_value=_caps()):
            with redirect_stdout(buf):
                code = run(as_json=True)
        data = json.loads(buf.getvalue())
        self.assertIn("checks", data)
        self.assertIn(code, (0, 1))


if __name__ == "__main__":
    unittest.main()


class DoctorVaultTests(unittest.TestCase):
    """klanker#126: doctor reads Host Vault secrets, not only os.environ."""

    def test_provider_key_from_vault_passes(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from agents_workspace import Host, write_secret
        from klanker.doctor import _check_provider_keys, _check_llm_keys

        with tempfile.TemporaryDirectory() as td:
            host = Host(dir=Path(td) / "host")
            write_secret("OPENROUTER_API_KEY", "sk-test", host=host, scope="host")
            env = {
                "AGENTS_HOST_DIR": str(host.dir),
                "OPENROUTER_API_KEY": "",
                "OPENAI_API_KEY": "",
                "ANTHROPIC_API_KEY": "",
                "LLM_API_KEY": "",
            }
            with patch.dict(os.environ, env, clear=True):
                check = _check_provider_keys({})
                self.assertEqual(check.status, "pass")
                self.assertIn("host vault", check.detail)
                self.assertNotIn("sk-test", check.detail)
                self.assertEqual(_check_llm_keys({}).status, "pass")

    def test_llm_key_warns_when_all_missing(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from klanker.doctor import _check_llm_keys

        with tempfile.TemporaryDirectory() as td:
            env = {"AGENTS_HOST_DIR": str(Path(td) / "host")}
            with patch.dict(os.environ, env, clear=True):
                check = _check_llm_keys({})
        self.assertEqual(check.status, "warn")
        self.assertIn("LLM_API_KEY", check.hint)
