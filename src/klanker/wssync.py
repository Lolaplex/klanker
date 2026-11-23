"""Workspace sync workers — bind store.db tails to relay channel op frames.

Runs inside `klanker serve` (single instance, thread not daemon). One
`WsSync` per workspace per channel peer:

- spoke side: `WsSync` attached to a `ChannelClient` — drains local ops
  upstream (origin_only), ingests incoming op batches, acks cursors.
- hub side: `SyncRuntime.attach_hub` — lazily creates a `WsSync` per
  (ws, device) so the hub can ingest spoke ops, ack them, and fan out
  every workspace's tail to each connected device.

Delivery is ack-gated: a peer's cursor advances only on `ack`, so the
60s tick re-delivers whatever was lost. Local push fires on `notify()`
(turn writes) plus the tick for out-of-process writes.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

from agents_store.db import connect
from agents_store.ingest import ingest, ops_since, cursor as store_cursor
from agents_store.store import Store
from agents_sync.opdist import BoundedSeen, PeerBook, deliver, receive

from .msgsync import local_origin_prefixes

log = logging.getLogger(__name__)

TICK_SEC = 60.0


class WsSync:
    """One workspace's sync state on one peer link."""

    def __init__(
        self,
        ws_id: str,
        ws_dir: str | Path,
        node_id: str,
        peer_id: str,
        send,
        *,
        origin_only: bool = False,
        local_node: str | None = None,
    ) -> None:
        self.ws_id = ws_id
        self.peer = peer_id
        self.node_id = node_id
        # Host identity stamped into locally minted ingest actors
        # (proj@/import@/bind@<node>:...); defaults to the link node id.
        self.local_node = local_node or node_id
        ws_dir = Path(ws_dir)
        ws_dir.mkdir(parents=True, exist_ok=True)
        self.ws_dir = ws_dir
        # The conn is touched from the SSE reader thread (on_op) and the
        # sync tick thread (drain) — share it safely: relaxed thread-check
        # + one lock around every DB touch. Older agents-store lacks the
        # kwarg: fall back loudly (single-threaded use stays correct).
        try:
            self.conn = connect(
                ws_dir / "store.db", check_same_thread=False)
        except TypeError:
            log.warning("agents-store too old for check_same_thread; "
                        "sync threads may crash on shared conn")
            self.conn = connect(ws_dir / "store.db")
        self._db = threading.Lock()
        # msg:*/session:* attrs must exist before any remote op arrives —
        # ingest refuses unknown attrs and refused envelopes never return.
        from .msgsync import ensure_domain

        ensure_domain(self.conn)
        self.store = Store(self.conn, node_id)
        self.book = PeerBook(Path(ws_dir) / "sync_peers.json")
        self.seen = BoundedSeen()
        self._send = send          # fn(kind, payload) -> channel frame
        self._origin_only = origin_only

    # -- push side ------------------------------------------------------

    def drain(self) -> int:
        """Deliver unacked local tail to the peer. Returns batch cursor."""
        with self._db:
            def _ops(since):
                try:
                    return ops_since(
                        self.conn, since, origin_only=self._origin_only,
                        local_origins=local_origin_prefixes(
                            self.local_node))
                except TypeError:
                    return ops_since(
                        self.conn, since, origin_only=self._origin_only)
            return deliver(
                _ops,
                self.book, self.peer, self.node_id,
                lambda batch: self._send("op", dict(batch, ws=self.ws_id)),
                exclude_origin=self.peer,
                ws=self.ws_id,
            )

    def on_ack(self, payload: dict) -> None:
        self.book.ack(self.peer, int(payload.get("cursor") or 0))

    # -- receive side ---------------------------------------------------

    def on_op(self, payload: dict) -> None:
        with self._db:
            stats = receive(
                payload.get("envelopes") or [], self._ingest, self.seen)
        if stats["applied"]:
            log.info("ws %s: +%d datoms from %s",
                     self.ws_id, stats["applied"], self.peer)
        bc = payload.get("batch_cursor")
        if bc is not None:
            self._send("ack", {"ws": self.ws_id, "cursor": bc})

    def _ingest(self, actor, seq, hlc, datoms, *, op="assert", note=None):
        return ingest(
            self.conn, actor, seq, hlc, datoms, op=op, note=note,
            clock=self.store._clock, local_node_id=self.node_id)


