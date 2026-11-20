"""Session branching: fork an existing trace session into a new session id.

The append-only store stays append-only — a fork re-appends the source
session's events under a fresh id. The original history is never rewritten,
so exploratory branches cannot falsify the parent thread.
"""

from __future__ import annotations

import secrets


def fork_session(source: str, new_id: str = "") -> str:
    """Copy every trace event of ``source`` into a new session id. Returns it."""
    from agents_traces.store import TraceStore

    source = (source or "").strip()
    if not source:
        raise ValueError("source session id is required")
    store = TraceStore()
    events = store.get_events_for_session(source)
    if not events:
        raise ValueError(f"unknown or empty session: {source}")
    sid = new_id.strip() or f"ses_fork_{secrets.token_hex(4)}"
    for event in events:
        event.session = sid
        store.append(event)
    return sid
