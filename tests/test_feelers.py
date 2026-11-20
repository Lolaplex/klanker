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


if __name__ == "__main__":
    unittest.main()
