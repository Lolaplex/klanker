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


def _fake_ws(tmp: str, *, ws_id: str = "demo") -> SimpleNamespace:
    host_dir = Path(tmp) / "host"
    ws_root = host_dir / "workspaces" / (ws_id or "default")
    return SimpleNamespace(
        id=ws_id,
        dir=ws_root,
        rules=ws_root / "rules",
        skills=ws_root / "skills",
        host=SimpleNamespace(dir=host_dir),
    )


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
            self.assertFalse((ws.dir / "mcp.json").exists())
            target = json.loads((ws.host.dir / "mcp" / "ws-demo.json").read_text(encoding="utf-8"))
            self.assertIn("docs", target["mcpServers"])
            self.assertIn("mem", target["mcpServers"])
            self.assertTrue(any("note" in line for line in lines))

    def test_apply_mcp_fallback_to_host_mcp_json_without_ws_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _fake_ws(tmp, ws_id="")
            items = [i for i in scan(_fake_home(tmp)) if i.kind == "mcp"]
            apply_items(ws, items)
            self.assertFalse((ws.dir / "mcp.json").exists())
            target = json.loads((ws.host.dir / "mcp.json").read_text(encoding="utf-8"))
            self.assertIn("docs", target["mcpServers"])

    def test_apply_skips_existing_skill(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _fake_ws(tmp)
            items = scan(_fake_home(tmp))
            (ws.skills / "demo").mkdir(parents=True)
            lines = apply_items(ws, items)
            self.assertTrue(any("skip" in line for line in lines))


if __name__ == "__main__":
    unittest.main()
