

def test_mcp_path_matches_harness(tmp_path, monkeypatch):
    """klanker and harness resolve the identical mcp.json path."""
    from runner.mcp_client import mcp_config_path as harness_path
    from klanker.config_sense import mcp_config_path as klanker_path
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    monkeypatch.delenv("AGENTS_MCP_CONFIG", raising=False)
    monkeypatch.delenv("AGENTS_MCP_CONFIG_FILE", raising=False)
    assert klanker_path() == harness_path() == tmp_path / "host" / "mcp.json"


def test_mcp_report_ws_overlay(tmp_path, monkeypatch):
    import json
    host = tmp_path / "host"
    ws = host / "workspaces" / "alpha"
    ws.mkdir(parents=True)
    (ws / "workspace.json").write_text('{"id": "alpha"}')
    (host / "mcp.json").write_text(json.dumps({"mcpServers": {"a": {"command": "x"}, "b": {"command": "y"}}}))
    (ws / "mcp.json").write_text(json.dumps({"mcpServers": {"b": {"command": "z"}, "c": {"url": "http://x"}}}))
    monkeypatch.setenv("AGENTS_HOST_DIR", str(host))
    monkeypatch.setenv("AGENTS_WORKSPACE", "alpha")
    monkeypatch.delenv("AGENTS_MCP_CONFIG", raising=False)
    monkeypatch.delenv("AGENTS_MCP_CONFIG_FILE", raising=False)
    from klanker.config_sense import mcp_report
    rep = mcp_report()
    names = {r["name"] for r in rep["mcp_servers"]}
    assert names == {"a", "b", "c"}
