"""Shared store.db schema registry: every attr a remote op may carry.

``ingest`` refuses unknown attrs, so hub AND spokes must register the
full domain set before any sync or import runs — otherwise migrated
``persona:*``/``cfg:*``/``mem:*`` datoms die as ``unknown_attr``
refusals on the receiving host. ``ensure_domains`` is the one call that
guarantees that; ``msgsync.ensure_domain`` and
``migrate.ensure_migrate_domain`` both delegate here.
"""
from __future__ import annotations

from .msgsync import MSG_ATTRS

# migrate --to-store domain: file domains folded into datoms (klanker#143,
# frontier #19). Entities ``persona:<id>``, ``cfg:<key>``, ``mem:<slug>``.
MIGRATE_ATTRS = {
    "persona:id": ("text", "one"),
    "persona:name": ("text", "one"),
    "persona:json": ("text", "one"),
    "cfg:key": ("text", "one"),
    "cfg:value": ("text", "one"),
    "cfg:key_env": ("text", "one"),
    "mem:file": ("text", "one"),
    "mem:title": ("text", "one"),
    "mem:text": ("text", "one"),
    # host that imported this entity from its on-disk memory/ tree; the
    # deleted-file retraction only touches entities it owns (klanker#155)
    "mem:host": ("text", "one"),
}

ALL_ATTRS = {**MSG_ATTRS, **MIGRATE_ATTRS}


def ensure_domains(conn) -> None:
    """Idempotently register every syncable domain attr on ``conn``."""
    for name, (vt, card) in ALL_ATTRS.items():
        conn.execute(
            "INSERT OR IGNORE INTO attr (name, value_type, cardinality, doc)"
            " VALUES (?, ?, ?, ?)",
            (name, vt, card, "klanker sync domain"))
