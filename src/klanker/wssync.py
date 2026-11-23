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
import os
import threading
import time
from pathlib import Path

from agents_store.db import connect
from agents_store.ingest import ingest, ops_since, cursor as store_cursor
from agents_store.store import Store
from agents_sync.opdist import BoundedSeen, PeerBook, deliver, receive

from .msgsync import local_origin_prefixes

log = logging.getLogger(__name__)

TICK_SEC = float(os.environ.get("KLANKER_SYNC_TICK_SEC", "60") or 60)


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
        # hub role: ws:announce delivery is fire-once per (device, ws,
        # member-set). Frames to offline devices drop silently, so the
        # announce re-fires on the device's next upstream contact —
        # membership survives disconnects (klanker#145).
        self._announce_sent: dict[tuple[str, str], object] = {}
        self._hub_workers: dict[tuple[str, str], WsSync] = {}  # (ws, dev) -> WsSync
        self._ws_lookup: dict[str, Path] = {}                # hub-side ws dirs
        self._hub = None
        self._hub_node = ""
        self._local_node: str | None = None
        self._thread: threading.Thread | None = None
        self._clients: dict[str, object] = {}            # hub_id -> client
        self._share_state: dict[tuple, frozenset | None] = {}

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
        if hasattr(client, "on_ws"):
            client.on_ws = lambda kind, p: self._spoke_ws_frame(
                client, workers, kind, p)
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
                host.update_workspace(ws_id, sync_policy="local")
            except Exception as exc:  # noqa: BLE001
                log.warning("ws %s: revoke apply failed: %s", ws_id, exc)
                return
            with self._lock:
                workers[:] = [w for w in workers if w.ws_id != ws_id]
                lst = self._client_workers.get(client.hub_id, [])
                lst[:] = [w for w in lst if w.ws_id != ws_id]
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
                frozenset(members) or None)
        if not any(w.ws_id == ws_id for w in workers):
            w = WsSync(
                ws_id, ws.dir, client.device_id, "hub",
                lambda k, p: client.send(k, p),
                origin_only=True, local_node=self.local_node())
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
            self._ensure_announced(hub, device_id)
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
            self._ensure_announced(hub, device_id)
            ws_id = str(payload.get("ws") or "")
            w = self._hub_worker(device_id, ws_id)
            if w is not None:
                w.on_ack(payload)

        def ws_handler(device_id: str, kind: str, payload: dict) -> None:
            self._ensure_announced(hub, device_id)
            ws_id = str(payload.get("ws") or "")
            if not ws_id:
                return
            if kind == "ws:announce":
                self._hub_announce(hub, device_id, ws_id, payload)
            elif kind == "ws:revoke":
                self._hub_revoke(hub, device_id, ws_id)

        hub.set_op_handler(op_handler)
        hub.set_ack_handler(ack_handler)
        if hasattr(hub, "set_ws_handler"):
            hub.set_ws_handler(ws_handler)
        if hasattr(hub, "set_connect_handler"):
            hub.set_connect_handler(
                lambda dev: self._ensure_announced(hub, dev))

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
        hosts = entry.get("hosts")
        if hosts is not None and device_id not in hosts:
            return False
        key = (device_id, ws_id)
        if self._announce_sent.get(key) == hosts:
            return False
        label, owner = "", ""
        try:
            from agents_workspace import Host

            ws = Host.from_env().workspace(ws_id)
            label = str(getattr(ws, "label", "") or "")
            owner = str((getattr(ws, "execution", None) or {})
                        .get("owner") or "")
        except Exception:  # noqa: BLE001
            pass
        rc = hub.publish(device_id, "ws:announce", {
            "ws": ws_id, "label": label, "owner": owner,
            "sync_hosts": sorted(hosts or ()),
            "open": hosts is None,
            "seq": int(time.time() * 1000)})
        if rc is not None and rc < 0:
            return False  # offline: stays unmarked, connect handler retries
        self._announce_sent[key] = hosts
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
        if host.workspace_exists(ws_id):
            ws = host.workspace(ws_id)
        else:
            ws = host.create(
                ws_id, label=str(payload.get("label") or ws_id))
            try:
                host.update_workspace(
                    ws_id,
                    execution={"owner": device_id, "failover": "none"})
            except (TypeError, ValueError):
                pass  # older agents-workspace: owner unenforceable
        owner = str((getattr(ws, "execution", None) or {}).get("owner") or "")
        with self._lock:
            entry = self._ws_lookup.get(ws_id)
            old_members = set((entry or {}).get("hosts") or ())
        if owner and device_id != owner:
            log.warning(
                "ws %s: announce from non-owner %s dropped", ws_id, device_id)
            return
        if not owner and entry is not None \
                and entry.get("hosts") is not None \
                and device_id not in old_members:
            log.warning(
                "ws %s: announce from non-member %s dropped", ws_id, device_id)
            return
        offered = payload.get("sync_hosts")
        if payload.get("open"):
            members: set | None = None  # reopen to every paired device
        else:
            members = set(old_members if offered is None else
                          (str(d) for d in offered))
            members.add(device_id)
            if owner:
                members.add(owner)
        try:
            host.update_workspace(
                ws_id, sync_hosts=sorted(members) if members else [])
            if not owner:
                host.update_workspace(
                    ws_id,
                    execution={"owner": device_id, "failover": "none"})
                owner = device_id
        except TypeError:
            pass
        new_hosts = frozenset(members) if members else None
        with self._lock:
            self._ws_lookup[ws_id] = {"dir": ws.dir, "hosts": new_hosts}
        seq = payload.get("seq") or 0
        out = {"ws": ws_id,
               "label": str(payload.get("label") or ""),
               "owner": owner or device_id,
               "sync_hosts": sorted(new_hosts or ()),
               "open": new_hosts is None,
               "seq": seq}
        new_set = set(new_hosts or ())
        with self._lock:
            entry = dict(self._ws_lookup.get(ws_id) or {})
        for dev in sorted(new_set - old_members):
            entry["hosts"] = new_hosts
            self._hub_announce_to(hub, dev, ws_id, entry)
        for dev in sorted(old_members - new_set):
            self._announce_sent.pop((dev, ws_id), None)
            hub.publish(dev, "ws:revoke", {"ws": ws_id, "seq": seq})

    def _hub_revoke(self, hub, device_id: str, ws_id: str) -> None:
        """Upstream revoke = member self-leave. Owners cannot self-leave;
        shrinking the set goes through ws:announce."""
        from agents_workspace import Host

        with self._lock:
            entry = self._ws_lookup.get(ws_id)
        if not entry or device_id not in (entry.get("hosts") or ()):
            return
        ws = Host.from_env().workspace(ws_id)
        if str((getattr(ws, "execution", None) or {}).get("owner") or "") \
                == device_id:
            return
        members = set(entry["hosts"])
        members.discard(device_id)
        try:
            Host.from_env().update_workspace(
                ws_id, sync_hosts=sorted(members))
        except TypeError:
            pass
        with self._lock:
            entry["hosts"] = frozenset(members) or None
        hub.publish(device_id, "ws:revoke", {"ws": ws_id})

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
                try:
                    client.send("ws:revoke", {"ws": w.ws_id, "seq": seq})
                except Exception:  # noqa: BLE001
                    pass
                try:
                    w.conn.close()
                except Exception:  # noqa: BLE001
                    pass
            for ws_id, entry in fresh.items():
                hosts = entry.get("hosts")
                key = ("spoke", hub_id, ws_id)
                seen = key in self._share_state
                prev = self._share_state.get(key)
                changed = not seen or prev != hosts
                self._share_state[key] = hosts
                # announce member-set transitions; open ws that was never
                # restricted stays silent (hub treats it as open anyway)
                announce = changed and (
                    hosts is not None or (seen and prev is not None))
                if announce:
                    try:
                        client.send("ws:announce", {
                            "ws": ws_id,
                            "label": str(entry.get("label") or ""),
                            "owner": str(getattr(client, "device_id", "")
                                         or ""),
                            "sync_hosts": sorted(hosts or ()),
                            "open": hosts is None,
                            "seq": seq})
                    except Exception as exc:  # noqa: BLE001
                        log.warning(
                            "ws %s: announce send failed: %s", ws_id, exc)
                if ws_id not in known:
                    w = WsSync(
                        ws_id, entry["dir"], client.device_id, "hub",
                        lambda k, p, c=client: c.send(k, p),
                        origin_only=True, local_node=self.local_node())
                    with self._lock:
                        self._client_workers.setdefault(
                            hub_id, []).append(w)
                    _try_drain(w)

        # hub role: registry edits on the hub host fan out the same way
        hub = self._hub
        if hub is None:
            return
        with self._lock:
            lookup = dict(self._ws_lookup)
        for ws_id, entry in lookup.items():
            old = set(entry.get("hosts") or ())
            f = fresh.get(ws_id)
            if f is None:
                with self._lock:
                    self._ws_lookup.pop(ws_id, None)
                for dev in sorted(old):
                    self._announce_sent.pop((dev, ws_id), None)
                    hub.publish(dev, "ws:revoke", {"ws": ws_id, "seq": seq})
                continue
            new = set(f.get("hosts") or ())
            if old == new:
                continue
            with self._lock:
                self._ws_lookup[ws_id] = {
                    "dir": f["dir"],
                    "hosts": frozenset(new) or None}
            payload = {"ws": ws_id,
                       "label": str(f.get("label") or ""),
                       "owner": str(
                           (self._ws_owner(ws_id) or "")),
                       "sync_hosts": sorted(new),
                       "open": not new,
                       "seq": seq}
            for dev in sorted(new - old):
                hub.publish(dev, "ws:announce", payload)
                self._announce_sent[(dev, ws_id)] = new
                w = self._hub_worker(dev, ws_id)
                if w is not None:
                    _try_drain(w)
            for dev in sorted(old - new):
                self._announce_sent.pop((dev, ws_id), None)
                hub.publish(dev, "ws:revoke", {"ws": ws_id, "seq": seq})
            for dev in sorted(new & old):
                hub.publish(dev, "ws:announce", payload)
                self._announce_sent[(dev, ws_id)] = new
        for ws_id, f in fresh.items():
            if ws_id not in lookup:
                entry = {"dir": f["dir"], "hosts": f.get("hosts")}
                with self._lock:
                    self._ws_lookup[ws_id] = entry
                # newly discovered ws: announce to every member —
                # offline devices pick it up on their next contact via
                # _ensure_announced (klanker#145)
                hosts = f.get("hosts")
                for dev in sorted(hosts or ()):
                    self._hub_announce_to(hub, dev, ws_id, entry)
        # periodic sweep: closes the connect-before-discovery race —
        # a device that linked up before the ws was discovered still
        # gets its announce on the next tick
        for dev in hub.connected_devices():
            self._ensure_announced(hub, dev)

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
