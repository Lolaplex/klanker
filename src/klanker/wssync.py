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
    ) -> None:
        self.ws_id = ws_id
        self.peer = peer_id
        self.node_id = node_id
        ws_dir = Path(ws_dir)
        ws_dir.mkdir(parents=True, exist_ok=True)
        self.conn = connect(ws_dir / "store.db")
        self.store = Store(self.conn, node_id)
        self.book = PeerBook(Path(ws_dir) / "sync_peers.json")
        self.seen = BoundedSeen()
        self._send = send          # fn(kind, payload) -> channel frame
        self._origin_only = origin_only

    # -- push side ------------------------------------------------------

    def drain(self) -> int:
        """Deliver unacked local tail to the peer. Returns batch cursor."""
        return deliver(
            lambda since: ops_since(
                self.conn, since, origin_only=self._origin_only),
            self.book, self.peer, self.node_id,
            lambda batch: self._send("op", dict(batch, ws=self.ws_id)),
            exclude_origin=self.peer,
            ws=self.ws_id,
        )

    def on_ack(self, payload: dict) -> None:
        self.book.ack(self.peer, int(payload.get("cursor") or 0))

    # -- receive side ---------------------------------------------------

    def on_op(self, payload: dict) -> None:
        stats = receive(payload.get("envelopes") or [], self._ingest, self.seen)
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
        self._thread: threading.Thread | None = None

    # -- spoke role -----------------------------------------------------

    def attach_client(self, client, workspaces) -> None:
        """Wire op/ack frames of a hub link to one WsSync per workspace."""
        workers = []
        for ws_id, ws_dir, in workspaces:
            w = WsSync(
                ws_id, ws_dir, client.device_id, "hub",
                lambda kind, p: client.send(kind, p),
                origin_only=True,
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
            w = self._hub_worker(device_id, ws_id)
            if w is None:
                return  # unknown or local-policy ws: never ingest, never fan out
            w.on_op(payload)
            hub.broadcast("op", payload, skip={device_id})

        def ack_handler(device_id: str, payload: dict) -> None:
            ws_id = str(payload.get("ws") or "")
            w = self._hub_worker(device_id, ws_id)
            if w is not None:
                w.on_ack(payload)

        hub.set_op_handler(op_handler)
        hub.set_ack_handler(ack_handler)

    def _hub_worker(self, device_id: str, ws_id: str) -> WsSync | None:
        with self._lock:
            ws_dir = self._ws_lookup.get(ws_id)
            if ws_dir is None or self._hub is None:
                return None
            key = (ws_id, device_id)
            w = self._hub_workers.get(key)
            if w is None:
                hub = self._hub
                w = WsSync(
                    ws_id, ws_dir, self._hub_node, device_id,
                    lambda kind, p: hub.publish(device_id, kind, p),
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
            for w in self._workers():
                try:
                    w.drain()
                except Exception as exc:  # noqa: BLE001
                    log.warning("ws %s: drain failed: %s", w.ws_id, exc)

    def _workers(self) -> list[WsSync]:
        with self._lock:
            out = [w for ws in self._client_workers.values() for w in ws]
            out.extend(self._hub_workers.values())
            return out


def sync_workspaces() -> dict:
    """ws_id -> ws dir for workspaces allowed to emit ops.

    `sync_policy=local` workspaces never appear on the wire (ws#43):
    no spoke workers, no hub-side ingest, no fan-out.
    """
    from agents_workspace import Workspace

    return {
        str(ws.id): ws.dir
        for ws in Workspace.list_all()
        if getattr(ws, "sync_policy", "synced") != "local"
    }


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
