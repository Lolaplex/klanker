"""Installed version. The number comes from the build metadata."""
from __future__ import annotations

import importlib.metadata
import importlib.util
from pathlib import Path


def current_version() -> str:
    """Version of this installation.

    An installed distribution reports the version written into its metadata
    at build time. A source tree that was never installed derives the same
    string the build backend would stamp, from ``[project].version`` plus a
    dev local segment.
    """
    try:
        return importlib.metadata.version("klanker")
    except importlib.metadata.PackageNotFoundError:
        return source_tree_version()


def source_tree_version() -> str:
    root = Path(__file__).resolve().parents[2]
    scheme = root / "_build" / "version.py"
    if not scheme.is_file():
        raise importlib.metadata.PackageNotFoundError("klanker")
    spec = importlib.util.spec_from_file_location("_klanker_build_version", scheme)
    if spec is None or spec.loader is None:
        raise importlib.metadata.PackageNotFoundError("klanker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.version_for_build()
