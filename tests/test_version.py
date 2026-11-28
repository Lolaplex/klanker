"""The installed version is derived from pyproject metadata, and dev sorts above it."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[1]
_SCHEME = ROOT / "_build" / "version.py"
_SPEC = importlib.util.spec_from_file_location("klanker_build_version", _SCHEME)
assert _SPEC and _SPEC.loader
scheme = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(scheme)


def test_release_build_is_the_pyproject_version(monkeypatch):
    monkeypatch.setenv("KLANKER_RELEASE", "1")
    base = scheme.release_version()
    assert scheme.version_for_build() == base
    assert "+" not in base


def test_dev_build_sorts_above_the_release_and_the_published_line(monkeypatch):
    monkeypatch.delenv("KLANKER_RELEASE", raising=False)

    def git(*args):
        if "rev-parse" in args:
            return "abc123def456"
        return ""

    monkeypatch.setattr(scheme, "_git", git)
    base = scheme.release_version()
    got = scheme.version_for_build()
    assert got == f"{base}+gabc123def456"
    parsed = Version(got)
    assert parsed > Version(base)
    assert parsed > Version("0.2.1")


def test_dirty_dev_build_keeps_sorting_above_the_base(monkeypatch):
    monkeypatch.delenv("KLANKER_RELEASE", raising=False)

    def git(*args):
        if "rev-parse" in args:
            return "abc123def456"
        return " M pyproject.toml\n"

    monkeypatch.setattr(scheme, "_git", git)
    base = scheme.release_version()
    got = scheme.version_for_build()
    assert got == f"{base}+gabc123def456.dirty"
    assert Version(got) > Version(base)


def test_missing_git_uses_a_local_dev_segment(monkeypatch):
    monkeypatch.delenv("KLANKER_RELEASE", raising=False)
    monkeypatch.setattr(scheme, "_git", lambda *_a: "")
    base = scheme.release_version()
    got = scheme.version_for_build()
    assert got == f"{base}+dev"
    assert Version(got) > Version(base)
    assert Version(got) > Version("0.2.1")


def test_render_roundtrip_restores_the_release_line():
    original = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    base = scheme.release_version(original)
    stamped = scheme.render_project_version(original, f"{base}+gabc123def456")
    assert f'version = "{base}+gabc123def456"' in stamped
    assert scheme.release_version(stamped) == base
    restored = scheme.render_project_version(stamped, base)
    assert restored == original


def test_runtime_version_matches_metadata_and_sorts_at_or_above_the_base():
    from importlib.metadata import version as dist_version

    from klanker import __version__

    base = Version(scheme.release_version())
    got = Version(__version__)
    assert __version__ == dist_version("klanker")
    assert Version(got.base_version) == base
    assert got >= base


@pytest.mark.parametrize("flag", ["1", "true", "yes", "on"])
def test_release_flag_spellings(monkeypatch, flag):
    monkeypatch.setenv("KLANKER_RELEASE", flag)
    assert scheme.is_release_build()
    assert scheme.local_segment() == ""
