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

import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from agents_store.db import connect
from agents_store.ingest import ingest, ops_since, cursor as store_cursor
from agents_store.store import Store
from agents_sync.opdist import BoundedSeen, PeerBook, deliver, receive

from .msgsync import local_origin_prefixes

log = logging.getLogger(__name__)

TICK_SEC = max(1.0, float(
    os.environ.get("KLANKER_SYNC_TICK_SEC", "60") or 60))


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
        book: PeerBook | None = None,
        peer_node: str = "",
    ) -> None:
        self.ws_id = ws_id
        self.peer = peer_id
        self.node_id = node_id
        # Host identity stamped into locally minted ingest actors
        # (proj@/import@/bind@<node>:...); defaults to the link node id.
        self.local_node = local_node or node_id
        # The peer's own host id — its locally minted proj@/import@/bind@
        # origins are suppressed on the return leg (klanker#146).
        self.peer_node = peer_node
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
        # Every domain a remote op may carry must exist before ingest —
        # ingest refuses unknown attrs and refused envelopes never return.
        from .migrate import ensure_migrate_domain
        from .msgsync import ensure_domain

        ensure_domain(self.conn)
        try:
            ensure_migrate_domain(self.conn)
        except Exception:  # noqa: BLE001 - older klanker/store combos
            pass
        self.store = Store(self.conn, node_id)
        # One PeerBook per workspace, shared across every worker/link —
        # peer cursors must be single-writer or sibling saves clobber
        # each other's acked state (klanker#146).
        self.book = book or PeerBook(Path(ws_dir) / "sync_peers.json")
        self.seen = BoundedSeen()
        self._send = send          # fn(kind, payload) -> channel frame
        self._origin_only = origin_only
        self._last_push = 0.0

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:  # noqa: BLE001
            pass

    # -- push side ------------------------------------------------------

    def drain(self) -> int:
        """Deliver unacked local tail to the peer. Returns batch cursor."""
        with self._db:
            local = list(local_origin_prefixes(self.local_node))
            if self.peer_node and self.peer_node != self.local_node:
                local += local_origin_prefixes(self.peer_node)

            def _ops(since):
                try:
                    return ops_since(
                        self.conn, since, origin_only=self._origin_only,
                        local_origins=tuple(local))
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
        if stats.get("refused") or stats.get("errors"):
            log.warning("ws %s: op batch from %s refused=%d errors=%d",
                        self.ws_id, self.peer,
                        stats.get("refused") or 0, stats.get("errors") or 0)
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
        # RLock: worker spawn paths hold the lock while calling
        # _book_for/_ws_member, which re-enter it (klanker#146).
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._dirty = threading.Event()  # notify() wakes the tick early
        self._client_workers: dict[str, list[WsSync]] = {}   # hub_id -> [WsSync]
        # hub role: ws:announce delivery is fire-once per (device, ws,
        # member-set). Frames to offline devices drop silently, so the
        # announce re-fires on the device's next upstream contact —
        # membership survives disconnects (klanker#145).
        self._announce_sent: dict[tuple[str, str], frozenset] = {}
        self._hub_workers: dict[tuple[str, str], WsSync] = {}  # (ws, dev) -> WsSync
        self._ws_lookup: dict[str, dict] = {}                # hub-side ws dirs
        self._books: dict[str, PeerBook] = {}                # ws_dir -> PeerBook
        self._hub = None
        self._hub_node = ""
        self._local_node: str | None = None
        self._thread: threading.Thread | None = None
        self._ev_thread: threading.Thread | None = None
        self._ev_sub = None
        self._clients: dict[str, object] = {}            # hub_id -> client
        self._share_state: dict[tuple, frozenset] = {}
        self._load_share_state()

    def local_node(self) -> str:
        if self._local_node is None:
            from .msgsync import local_node_id

            self._local_node = self._hub_node or local_node_id()
        return self._local_node

    # -- shared peer books + durable share state -------------------------

    def _book_for(self, ws_dir) -> PeerBook:
        """One PeerBook per workspace store, shared by every worker
        touching it — sibling books overwrite each other's cursors."""
        key = str(Path(ws_dir).resolve())
        with self._lock:
            book = self._books.get(key)
            if book is None:
                book = PeerBook(Path(ws_dir) / "sync_peers.json")
                self._books[key] = book
            return book

    def _state_path(self) -> Path | None:
        try:
            from agents_workspace import Host

            return Path(Host.from_env().dir) / "sync_share_state.json"
        except Exception:  # noqa: BLE001 - no host dir (bare tests)
            return None

    def _load_share_state(self) -> None:
        p = self._state_path()
        if p is None:
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for row in data.get("announce_sent") or []:
            try:
                dev, ws = row["key"]
                self._announce_sent[(dev, ws)] = frozenset(
                    row.get("hosts") or ())
            except (KeyError, TypeError):
                continue
        for row in data.get("share_state") or []:
            try:
                key = tuple(row["key"])
                self._share_state[key] = frozenset(row.get("hosts") or ())
            except (KeyError, TypeError):
                continue

    def _save_share_state(self) -> None:
        """Persist pending announce/share state — offline devices get
        their announce/revoke after the next restart + reconnect."""
        p = self._state_path()
        if p is None:
            return
        with self._lock:
            data = {
                "announce_sent": [
                    {"key": list(k), "hosts": sorted(v)}
                    for k, v in self._announce_sent.items()],
                "share_state": [
                    {"key": list(k), "hosts": sorted(v)}
                    for k, v in self._share_state.items()],
            }
        try:
            fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(data, indent=1) + "\n")
            os.replace(tmp, p)
        except OSError as exc:
            log.warning("ws share state persist failed: %s", exc)

    def notify(self) -> None:
        """A local write just landed — drain now instead of next tick.

        Debounced by the tick loop: the event stays set until the next
        tick consumes it, so bursts collapse into one drain."""
        self._dirty.set()

    # -- spoke role -----------------------------------------------------

    def attach_client(self, client, workspaces) -> None:
        """Wire op/ack frames of a hub link to one WsSync per workspace."""
        # peer key is the hub link id, not the literal "hub" — two hub
        # links to the same ws keep separate ack cursors in the shared
        # workspace PeerBook.
        peer = str(getattr(client, "hub_id", "") or "hub")
        workers = []
        for ws_id, ws_dir, in workspaces:
            w = WsSync(
                ws_id, ws_dir, client.device_id, peer,
                lambda kind, p: client.send(kind, p),
                origin_only=True,
                local_node=self.local_node(),
                book=self._book_for(ws_dir),
            )
            workers.append(w)
        client.on_op = lambda p: _fanout_safe(workers, p, "on_op")
        client.on_ack = lambda p: _fanout_safe(workers, p, "on_ack")
        client.on_hello = lambda p: [
            _try_drain(w) for w in workers]  # reconnect catch-up
        if hasattr(client, "on_ws"):
            def _on_ws(kind, p):
                try:
                    self._spoke_ws_frame(client, workers, kind, p)
                except Exception as exc:  # noqa: BLE001
                    # channel reader thread must survive a bad frame
                    log.warning("ws %s frame handling failed: %s",
                                (p or {}).get("ws"), exc)
            client.on_ws = _on_ws
        with self._lock:
            self._client_workers[client.hub_id] = workers
            self._clients[client.hub_id] = client
        for w in workers:
            _try_drain(w)  # catch-up on connect

    def _spoke_ws_frame(self, client, workers, kind, payload) -> None:
        """ws-share control frames on the spoke (klanker#145): announce
        provisions/adopts the ws and starts a worker; revoke freezes it."""
        ws_id = str(payload.get("ws") or "")
        if not ws_id:
            return
        from agents_workspace import Host

        host = Host.from_env()
        if kind == "ws:revoke":
            try:
                # W05 invariant: local + non-empty sync_hosts raises —
                # clear the member set in the same write.
                host.update_workspace(
                    ws_id, sync_policy="local", sync_hosts=[])
            except Exception as exc:  # noqa: BLE001
                log.warning("ws %s: revoke apply failed: %s", ws_id, exc)
                return
            evicted = []
            with self._lock:
                evicted = [w for w in workers if w.ws_id == ws_id]
                workers[:] = [w for w in workers if w.ws_id != ws_id]
                lst = self._client_workers.get(client.hub_id, [])
                lst[:] = [w for w in lst if w.ws_id != ws_id]
                self._share_state.pop(("spoke", client.hub_id, ws_id), None)
            for w in evicted:
                w.close()
            self._save_share_state()
            log.info("ws %s: revoked — frozen to local", ws_id)
            return
        if not host.workspace_exists(ws_id):
            ws = host.create(
                ws_id, label=str(payload.get("label") or ws_id))
            log.info("ws %s: provisioned from share announce", ws_id)
        else:
            ws = host.workspace(ws_id)
        members = list(payload.get("sync_hosts") or [])
        try:
            host.update_workspace(
                ws_id,
                label=str(payload.get("label") or "") or None,
                sync_hosts=members,
                sync_policy="synced",
                execution={
                    **(getattr(ws, "execution", None) or {}),
                    "owner": str(payload.get("owner") or "")})
        except TypeError:
            pass  # older agents-workspace: ws exists, policy fields absent
        with self._lock:
            self._share_state[("spoke", client.hub_id, ws_id)] = (
                frozenset(members))
        self._save_share_state()
        if not any(w.ws_id == ws_id for w in workers):
            peer = str(getattr(client, "hub_id", "") or "hub")
            w = WsSync(
                ws_id, ws.dir, client.device_id, peer,
                lambda k, p: client.send(k, p),
                origin_only=True, local_node=self.local_node(),
                book=self._book_for(ws.dir))
            with self._lock:
                workers.append(w)  # workers IS _client_workers[hub_id]
            _try_drain(w)

    # -- hub role -------------------------------------------------------

    def attach_hub(self, hub, ws_lookup: dict[str, Path], node_id: str) -> None:
        """Hub ingests spoke ops, acks, and fans out; lazy (ws,dev) workers."""
        self._hub = hub
        self._hub_node = node_id
        with self._lock:
            self._ws_lookup = dict(ws_lookup)

        def op_handler(device_id: str, payload: dict) -> None:
            try:
                self._ensure_announced(hub, device_id)
                ws_id = str(payload.get("ws") or "")
                if not self._ws_member(ws_id, device_id):
                    # Inbound write ACL: sync_hosts is THE member set —
                    # ops from non-member devices never enter the hub
                    # copy and never fan out (klanker#145/#146).
                    log.warning(
                        "ws %s: dropping op from non-member device %s",
                        ws_id, device_id)
                    return
                w = self._hub_worker(device_id, ws_id)
                if w is None:
                    return  # local-policy or unknown ws: never ingest
                w.on_op(payload)
                # Never forward the spoke's raw batch — its batch_cursor
                # is cursor in the SPOKE's store. The hub ingests, then
                # each member worker drains the hub tail and mints a
                # hub-local batch_cursor the peer can ack (klanker#146).
                self._notify_members(ws_id, skip=device_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("hub op handling failed: %s", exc)

        def ack_handler(device_id: str, payload: dict) -> None:
            try:
                self._ensure_announced(hub, device_id)
                ws_id = str(payload.get("ws") or "")
                if not self._ws_member(ws_id, device_id):
                    log.warning(
                        "ws %s: dropping ack from non-member device %s",
                        ws_id, device_id)
                    return
                w = self._hub_worker(device_id, ws_id)
                if w is not None:
                    w.on_ack(payload)
            except Exception as exc:  # noqa: BLE001
                log.warning("hub ack handling failed: %s", exc)

        def ws_handler(device_id: str, kind: str, payload: dict) -> None:
            try:
                self._ensure_announced(hub, device_id)
                ws_id = str(payload.get("ws") or "")
                if not ws_id:
                    return
                if kind == "ws:announce":
                    self._hub_announce(hub, device_id, ws_id, payload)
                elif kind == "ws:revoke":
                    self._hub_revoke(hub, device_id, ws_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("hub ws %s handling failed: %s", kind, exc)

        hub.set_op_handler(op_handler)
        hub.set_ack_handler(ack_handler)
        if hasattr(hub, "set_ws_handler"):
            hub.set_ws_handler(ws_handler)
        if hasattr(hub, "set_connect_handler"):
            def _on_connect(dev):
                try:
                    self._ensure_announced(hub, dev)
                except Exception as exc:  # noqa: BLE001
                    log.warning("announce on connect %s failed: %s",
                                dev, exc)
            hub.set_connect_handler(_on_connect)

    def _ws_live(self, ws_id: str):
        """Fresh workspace.json read — never trust cached policy for
        security gates (klanker#146). Returns None when unknown."""
        try:
            from agents_workspace import Host

            host = Host.from_env()
            if not host.workspace_exists(ws_id):
                return None
            return host.workspace(ws_id)
        except Exception:  # noqa: BLE001
            return None

    def _ws_member(self, ws_id: str, device_id: str) -> bool:
        """Live ACL: ws must be syncable and explicitly allow the device."""
        ws = self._ws_live(ws_id)
        if ws is None:
            return False
        allows = getattr(ws, "allows_device", None)
        if callable(allows):
            return bool(allows(device_id))
        return bool(
            getattr(ws, "sync_policy", "local") != "local"
            and device_id in (getattr(ws, "sync_hosts", None) or ()))

    def _notify_members(self, ws_id: str, *, skip: str = "") -> None:
        """Nudge every member worker of a ws to drain the hub tail —
        lazily spawning workers for members that have not talked yet.

        Each drain mints a hub-local batch_cursor — the only cursor a
        peer may ever ack."""
        with self._lock:
            entry = self._ws_lookup.get(ws_id) or {}
        workers = []
        for dev in sorted(entry.get("hosts") or ()):
            if dev == skip:
                continue
            w = self._hub_worker(dev, ws_id)
            if w is not None:
                workers.append(w)
        for w in workers:
            _try_drain(w)

    def _ensure_announced(self, hub, device_id: str) -> None:
        """Publish ws:announce for every member ws the device has not
        heard of (or whose member set changed since). Called on each
        upstream contact — ws frames to offline devices are dropped, so
        the next contact is the delivery opportunity."""
        with self._lock:
            lookup = dict(self._ws_lookup)
        for ws_id, entry in lookup.items():
            self._hub_announce_to(hub, device_id, ws_id, entry)

    def _hub_announce_to(self, hub, device_id: str, ws_id: str,
                         entry: dict) -> bool:
        """Fire-once-per-member-set announce + backfill drain."""
        hosts = frozenset(entry.get("hosts") or ())
        if device_id not in hosts:
            return False
        key = (device_id, ws_id)
        if self._announce_sent.get(key) == hosts:
            return False
        label, owner = "", ""
        try:
            ws = self._ws_live(ws_id)
            if ws is not None:
                label = str(getattr(ws, "label", "") or "")
                owner = str((getattr(ws, "execution", None) or {})
                            .get("owner") or "")
        except Exception:  # noqa: BLE001
            pass
        rc = hub.publish(device_id, "ws:announce", {
            "ws": ws_id, "label": label, "owner": owner,
            "sync_hosts": sorted(hosts),
            "seq": int(time.time() * 1000)})
        if rc is not None and rc < 0:
            return False  # offline: stays unmarked, connect handler retries
        self._announce_sent[key] = hosts
        self._save_share_state()
        w = self._hub_worker(device_id, ws_id)
        if w is not None:
            _try_drain(w)
        return True

    def _hub_announce(self, hub, device_id: str, ws_id: str,
                      payload: dict) -> None:
        """ws-share announce upstream: provision the ws on the hub on
        first contact, merge the member set, forward the announce to
        newly added devices (plus full backfill), revoke removed ones.

        Announce carries the owner's FULL desired member set; owner and
        sender are always kept members so nobody locks themselves out.
        """
        from agents_workspace import Host

        host = Host.from_env()
        exists = host.workspace_exists(ws_id)
        if exists:
            ws = host.workspace(ws_id)
            if getattr(ws, "sync_policy", "local") == "local":
                # local-only ws never joins the share graph — an inbound
                # announce can neither adopt nor widen it (klanker#146).
                log.warning(
                    "ws %s: announce for local-policy ws from %s dropped",
                    ws_id, device_id)
                return
            owner = str((getattr(ws, "execution", None) or {})
                        .get("owner") or "")
            if not owner:
                # Hijack guard: an existing workspace with no recorded
                # owner is never claimed over the wire. The hub-side
                # owner must `workspace share` explicitly (klanker#146).
                log.warning(
                    "ws %s: announce on unowned ws from %s dropped — "
                    "set an owner or share it explicitly", ws_id, device_id)
                return
            if device_id != owner:
                log.warning(
                    "ws %s: announce from non-owner %s dropped",
                    ws_id, device_id)
                return
        else:
            ws = host.create(
                ws_id, label=str(payload.get("label") or ws_id))
            try:
                host.update_workspace(
                    ws_id, sync_policy="synced",
                    execution={"owner": device_id, "failover": "none"})
            except (TypeError, ValueError):
                pass  # older agents-workspace: owner unenforceable
            owner = device_id
        with self._lock:
            entry = self._ws_lookup.get(ws_id)
            old_members = set((entry or {}).get("hosts") or ())
        offered = payload.get("sync_hosts")
        members = set(old_members if offered is None else
                      (str(d) for d in offered))
        members.add(device_id)
        if owner:
            members.add(owner)
        try:
            host.update_workspace(
                ws_id, sync_hosts=sorted(members), sync_policy="synced")
        except (TypeError, ValueError) as exc:
            log.warning("ws %s: announce member write failed: %s",
                        ws_id, exc)
            return
        new_hosts = frozenset(members)
        with self._lock:
            self._ws_lookup[ws_id] = {
                "dir": ws.dir, "hosts": new_hosts,
                "label": str(getattr(ws, "label", "") or "")}
        seq = payload.get("seq") or 0
        for dev in sorted(members - old_members):
            entry = {"hosts": new_hosts}
            self._hub_announce_to(hub, dev, ws_id, entry)
        for dev in sorted(old_members - members):
            self._announce_sent.pop((dev, ws_id), None)
            hub.publish(dev, "ws:revoke", {"ws": ws_id, "seq": seq})
            self._evict_hub_worker(ws_id, dev)
        self._save_share_state()

    def _hub_revoke(self, hub, device_id: str, ws_id: str) -> None:
        """Upstream revoke = member self-leave. Owners cannot self-leave;
        shrinking the set goes through ws:announce."""
        ws = self._ws_live(ws_id)
        if ws is None or not self._ws_member(ws_id, device_id):
            return
        if str((getattr(ws, "execution", None) or {}).get("owner") or "") \
                == device_id:
            return
        members = set(getattr(ws, "sync_hosts", None) or ())
        members.discard(device_id)
        try:
            from agents_workspace import Host

            Host.from_env().update_workspace(
                ws_id, sync_hosts=sorted(members))
        except (TypeError, ValueError) as exc:
            log.warning("ws %s: revoke member write failed: %s", ws_id, exc)
            return
        with self._lock:
            entry = self._ws_lookup.get(ws_id)
            if entry is not None:
                entry["hosts"] = frozenset(members)
        self._announce_sent.pop((device_id, ws_id), None)
        self._evict_hub_worker(ws_id, device_id)
        hub.publish(device_id, "ws:revoke", {"ws": ws_id})
        self._save_share_state()

    def _evict_hub_worker(self, ws_id: str, device_id: str) -> None:
        with self._lock:
            w = self._hub_workers.pop((ws_id, device_id), None)
        if w is not None:
            w.close()

    def _hub_worker(self, device_id: str, ws_id: str) -> WsSync | None:
        """Member-gated lazy worker. Non-members never get a worker —
        without one there is nothing to ingest into or drain from."""
        if not self._ws_member(ws_id, device_id):
            return None
        with self._lock:
            entry = self._ws_lookup.get(ws_id)
            if entry is None or self._hub is None:
                return None
            ws_dir = entry["dir"]
            key = (ws_id, device_id)
            w = self._hub_workers.get(key)
            if w is None:
                hub = self._hub
                w = WsSync(
                    ws_id, ws_dir, self._hub_node, device_id,
                    lambda kind, p: hub.publish(device_id, kind, p),
                    local_node=self.local_node(),
                    book=self._book_for(ws_dir),
                    peer_node=self._device_host(device_id),
                )
                self._hub_workers[key] = w
            return w

    @staticmethod
    def _device_host(device_id: str) -> str:
        """device_id -> paired host_id (devices.json). Used to suppress
        echoing the peer's own proj@/bind@/import@ origins back at it."""
        try:
            from agents_relay.devices import list_public

            for row in list_public():
                if row.get("id") == device_id:
                    return str(row.get("host_id") or "")
        except Exception:  # noqa: BLE001
            pass
        return ""

    # -- periodic drain -------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        # event-driven sync: a store.changed event (any in-process write
        # that went through the serve HTTP surface) wakes the tick —
        # debounced inside _run (klanker#146).
        try:
            from agents_relay import events as _ev

            self._ev_sub = _ev.subscribe(tag="wssync")
            self._ev_thread = threading.Thread(
                target=self._event_run, daemon=True)
            self._ev_thread.start()
        except Exception:  # noqa: BLE001 - no relay events wired
            pass

    def _event_run(self) -> None:
        sub = self._ev_sub
        while sub is not None and not self._stop.is_set():
            try:
                item = sub.queue.get(timeout=1.0)
            except Exception:  # noqa: BLE001 - empty queue poll
                continue
            if item is None:
                return
            if str(item.get("kind") or "") == "store.changed":
                self._dirty.set()

    def stop(self) -> None:
        self._stop.set()
        self._dirty.set()  # wake the tick loop immediately
        sub = self._ev_sub
        if sub is not None:
            try:
                from agents_relay import events as _ev

                _ev.unsubscribe(sub)
            except Exception:  # noqa: BLE001
                pass
            self._ev_sub = None

    def _run(self) -> None:
        while not self._stop.is_set():
            woke = self._dirty.wait(TICK_SEC)
            if self._stop.is_set():
                break
            if woke:
                # debounce: burst writes collapse into one drain
                self._dirty.clear()
                time.sleep(min(2.0, TICK_SEC))
                self._dirty.clear()
            self.tick()

    def tick(self) -> None:
        """Project new trace messages once per ws dir, then drain all."""
        try:
            self._reconcile_shares()
        except Exception as exc:  # noqa: BLE001
            log.warning("ws share reconcile failed: %s", exc)
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

    def _reconcile_shares(self) -> None:
        """Diff the local ws registry against live sync state (klanker#145
        R3): `klanker ws share/unshare` only edits workspace.json — this
        loop emits announce/revoke frames for member-set changes, spawns
        workers for newly synced ws, retires workers for ws that went
        local. Desired-state reconciliation; self-heals after disconnect."""
        try:
            fresh = sync_workspaces()
        except Exception as exc:  # noqa: BLE001
            log.warning("ws reconcile: registry scan failed: %s", exc)
            return
        seq = int(time.time() * 1000)
        state_changed = False
        self._attach_new_hubs()

        # spoke role: announce member-set changes; retire gone-local ws
        with self._lock:
            clients = dict(self._clients)
            cws = {h: list(v) for h, v in self._client_workers.items()}
        for hub_id, client in clients.items():
            workers = cws.get(hub_id, [])
            known = {w.ws_id for w in workers}
            for w in list(workers):
                if w.ws_id in fresh:
                    continue
                with self._lock:
                    if w in self._client_workers.get(hub_id, []):
                        self._client_workers[hub_id].remove(w)
                self._share_state.pop(("spoke", hub_id, w.ws_id), None)
                state_changed = True
                try:
                    client.send("ws:revoke", {"ws": w.ws_id, "seq": seq})
                except Exception:  # noqa: BLE001
                    pass
                w.close()
            for ws_id, entry in fresh.items():
                hosts = frozenset(entry.get("hosts") or ())
                key = ("spoke", hub_id, ws_id)
                prev = self._share_state.get(key)
                changed = key not in self._share_state or prev != hosts
                self._share_state[key] = hosts
                if changed:
                    state_changed = True
                    try:
                        client.send("ws:announce", {
                            "ws": ws_id,
                            "label": str(entry.get("label") or ""),
                            "owner": str(getattr(client, "device_id", "")
                                         or ""),
                            "sync_hosts": sorted(hosts),
                            "seq": seq})
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "ws %s: announce send failed: %s", ws_id, exc)
                if ws_id not in known:
                    peer = str(getattr(client, "hub_id", "") or "hub")
                    w = WsSync(
                        ws_id, entry["dir"], client.device_id, peer,
                        lambda k, p, c=client: c.send(k, p),
                        origin_only=True, local_node=self.local_node(),
                        book=self._book_for(entry["dir"]))
                    with self._lock:
                        self._client_workers.setdefault(
                            hub_id, []).append(w)
                    _try_drain(w)

        # hub role: registry edits on the hub host fan out the same way
        hub = self._hub
        if hub is None:
            if state_changed:
                self._save_share_state()
            return
        # revoked devices: workers + pending announces die with the
        # registration — the device id can never come back (klanker#146)
        alive = None
        try:
            from agents_relay.devices import list_public

            alive = {r["id"] for r in list_public()}
        except Exception:  # noqa: BLE001
            pass
        if alive is not None:
            with self._lock:
                dead = [k for k in self._hub_workers if k[1] not in alive]
            for (wid, dev) in dead:
                self._evict_hub_worker(wid, dev)
                self._announce_sent.pop((dev, wid), None)
        with self._lock:
            lookup = dict(self._ws_lookup)
        for ws_id, entry in lookup.items():
            old = set(entry.get("hosts") or ())
            f = fresh.get(ws_id)
            if f is None:
                # went local / deleted on this host: revoke every member
                with self._lock:
                    self._ws_lookup.pop(ws_id, None)
                for dev in sorted(old):
                    self._announce_sent.pop((dev, ws_id), None)
                    hub.publish(dev, "ws:revoke", {"ws": ws_id, "seq": seq})
                    self._evict_hub_worker(ws_id, dev)
                state_changed = True
                continue
            new = set(f.get("hosts") or ())
            if old == new:
                continue
            state_changed = True
            with self._lock:
                self._ws_lookup[ws_id] = {
                    "dir": f["dir"], "hosts": frozenset(new),
                    "label": str(f.get("label") or "")}
            payload = {"ws": ws_id,
                       "label": str(f.get("label") or ""),
                       "owner": str(self._ws_owner(ws_id) or ""),
                       "sync_hosts": sorted(new),
                       "seq": seq}
            for dev in sorted(new):
                self._announce_sent.pop((dev, ws_id), None)
                hub.publish(dev, "ws:announce", payload)
                self._announce_sent[(dev, ws_id)] = frozenset(new)
                if dev not in old:
                    w = self._hub_worker(dev, ws_id)
                    if w is not None:
                        _try_drain(w)
            for dev in sorted(old - new):
                self._announce_sent.pop((dev, ws_id), None)
                hub.publish(dev, "ws:revoke", {"ws": ws_id, "seq": seq})
                self._evict_hub_worker(ws_id, dev)
        for ws_id, f in fresh.items():
            if ws_id not in lookup:
                entry = {"dir": f["dir"],
                         "hosts": frozenset(f.get("hosts") or ()),
                         "label": str(f.get("label") or "")}
                with self._lock:
                    self._ws_lookup[ws_id] = entry
                # newly discovered ws: announce to every member —
                # offline devices pick it up on their next contact via
                # _ensure_announced (klanker#145)
                for dev in sorted(entry["hosts"]):
                    self._hub_announce_to(hub, dev, ws_id, entry)
        # periodic sweep: closes the connect-before-discovery race —
        # a device that linked up before the ws was discovered still
        # gets its announce on the next tick
        for dev in hub.connected_devices():
            self._ensure_announced(hub, dev)
        # worker eviction on live membership: a device may have lost
        # access via a policy edit that kept the ws entry identical
        with self._lock:
            pairs = list(self._hub_workers)
        for (wid, dev) in pairs:
            if not self._ws_member(wid, dev):
                self._evict_hub_worker(wid, dev)
        if state_changed:
            self._save_share_state()

    def _attach_new_hubs(self) -> None:
        """hubs.json rows that appeared after serve boot (e.g. a fresh
        `workspace join`) get a live ChannelClient + all registered
        client hooks — no serve restart needed (klanker#147)."""
        try:
            from agents_relay import channel_client as _cc

            hubs = _cc._load_hubs()
        except Exception:  # noqa: BLE001
            return
        with self._lock:
            missing = [h for h in hubs if h not in self._clients]
        for hub_id in missing:
            try:
                c = _cc.ChannelClient(hub_id)
                for hook in list(getattr(_cc, "CLIENT_HOOKS", [])):
                    try:
                        hook(c)
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "hub %s client hook failed: %s", hub_id, exc)
                threading.Thread(target=c.run_forever, daemon=True).start()
                with self._lock:
                    self._clients[hub_id] = c
                log.info("hub channel attached live: %s", hub_id)
            except Exception as exc:  # noqa: BLE001
                log.warning("hub channel %s attach failed: %s", hub_id, exc)

    def _ws_owner(self, ws_id: str) -> str:
        try:
            from agents_workspace import Host
            ws = Host.from_env().workspace(ws_id)
            return str((getattr(ws, "execution", None) or {}).get("owner")
                       or "")
        except Exception:  # noqa: BLE001
            return ""

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
    """ws_id -> {"dir": path, "hosts": frozenset} for emittable ws.

    `is_syncable()` (sync_policy synced/shared) gates the wire entirely:
    local workspaces get no workers, no ingest, no fan-out (ws#43/#44).
    `sync_hosts` is THE member set (klanker#145): it gates BOTH hub
    fan-out and inbound writes — and ``frozenset()`` means CLOSED.
    There is no open-herd mode: every member device must be listed
    explicitly (klanker#146). Entries are hub channel device ids (the
    id this hub minted at pairing, `/v1/hub/devices`), compared against
    `hub.connected_devices()` -- not Host.host_id() values.
    """
    from agents_workspace import Workspace

    out = {}
    for ws in Workspace.list_all():
        syncable = getattr(ws, "is_syncable", None)
        if callable(syncable):
            if not syncable():
                continue
        elif getattr(ws, "sync_policy", "synced") == "local":
            continue
        hosts = getattr(ws, "sync_hosts", None) or ()
        out[str(ws.id)] = {
            "dir": ws.dir,
            "hosts": frozenset(str(h) for h in hosts),
            "label": str(getattr(ws, "label", "") or ""),
        }
    return out


