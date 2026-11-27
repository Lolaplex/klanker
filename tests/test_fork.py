"""Tests for klanker chat --resume --fork."""

import os
import tempfile
import unittest
from unittest.mock import patch

from klanker.__main__ import parse_cli_args


class TestFork(unittest.TestCase):
    def test_fork_copies_events_to_new_session(self):
        from agents_traces.models import TraceEvent
        from agents_traces.store import TraceStore

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"AGENTS_TRACES_DIR": tmp}):
                store = TraceStore()
                store.append(TraceEvent(session="ses_src", type="message", result="m1"))
                store.append(TraceEvent(session="ses_src", type="message", result="m2"))
                store.append(TraceEvent(session="ses_other", type="message", result="x"))

                from klanker.fork import fork_session

                sid = fork_session("ses_src")
                self.assertTrue(sid.startswith("ses_fork_"))
                src = store.get_events_for_session("ses_src")
                forked = store.get_events_for_session(sid)
                self.assertEqual(len(src), 2)
                self.assertEqual(len(forked), 2)
                self.assertEqual({e.result for e in forked}, {"m1", "m2"})
                self.assertEqual(len(store.get_events_for_session("ses_other")), 1)

    def test_fork_through_message_truncates_at_content_event(self):
        from agents_traces.models import TraceEvent
        from agents_traces.store import TraceStore

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"AGENTS_TRACES_DIR": tmp}):
                store = TraceStore()
                store.append(TraceEvent(session="ses_src", type="message", result="m1"))
                store.append(TraceEvent(session="ses_src", type="tool_call", result="tool"))
                store.append(TraceEvent(session="ses_src", type="message", result="m2"))

                from klanker.fork import fork_session

                sid = fork_session("ses_src", through_message=1)
                forked = store.get_events_for_session(sid)
                self.assertEqual([e.result for e in forked], ["m1"])
                with self.assertRaises(ValueError):
                    fork_session("ses_src", through_message=3)
                with self.assertRaises(ValueError):
                    fork_session("ses_src", through_message=0)

    def test_fork_unknown_session(self):
        from klanker.fork import fork_session

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"AGENTS_TRACES_DIR": tmp}):
                with self.assertRaises(ValueError):
                    fork_session("ses_nothing")

    def test_parser_resume_fork(self):
        args, _ = parse_cli_args(["chat", "hi", "--resume", "ses_1", "--fork"])
        self.assertEqual(args.resume, "ses_1")
        self.assertTrue(args.fork)


if __name__ == "__main__":
    unittest.main()
