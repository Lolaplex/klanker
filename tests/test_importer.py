import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from klanker.importer import apply_items, scan


def _fake_home(tmp: str) -> Path:
    home = Path(tmp)
    claude = home / ".claude"
    (claude / "skills" / "demo").mkdir(parents=True)
    (claude / "skills" / "demo" / "SKILL.md").write_text("x", encoding="utf-8")
    (claude / "commands").mkdir()
    (claude / "CLAUDE.md").write_text("# rules", encoding="utf-8")
    (claude / "commands" / "review.md").write_text("r", encoding="utf-8")
    (claude / "settings.json").write_text(json.dumps({"mcpServers": {"docs": {"command": "docs"}}}), encoding="utf-8")
    cursor = home / ".cursor"
    (cursor / "rules").mkdir(parents=True)
    (cursor / "rules" / "a.mdc").write_text("r", encoding="utf-8")
    (cursor / "mcp.json").write_text(json.dumps({"mcpServers": {"mem": {"command": "mem"}, "docs": {"command": "dup"}}}), encoding="utf-8")
    codex = home / ".codex"
    codex.mkdir()
    (codex / "AGENTS.md").write_text("a", encoding="utf-8")
    (codex / "config.toml").write_text("x=1", encoding="utf-8")
    return home


def _fake_ws(tmp: str) -> SimpleNamespace:
    ws_root = Path(tmp) / "ws"
    return SimpleNamespace(dir=ws_root, rules=ws_root / "rules", skills=ws_root / "skills")


class ScanTests(unittest.TestCase):
    def test_scan_all_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = scan(_fake_home(tmp))
        kinds = {(i.source, i.kind) for i in items}
        self.assertIn(("claude", "skill"), kinds)
        self.assertIn(("claude", "mcp"), kinds)
        self.assertIn(("cursor", "rule"), kinds)
        self.assertIn(("cursor", "mcp"), kinds)
        self.assertIn(("codex", "note"), kinds)

    def test_scan_source_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            items = scan(_fake_home(tmp), ("cursor",))
        self.assertTrue(items)
        self.assertTrue(all(i.source == "cursor" for i in items))


class ApplyTests(unittest.TestCase):
    def test_apply_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _fake_ws(tmp)
            items = scan(_fake_home(tmp))
            lines = apply_items(ws, items)
            self.assertTrue((ws.skills / "demo" / "SKILL.md").is_file())
            self.assertTrue((ws.rules / "imported" / "claude" / "CLAUDE.md").is_file())
            self.assertTrue((ws.rules / "imported" / "claude" / "commands" / "review.md").is_file())
            self.assertTrue((ws.rules / "imported" / "cursor" / "a.mdc").is_file())
            overlay = json.loads((ws.dir / "mcp.json").read_text(encoding="utf-8"))
            self.assertIn("docs", overlay["mcpServers"])
            self.assertIn("mem", overlay["mcpServers"])
            self.assertTrue(any("note" in line for line in lines))

    def test_apply_skips_existing_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _fake_ws(tmp)
            items = scan(_fake_home(tmp))
            (ws.skills / "demo").mkdir(parents=True)
            lines = apply_items(ws, items)
            self.assertTrue(any("skip" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
