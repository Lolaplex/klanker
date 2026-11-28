"""setuptools backend that stamps a dev local version into project metadata.

Release builds (``KLANKER_RELEASE=1``, set by the publish workflow and by
release Docker images) keep ``[project].version`` exactly. Every other build
rewrites that line for the duration of the setuptools call, then puts the
file back. ``klanker.__version__`` reads the installed metadata and nothing
else.
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import setuptools.build_meta as _setuptools

from version import render_project_version, version_for_build

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"

_depth = 0


@contextmanager
def _stamped_pyproject():
    """Rewrite the version line once per build invocation, including nested hooks."""
    global _depth
    if _depth:
        _depth += 1
        try:
            yield
        finally:
            _depth -= 1
        return
    original = PYPROJECT.read_text(encoding="utf-8")
    target = version_for_build()
    stamped = render_project_version(original, target)
    _depth = 1
    if stamped != original:
        PYPROJECT.write_text(stamped, encoding="utf-8")
    try:
        yield
    finally:
        if stamped != original:
            PYPROJECT.write_text(original, encoding="utf-8")
        _depth = 0


def _wrap(fn):
    def inner(*args, **kwargs):
        with _stamped_pyproject():
            return fn(*args, **kwargs)

    return inner


get_requires_for_build_wheel = _setuptools.get_requires_for_build_wheel
get_requires_for_build_sdist = _setuptools.get_requires_for_build_sdist
get_requires_for_build_editable = _setuptools.get_requires_for_build_editable
prepare_metadata_for_build_wheel = _wrap(_setuptools.prepare_metadata_for_build_wheel)
build_wheel = _wrap(_setuptools.build_wheel)
build_sdist = _wrap(_setuptools.build_sdist)
prepare_metadata_for_build_editable = _wrap(_setuptools.prepare_metadata_for_build_editable)
build_editable = _wrap(_setuptools.build_editable)
