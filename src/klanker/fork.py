"""Session branching: fork an existing trace session into a new session id.

The append-only store stays append-only — a fork re-appends the source
session's events under a fresh id. The original history is never rewritten,
so exploratory branches cannot falsify the parent thread.
"""

from __future__ import annotations

import secrets
from pathlib import Path


def fork_session(source: str, new_id: str = "", *, traces_dir: Path | None = None) -> str:
    """Copy every trace event of ``source`` into a new session id. Returns it."""
    from agents_traces.store import TraceStore

    source = (source or "").strip()
    if not source:
        raise ValueError("source session id is required")
    cand = (new_id or "").strip()
    if cand:
        from .session import validate_session_id

        cand = validate_session_id(cand)
    store = TraceStore(traces_dir) if traces_dir is not None else TraceStore()
    events = store.get_events_for_session(source)
    if not events:
        raise ValueError(f"unknown or empty session: {source}")
    sid = cand or f"ses_fork_{secrets.token_hex(4)}"
    for event in events:
        event.session = sid
        store.append(event)
    return sid
