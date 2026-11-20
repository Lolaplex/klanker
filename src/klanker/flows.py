"""Koru schedule synthesis: chat/CLI -> runner/schedules-style flow manifest.

The ``runner.executor`` contract requires ``name``, ``verb``, ``cadence`` and
``rests_on``; ``runner.schedule.add_schedule`` builds exactly that shape from
one call. ``klanker cron add`` synthesises a manifest two ways:

- dry-run (default): ``add_schedule`` runs against a throwaway schedules dir,
  so natural-language phrases, cron expressions and the required-field check
  are all validated by the real harness code path — nothing registers.
- ``--apply``: same call against the live workspace ``schedules/`` dir; the
  running ``tick()`` picks the manifest up on its next pass.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from typing import Any


def synthesize_flow(args: Any, *, apply: bool) -> dict[str, Any]:
    """Build a flow manifest via ``runner.schedule.add_schedule``.

    ``apply=False`` swaps ``AGENTS_SCHEDULES_DIR`` for a temp dir, so the
    returned manifest is fully validated but never registered.
    """
    from agents_workspace import Workspace
    from runner.schedule import add_schedule

    ws = Workspace.from_env()
    target = str(ws.schedules)
    tmp: tempfile.TemporaryDirectory[str] | None = None
    if not apply:
        tmp = tempfile.TemporaryDirectory(prefix="klanker-flow-")
        env = dict(os.environ)
        env["AGENTS_SCHEDULES_DIR"] = tmp.name
        ws = Workspace.from_env(env)

    manifest = add_schedule(
        name=(args.name or "").strip() or None,
        at=(args.at or "").strip() or None,
        cron=(args.cron or "").strip() or None,
        natural=(args.natural or "").strip() or None,
        cadence=(args.cadence or "").strip() or None,
        verb=(args.verb or "").strip() or None,
        text=(args.text or "").strip() or None,
        channel=(args.channel or "").strip(),
        user=(args.sched_user or "").strip(),
        timezone_name=(args.timezone_name or "").strip(),
        one_shot=True if args.one_shot else None,
        prompt=(args.prompt or "").strip() or None,
        session=(args.session or "").strip() or None,
        timeout_sec=args.timeout_sec,
        grace_min=args.grace_min,
        workspace=ws,
    )
    manifest["_registered"] = bool(apply)
    manifest["_schedules_dir"] = target if apply else str(ws.schedules)
    if tmp is not None:
        # Keep the handle until the manifest dict is returned; the dir itself
        # is disposable — nothing live may ever resolve to it.
        manifest["_dry_run"] = True
        tmp.cleanup()
    return manifest


def dispatch(args: Any) -> int:
    apply = bool(getattr(args, "apply", False))
    try:
        manifest = synthesize_flow(args, apply=apply)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    if not apply:
        print("dry-run: manifest validates, nothing registered (use --apply to register live)")
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0
