"""Pluggable feeler manifests: gateway, memory, traces, docs."""

import json
import unittest

from klanker.overlay import BUNDLED, install_overlay


class TestFeelerPlugs(unittest.TestCase):
    def test_bundle_carries_gateway_memory_traces_docs_plugs(self):
        names = {p.name for p in BUNDLED.glob("*.json")}
        # gateway send + docs search are klanker-owned plugs
        self.assertIn("mcp.gateway.send.json", names)
        self.assertIn("mcp.docs.search.json", names)
        # traces plugs already bundled
        self.assertIn("mcp.traces.inspect.json", names)
        self.assertIn("mcp.traces.stats.json", names)

    def test_manifests_parse_and_match_contract(self):
        for name in ("mcp.docs.search.json", "mcp.gateway.send.json"):
            data = json.loads((BUNDLED / name).read_text(encoding="utf-8"))
            for key in ("name", "verb", "cadence", "rests_on"):
                self.assertTrue(data.get(key), key)
            self.assertEqual(data["kind"], "mcp")
            self.assertTrue(data["as_tool"])
            params = data["parameters"]["properties"]
            self.assertTrue(params)

    def test_harness_module_loader_accepts_bundle(self):
        from runner.modules import load_module

        for path in BUNDLED.glob("*.json"):
            mod = load_module(path)
            self.assertIn(mod["kind"], ("mcp", "skill", "a2a", "schedule", "mcp_remote"))
            self.assertIn(mod["when"], ("on_request", "scheduled", "later"))

    def test_overlay_installs_plugs(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            dest = install_overlay(Path(tmp) / "mods", generate=False)
            installed = {p.name for p in dest.glob("*.json")}
            self.assertIn("mcp.gateway.send.json", installed)
            self.assertIn("mcp.docs.search.json", installed)

    def test_harness_bundled_memory_plugs_cover_memory(self):
        from runner.modules import MODULES_DIR

        names = {p.name for p in MODULES_DIR.glob("mcp.memory*.json")}
        self.assertIn("mcp.memory.search.json", names)
        self.assertIn("mcp.memory.add.json", names)

    def test_store_and_voice_registered_in_sensing_and_helpjson(self):
        from klanker import helpjson, sensing

        self.assertEqual(sensing.SUITE_MODULES["store"], "agents_store")
        self.assertEqual(sensing.SUITE_MODULES["voice"], "agents_voice")
        caps = sensing.HostCapabilities(
            os_name="Linux",
            is_tty=False,
            python_version="3.12.0",
            suite_modules={"store": True, "voice": True},
        )
        self.assertTrue(caps.has_store)
        self.assertTrue(caps.has_voice)

        aliases = {p["alias"]: p["module"] for p in helpjson.PACKAGES}
        self.assertEqual(aliases.get("store"), "agents_store")
        self.assertEqual(aliases.get("voice"), "agents_voice")
        self.assertTrue({"view", "pane", "domains", "query"}.issubset(helpjson.READ_VERBS))


if __name__ == "__main__":
    unittest.main()
