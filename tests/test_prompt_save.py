"""save_system_prompt writes <host>/run/klanker_prompt_<ws-id>.txt."""
from __future__ import annotations

from pathlib import Path

from klanker.prompt import save_system_prompt, system_prompt_file
from klanker.sensing import HostCapabilities, probe_host


def test_save_system_prompt_uses_host_run(tmp_path, monkeypatch):
    host = tmp_path / "agents-host"
    monkeypatch.setenv("AGENTS_HOST_DIR", str(host))
    monkeypatch.delenv("AGENTS_DIR", raising=False)
    path = save_system_prompt(probe_host())
    assert path == host / "run" / "klanker_prompt_default.txt"
    assert path.is_file()
    assert "Klanker" in path.read_text(encoding="utf-8")


def test_save_system_prompt_default_without_env(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENTS_HOST_DIR", raising=False)
    monkeypatch.delenv("AGENTS_DIR", raising=False)
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr("klanker.prompt.Path.home", lambda: fake_home)
    path = save_system_prompt(probe_host())
    # first start creates the default workspace under the default host
    assert path == (
        fake_home / ".agents" / "run" / "klanker_prompt_default.txt"
    )
    assert path.is_file()


def _cache_caps() -> HostCapabilities:
    return HostCapabilities(
        os_name="Linux",
        is_tty=False,
        python_version="3.12.0",
        suite_modules={"harness": True},
    )


def test_system_prompt_cache_hit_skips_probe_and_invalidates_on_user_memory(tmp_path, monkeypatch):
    from agents_workspace import Host

    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    ws = Host.from_env().create("alpha")
    monkeypatch.setenv("AGENTS_WORKSPACE", "alpha")
    monkeypatch.delenv("AGENTS_WORKDIR", raising=False)
    monkeypatch.delenv("AGENTS_WORKSPACE_DIR", raising=False)

    calls = 0

    def probe() -> HostCapabilities:
        nonlocal calls
        calls += 1
        return _cache_caps()

    first = system_prompt_file(ws, probe=probe)
    assert calls == 1
    assert first == tmp_path / "host" / "run" / "klanker_prompt_alpha.txt"
    assert (tmp_path / "host" / "run" / "klanker_prompt_alpha.meta.json").is_file()

    def forbidden_probe() -> HostCapabilities:
        raise AssertionError("probe_host ran on a valid prompt-cache hit")

    assert system_prompt_file(ws, probe=forbidden_probe) == first
    assert calls == 1

    user_md = ws.dir / "memory" / "USER.md"
    user_md.parent.mkdir(parents=True, exist_ok=True)
    user_md.write_text("# User\nname: Felix\n", encoding="utf-8")
    assert system_prompt_file(ws, probe=probe) == first
    assert calls == 2
    assert system_prompt_file(ws, probe=forbidden_probe) == first

    user_md.write_text("# User\nname: Felix\npreference: terse\n", encoding="utf-8")
    assert system_prompt_file(ws, probe=probe) == first
    assert calls == 3


def test_system_prompt_cache_is_workspace_scoped_and_bypassable(tmp_path, monkeypatch):
    from agents_workspace import Host

    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    host = Host.from_env()
    alpha = host.create("alpha")
    beta = host.create("beta")
    monkeypatch.delenv("AGENTS_WORKDIR", raising=False)
    monkeypatch.delenv("AGENTS_WORKSPACE_DIR", raising=False)

    calls = 0

    def probe() -> HostCapabilities:
        nonlocal calls
        calls += 1
        return _cache_caps()

    monkeypatch.setenv("AGENTS_WORKSPACE", "alpha")
    alpha_prompt = system_prompt_file(alpha, probe=probe)
    assert calls == 1
    monkeypatch.setenv("AGENTS_WORKSPACE", "beta")
    beta_prompt = system_prompt_file(beta, probe=probe)
    assert calls == 2
    assert alpha_prompt != beta_prompt

    monkeypatch.setenv("KLANKER_NO_PROMPT_CACHE", "1")
    assert system_prompt_file(beta, probe=probe) == beta_prompt
    assert calls == 3
