from __future__ import annotations

import os
import shlex
from dataclasses import dataclass


@dataclass(frozen=True)
class ParsedLine:
    segments: tuple[tuple[str, ...], ...]
    raw: str


def parse_line(line: str) -> ParsedLine:
    text = line.strip()
    if not text:
        return ParsedLine(segments=(), raw=text)
    parts = [p.strip() for p in text.split("|")]
    segments: list[tuple[str, ...]] = []
    posix = os.name != "nt"
    for part in parts:
        if not part:
            raise ValueError("empty pipeline segment")
        segments.append(tuple(shlex.split(part, posix=posix)))
    return ParsedLine(segments=tuple(segments), raw=text)
