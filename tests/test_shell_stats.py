import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from klanker.shell.dispatch import process_line
from klanker.shell.resolve import resolve_line
from klanker.shell.state import ShellState


def _store_with_events(tmp: str):
    from agents_traces.models import TraceEvent
    from agents_traces.store import TraceStore

    store = TraceStore(Path(tmp))
    store.append(TraceEvent(session="s1", type="llm_call", tokens_in=100, tokens_out=50, cost_usd=0.01))
    store.append(TraceEvent(session="s1", type="tool_call", tool="read", status="ok"))
    store.append(TraceEvent(session="s2", type="llm_call", tokens_in=999, tokens_out=999, cost_usd=9.0))
    return store


class UsageResolveTests(unittest.TestCase):
    def test_slash_usage_is_builtin(self):
        r = resolve_line("/usage", env=os.environ.copy())
        self.assertEqual((r.route, r.intent), ("builtin", "usage"))

    def test_colon_usage_is_builtin(self):
        r = resolve_line(":usage", env=os.environ.copy())
        self.assertEqual((r.route, r.intent), ("builtin", "usage"))

    def test_unknown_slash_goes_to_agent(self):
        r = resolve_line("/frobnicate stuff", env=os.environ.copy())
        self.assertEqual(r.route, "agent")

    def test_absolute_path_not_hijacked(self):
        env = os.environ.copy()
        with patch("klanker.shell.resolve.shutil.which", return_value=None):
            r = resolve_line("/tmp/x", env=env)
        self.assertNotEqual(r.intent, "usage")

    def test_slash_insights_days(self):
        r = resolve_line("/insights 14", env=os.environ.copy())
        self.assertEqual((r.route, r.intent, r.payload), ("builtin", "insights", "14"))


class UsageOutputTests(unittest.TestCase):
    def test_session_usage_filters_events(self):
        from klanker.stats import usage_lines

        with tempfile.TemporaryDirectory() as tmp:
            store = _store_with_events(tmp)
            lines = usage_lines("s1", store=store)
            text = "\n".join(lines)
            self.assertIn("session s1", text)
            self.assertIn("150", text)
            self.assertIn("$0.0100", text)
            self.assertNotIn("1,998", text)

    def test_empty_session_uses_today(self):
        from klanker.stats import usage_lines

        with tempfile.TemporaryDirectory() as tmp:
            store = _store_with_events(tmp)
            lines = usage_lines("", store=store)
            self.assertIn("today", lines[0])

    def test_unknown_session_reports_empty(self):
        from klanker.stats import usage_lines

        with tempfile.TemporaryDirectory() as tmp:
            store = _store_with_events(tmp)
            self.assertIn("no trace events", usage_lines("nope", store=store)[0])

    def test_dispatch_usage(self):
        state = ShellState.from_os()
        with tempfile.TemporaryDirectory() as tmp:
            store = _store_with_events(tmp)
            with patch("klanker.stats._store", return_value=store):
                _, lines = process_line(state, "/usage")
        self.assertTrue(any("tokens" in line for line in lines))


class InsightsOutputTests(unittest.TestCase):
    def test_insights_reports_sessions(self):
        from klanker.stats import insights_lines

        with tempfile.TemporaryDirectory() as tmp:
            store = _store_with_events(tmp)
            lines = insights_lines(3, store=store)
            text = "\n".join(lines)
            self.assertIn("last 3d", lines[0])
            self.assertIn("sessions 2", text)
            self.assertIn("2,148", text)

    def test_insights_empty_window(self):
        from klanker.stats import insights_lines

        with tempfile.TemporaryDirectory() as tmp:
            from agents_traces.store import TraceStore

            store = TraceStore(Path(tmp))
            self.assertIn("no trace events", insights_lines(7, store=store)[0])

    def test_dispatch_insights_bad_days(self):
        state = ShellState.from_os()
        _, lines = process_line(state, ":insights nope")
        self.assertIn("invalid days", lines[0])


class PlanModeTests(unittest.TestCase):
    def test_slash_plan_resolves(self):
        r = resolve_line("/plan ship the thing", env=os.environ.copy())
        self.assertEqual((r.route, r.intent, r.payload), ("builtin", "plan", "ship the thing"))

    def test_plan_toggle(self):
        state = ShellState.from_os()
        _, lines = process_line(state, ":plan")
        self.assertTrue(state.plan_mode)
        self.assertIn("on", lines[0])
        self.assertIn("plan", state.status_line())
        process_line(state, ":plan")
        self.assertFalse(state.plan_mode)

    def test_plan_wraps_agent_message(self):
        from klanker.shell import agent as agent_mod

        state = ShellState.from_os()
        state.plan_mode = True
        seen: list[str] = []

        class FakeGw:
            session = ""

            def turn(self, text, *, new_session=False):
                seen.append(text)
                return {"reply": "ok"}

        state.gateway = FakeGw()
        agent_mod.agent_turn(state, "build feature x")
        self.assertTrue(seen[0].startswith("PLAN MODE"))
        self.assertIn("build feature x", seen[0])
        self.assertIn("plans/<slug>.md", seen[0])

    def test_one_shot_plan_does_not_toggle(self):
        state = ShellState.from_os()
        _, lines = process_line(state, ":plan do it")
        self.assertFalse(state.plan_mode)
        self.assertIn("agent tier unavailable", lines[0])


if __name__ == "__main__":
    unittest.main()