def ws_invite_auth(device_id: str, ws_id: str) -> bool:
    """`/v1/ws/invite` gate (klanker#145): only the ws owner may mint
    invites. Owner is recorded in workspace.json execution.owner by
    `workspace share|invite` or an accepted ws:announce."""
    try:
        from agents_workspace import Host

        ws = Host.from_env().workspace(ws_id)
        owner = str(
            (getattr(ws, "execution", None) or {}).get("owner") or "")
        return bool(owner) and owner == device_id
    except Exception:  # noqa: BLE001
        return False


def ws_grant_apply(device_id: str, ws_id: str, granted_by: str) -> None:
    """Redeemed ws invite on the hub (klanker#145): provision the ws if
    unseen, add new device + inviter to the member set, keep/record
    ownership. The share reconcile loop announces the diff."""
    from agents_workspace import Host

    host = Host.from_env()
    if not host.workspace_exists(ws_id):
        host.create(ws_id)
    ws = host.workspace(ws_id)
    members = set(getattr(ws, "sync_hosts", None) or ())
    members.update(d for d in (device_id, granted_by) if d)
    ex = dict(getattr(ws, "execution", None) or {})
    if granted_by and not ex.get("owner"):
        ex["owner"] = granted_by
    host.update_workspace(
        ws_id, sync_hosts=sorted(members), sync_policy="synced",
        execution=ex)


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


def _fanout_safe(workers, payload: dict, method: str) -> None:
    """Same routing as _fanout, but a bad frame can never kill the
    channel reader thread it runs on (klanker#146)."""
    ws_id = payload.get("ws") or ""
    for w in workers:
        if w.ws_id != ws_id:
            continue
        try:
            getattr(w, method)(payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("ws %s: %s failed: %s", ws_id, method, exc)
