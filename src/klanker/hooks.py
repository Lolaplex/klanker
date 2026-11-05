"""Register host hooks in the process that runs ``runner.loop``.

``klanker.turn`` is that process. Nucleus, serve, and routines start it as a
subprocess, so registering here is what the loop actually sees. A missing
traces install skips the content backend and leaves the final check in place.
"""

from __future__ import annotations

import logging

log = logging.getLogger("klanker.hooks")


def traces_content_backend(session_id: str, digest: str, offset: int = 0, limit: int | None = None):
    """Keyword-compatible adapter for ``agents_traces.content.read_content``.

    The harness calls ``backend(session_id, digest, offset=..., limit=...)``.
    A negative limit means read through the end, which traces expresses as None.
    """
    from agents_traces.content import read_content

    window: int | None
    if limit is None or int(limit) < 0:
        window = None
    else:
        window = int(limit)
    return read_content(str(session_id or ""), str(digest or ""), offset=int(offset), limit=window)


def register_content_backend() -> bool:
    """Register traces ``read_content`` when both packages import. False otherwise."""
    try:
        from runner import register_content_backend as register
    except ImportError:
        return False
    try:
        import agents_traces.content  # noqa: F401
    except ImportError:
        return False
    register(traces_content_backend)
    return True


def register_final_check() -> bool:
    """Register the evidence side-effect check. False when the harness has no hook."""
    try:
        from runner import register_final_check as register
    except ImportError:
        return False
    from .evidence import harness_final_check

    register(harness_final_check)
    return True


def register_harness_hooks() -> dict[str, bool]:
    """Install both hooks. Failures are logged and do not raise."""
    installed = {"content_backend": False, "final_check": False}
    try:
        installed["content_backend"] = register_content_backend()
    except Exception:
        log.warning("content backend was not registered", exc_info=True)
    try:
        installed["final_check"] = register_final_check()
    except Exception:
        log.warning("final check was not registered", exc_info=True)
    return installed
