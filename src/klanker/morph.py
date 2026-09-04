"""Dynamic manifest and schedule synthesizer."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def synthesize_schedule(
    *,
    name: str,
    verb: str,
    cadence: str = "daily",
    rests_on: str = "",
    expected_exit: int = 0,
    timeout_sec: int = 300,
) -> dict[str, Any]:
    """Generate a declarative Koru schedule manifest dictionary."""
    return {
        "name": name,
        "verb": verb,
        "cadence": cadence,
        "rests_on": rests_on or f"Synthesized by Klanker for {name}",
        "expected_exit": expected_exit,
        "timeout_sec": timeout_sec,
    }


def write_schedule(target_dir: Path | str, manifest: dict[str, Any]) -> Path:
    """Safely write a synthesized schedule to the target schedules directory."""
    path = Path(target_dir) / f"{manifest['name']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return path
