"""Usage and insight lines sourced from agents-traces (shell builtins)."""

from __future__ import annotations

from typing import Any


def _store() -> Any:
    from agents_traces.store import TraceStore

    return TraceStore()


def _stat_lines(stats: dict[str, Any], label: str) -> list[str]:
    total = int(stats.get("total_tokens") or 0)
    tin = int(stats.get("tokens_in") or 0)
    tout = int(stats.get("tokens_out") or 0)
    cost = float(stats.get("est_cost_usd") or 0.0)
    tools = int(stats.get("tool_calls_total") or 0)
    errs = int(stats.get("tool_calls_error") or 0)
    rate = float(stats.get("tool_success_rate") or 100.0)
    lines = [
        f"usage ({label})",
        f"  tokens {total:,} (in {tin:,} / out {tout:,})  cost ${cost:.4f}",
        f"  events {int(stats.get('total_events') or 0)}  tools {tools} ({rate:.1f}% ok, {errs} err)",
    ]
    top = stats.get("top_tools") or []
    if top:
        lines.append("  top tools: " + ", ".join(f"{t['tool']} ({t['count']}x)" for t in top[:5]))
    edits = int(stats.get("file_edits_count") or 0)
    if edits:
        lines.append(
            f"  edits {edits} (+{int(stats.get('lines_added') or 0)}/-{int(stats.get('lines_removed') or 0)})"
        )
    for err in (stats.get("top_errors") or [])[:3]:
        lines.append(f"  error {err['count']}x {err['error']}")
    return lines


def _events(store: Any, *, session: str = "", days: int = 0) -> list[Any]:
    if session:
        return store.get_events_for_session(session)
    files = store.list_trace_files(days=days or 1)
    return list(store.iter_events(files=files))


def usage_lines(session: str = "", *, store: Any = None) -> list[str]:
    """Token/cost lines for one session; today's aggregate without one."""
    try:
        from agents_traces.stats import compute_stats

        store = store if store is not None else _store()
    except Exception:
        return ["agents-traces is not installed"]
    if session:
        events = _events(store, session=session)
        if not events:
            return [f"no trace events for session {session}"]
        label = f"session {session}"
    else:
        events = _events(store, days=1)
        if not events:
            return ["no trace events today"]
        label = "today"
    return _stat_lines(compute_stats(events), label)


def insights_lines(days: int = 7, *, store: Any = None) -> list[str]:
    """Aggregate turns/tools/cost/error lines over the last ``days`` days."""
    try:
        from agents_traces.stats import compute_stats

        store = store if store is not None else _store()
    except Exception:
        return ["agents-traces is not installed"]
    days = max(1, int(days))
    events = _events(store, days=days)
    if not events:
        return [f"no trace events in the last {days}d"]
    stats = compute_stats(events)
    lines = _stat_lines(stats, f"last {days}d")
    lines.insert(1, f"  sessions {int(stats.get('sessions_count') or 0)}")
    return lines