class SyncRuntime:
    """Serve-lifetime registry of WsSync workers for both roles."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._client_workers: dict[str, list[WsSync]] = {}   # hub_id -> [WsSync]
        self._hub_workers: dict[tuple[str, str], WsSync] = {}  # (ws, dev) -> WsSync
        self._ws_lookup: dict[str, Path] = {}                # hub-side ws dirs
        self._hub = None
        self._hub_node = ""
        self._local_node: str | None = None
        self._thread: threading.Thread | None = None

    def local_node(self) -> str:
        if self._local_node is None:
            from .msgsync import local_node_id

            self._local_node = self._hub_node or local_node_id()
        return self._local_node

    # -- spoke role -----------------------------------------------------

    def attach_client(self, client, workspaces) -> None:
        """Wire op/ack frames of a hub link to one WsSync per workspace."""
        workers = []
        for ws_id, ws_dir, in workspaces:
            w = WsSync(
                ws_id, ws_dir, client.device_id, "hub",
                lambda kind, p: client.send(kind, p),
                origin_only=True,
                local_node=self.local_node(),
            )
            workers.append(w)
        client.on_op = lambda p: _fanout(workers, p, "on_op")
        client.on_ack = lambda p: _fanout(workers, p, "on_ack")
        client.on_hello = lambda p: [
            _try_drain(w) for w in workers]  # reconnect catch-up
        with self._lock:
            self._client_workers[client.hub_id] = workers
        for w in workers:
            _try_drain(w)  # catch-up on connect

    # -- hub role -------------------------------------------------------

    def attach_hub(self, hub, ws_lookup: dict[str, Path], node_id: str) -> None:
        """Hub ingests spoke ops, acks, and fans out; lazy (ws,dev) workers."""
        self._hub = hub
        self._hub_node = node_id
        with self._lock:
            self._ws_lookup = dict(ws_lookup)

        def op_handler(device_id: str, payload: dict) -> None:
            ws_id = str(payload.get("ws") or "")
            allowed = (self._ws_lookup.get(ws_id) or {}).get("hosts")
            if allowed is not None and device_id not in allowed:
                # Inbound write ACL (ws-share spec klanker#145 R1):
                # sync_hosts is THE member set — ops from devices outside
                # it must never enter the hub copy nor be fanned out.
                log.warning(
                    "ws %s: dropping op from non-member device %s",
                    ws_id, device_id)
                return
            w = self._hub_worker(device_id, ws_id)
            if w is None:
                return  # unknown or local-policy ws: never ingest, never fan out
            w.on_op(payload)
            skip = {device_id}
            if allowed:
                skip |= {d for d in hub.connected_devices()
                         if d not in allowed}
            hub.broadcast("op", payload, skip=skip)

        def ack_handler(device_id: str, payload: dict) -> None:
            ws_id = str(payload.get("ws") or "")
            w = self._hub_worker(device_id, ws_id)
            if w is not None:
                w.on_ack(payload)

        hub.set_op_handler(op_handler)
        hub.set_ack_handler(ack_handler)

    def _hub_worker(self, device_id: str, ws_id: str) -> WsSync | None:
        with self._lock:
            entry = self._ws_lookup.get(ws_id)
            if entry is None or self._hub is None:
                return None
            ws_dir = entry["dir"] if isinstance(entry, dict) else entry
            key = (ws_id, device_id)
            w = self._hub_workers.get(key)
            if w is None:
                hub = self._hub
                w = WsSync(
                    ws_id, ws_dir, self._hub_node, device_id,
                    lambda kind, p: hub.publish(device_id, kind, p),
                    local_node=self.local_node(),
                )
                self._hub_workers[key] = w
            return w

    # -- periodic drain -------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(TICK_SEC):
            self.tick()

    def tick(self) -> None:
        """Project new trace messages once per ws dir, then drain all."""
        workers = self._workers()
        projected: set[str] = set()
        for w in workers:
            key = str(Path(w.ws_dir).resolve())
            if key in projected:
                continue  # several links share one store.db: project once
            projected.add(key)
            try:
                self._project_msgs(w)
            except Exception as exc:  # noqa: BLE001
                log.warning("ws %s: msg projection failed: %s", w.ws_id, exc)
        for w in workers:
            try:
                w.drain()
            except Exception as exc:  # noqa: BLE001
                log.warning("ws %s: drain failed: %s", w.ws_id, exc)

    def _workers(self) -> list[WsSync]:
        with self._lock:
            out = [w for ws in self._client_workers.values() for w in ws]
            out.extend(self._hub_workers.values())
            return out

    def _project_msgs(self, w: WsSync) -> None:
        """Fold trace message lines appended since the last tick into
        msg:* datoms (incremental byte cursor, no full rescan)."""
        from .msgsync import project_traces

        with w._db:
            project_traces(w.conn, w.ws_dir, node=w.local_node)


def sync_workspaces() -> dict:
    """ws_id -> {"dir": path, "hosts": frozenset|None} for emittable ws.

    `sync_policy=local` workspaces never appear on the wire (ws#43):
    no spoke workers, no hub-side ingest, no fan-out. `sync_hosts`
    is THE member set for the ws (klanker#145): it gates BOTH hub
    fan-out and inbound writes — ops from non-member devices are
    dropped. empty/None = open, every paired device may write.
    Entries are hub channel device ids (the id this hub minted at
    pairing, `/v1/hub/devices`), compared against
    `hub.connected_devices()` -- not Host.host_id() values.
    """
    from agents_workspace import Workspace

    out = {}
    for ws in Workspace.list_all():
        if getattr(ws, "sync_policy", "synced") == "local":
            continue
        hosts = getattr(ws, "sync_hosts", None) or []
        out[str(ws.id)] = {
            "dir": ws.dir,
            "hosts": frozenset(str(h) for h in hosts) or None,
        }
    return out


def _try_drain(w: WsSync) -> None:
    try:
        w.drain()
    except Exception as exc:  # noqa: BLE001
        log.warning("ws %s: drain failed: %s", w.ws_id, exc)


def _fanout(workers, payload: dict, method: str) -> None:
    ws_id = payload.get("ws") or ""
    for w in workers:
        if w.ws_id == ws_id:
            getattr(w, method)(payload)
