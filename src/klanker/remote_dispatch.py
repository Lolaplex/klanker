"""session:host remote turn dispatch + run-lock leases (klanker#148).

Wired by ``klanker serve`` into ``agents_relay.http_adapter``:

- ``remote_turn_dispatch``/``remote_query_dispatch``: a turn whose
  session:host binding (or ws default_host) names a different device is
  forwarded — on the hub straight over ``channel.hub().rpc_call`` (no
  hubs.json needed; hubs.json is empty on the hub!), on a spoke via
  ``<hub>/v1/remote/dev-<host><path>`` under this device's credential.
  ``X-Klanker-Hop`` counts hops; >=2 is a ``508`` — a bounced request can
  never loop spoke -> hub -> spoke.
- Fail-loud: a session bound to an unreachable host NEVER falls back to
  silent local execution — ``503 host_offline`` (or ``409 wip_unpushed``
  when the unreachable host holds unpushed work). Takeover happens only
  through the explicit ``switch_host`` / ``failover`` flow.
- ``turn_lease_guard``/``turn_lease_release``/``run_done_release``: one
  live run per (ws, session) — acquire on the executor before the turn,
  renew every ``lease_sec // 3``, release in finally/at run end. On the
  hub the in-process LeaseBook answers; a spoke POSTs
  ``/v1/hub/lease``; a spoke with a dead hub falls back to a local
  lockfile in ``<ws>/run/`` — never to running twice.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

_MAX_HOPS = 2
_HELD: dict[tuple[str, str], dict] = {}
_HELD_LOCK = threading.Lock()


def _hub_rows() -> dict:
    from agents_workspace import Host

    p = Host.from_env().clients / "hubs.json"
    try:
        return dict(
            (json.loads(p.read_text(encoding="utf-8")) or {}).get("hubs")
            or {})
    except (OSError, json.JSONDecodeError):
        return {}


def _own_device_ids() -> set[str]:
    ids = {str(r.get("device_id") or "") for r in _hub_rows().values()
           if r.get("device_id")}
    try:
        from agents_workspace import Host

        ids.add(str(Host.from_env().host_id()))
    except Exception:  # noqa: BLE001
        pass
    ids.discard("")
    return ids


def _ws_obj(ws_id: str):
    from agents_workspace import Host

    host = Host.from_env()
    try:
        return host.workspace(ws_id) if ws_id else host.select_workspace()
    except Exception:  # noqa: BLE001
        return None


def _session_state(session_id: str, ws_id: str) -> dict:
    from agents_store.db import connect

    from .session import session_view

    ws = _ws_obj(ws_id)
    if ws is None:
        return {"host": "", "branch": "", "repo": "",
                "wip_unpushed": False}
    conn = None
    try:
        conn = connect(ws.dir / "store.db", check_same_thread=False)
        return session_view(conn, session_id)
    except Exception:  # noqa: BLE001
        return {"host": "", "branch": "", "repo": "",
                "wip_unpushed": False}
    finally:
        if conn is not None:
            conn.close()


def _execution_policy(ws_id: str) -> dict:
    ws = _ws_obj(ws_id)
    pol = dict(getattr(ws, "execution", None) or {}) if ws else {}
    pol.setdefault("failover", "none")
    return pol


def _resolve_target(session_id: str, ws_id: str) -> str:
    """session:host > ws.default_host > "" (local)."""
    state = _session_state(session_id, ws_id)
    bound = str(state.get("host") or "").strip()
    if bound:
        return bound
    ws = _ws_obj(ws_id)
    default = str(getattr(ws, "default_host", "") or "").strip() \
        if ws else ""
    if default and default not in _own_device_ids():
        return default
    return ""


def _hop(handler) -> int:
    try:
        return max(0, int(handler.headers.get("X-Klanker-Hop") or 0))
    except (TypeError, ValueError):
        return 0


def _fail(handler, status: int, **payload) -> bool:
    handler._write_json({"ok": False, **payload}, status)
    return True


# -- dispatch --------------------------------------------------------------

def remote_turn_dispatch(handler, path: str, body: dict) -> bool:
    """True when the request was answered here (proxied or refused).

    ``False`` only ever means "execute on this host" — a bound session
    with a reachable route is proxied; an unreachable one is refused
    loudly. There is no silent local fallback (klanker#148).
    """
    hop = _hop(handler)
    if hop >= _MAX_HOPS:
        return _fail(handler, 508,
                     error="dispatch_loop", hops=hop)
    session = str(body.get("session") or "").strip()
    if not session:
        return False
    ws_id = str(body.get("workspace") or "").strip()
    bound = _resolve_target(session, ws_id)
    if not bound or bound in _own_device_ids():
        return False  # unbound or bound here: execute locally
    state = _session_state(session, ws_id)
    failover = str(_execution_policy(ws_id).get("failover") or "none")
    hop += 1
    # Hub side: hubs.json is empty — route straight over ChannelHub.
    try:
        from agents_relay.channel import hub as _channel_hub

        ch = _channel_hub()
        if ch.is_connected(bound):
            _proxy_channel(handler, ch, bound, path, body, hop)
            return True
    except Exception as exc:  # noqa: BLE001 - hub table absent on spoke
        log.debug("channel hub unavailable: %s", exc)
    rows = _hub_rows()
    for hub_id, row in rows.items():
        try:
            if _proxy_spoke(handler, row, hub_id, bound, path, body, hop):
                return True
        except Exception as exc:  # noqa: BLE001
            log.info("remote dispatch via %s failed: %s", hub_id, exc)
    # Bound host unreachable — loud refusal, never local execution.
    if state.get("wip_unpushed"):
        return _fail(handler, 409, error="wip_unpushed",
                     bound_host=bound, failover=failover)
    return _fail(handler, 503, error="host_offline",
                 bound_host=bound, failover=failover)


def remote_query_dispatch(handler, path: str, query: dict) -> bool:
    """GET variant (``/v1/runs/stream``): session in the query string."""
    hop = _hop(handler)
    if hop >= _MAX_HOPS:
        return _fail(handler, 508,
                     error="dispatch_loop", hops=hop)
    session = str((query or {}).get("session") or "").strip()
    if not session:
        return False
    ws_id = str((query or {}).get("workspace") or "").strip()
    bound = _resolve_target(session, ws_id)
    if not bound or bound in _own_device_ids():
        return False
    qs = urllib.parse.urlencode(
        {k: v for k, v in (query or {}).items() if v})
    full = f"{path}?{qs}" if qs else path
    hop += 1
    try:
        from agents_relay.channel import hub as _channel_hub

        ch = _channel_hub()
        if ch.is_connected(bound):
            _proxy_channel(handler, ch, bound, full, None, hop,
                           method="GET")
            return True
    except Exception:  # noqa: BLE001
        pass
    rows = _hub_rows()
    for hub_id, row in rows.items():
        try:
            if _proxy_spoke(handler, row, hub_id, bound, full, None,
                            hop, method="GET"):
                return True
        except Exception as exc:  # noqa: BLE001
            log.info("remote query dispatch via %s failed: %s",
                     hub_id, exc)
    state = _session_state(session, ws_id)
    if state.get("wip_unpushed"):
        return _fail(handler, 409, error="wip_unpushed",
                     bound_host=bound,
                     failover=str(
                         _execution_policy(ws_id).get("failover")
                         or "none"))
    return _fail(handler, 503, error="host_offline",
                 bound_host=bound,
                 failover=str(
                     _execution_policy(ws_id).get("failover") or "none"))


def _proxy_channel(handler, ch, device_id: str, path: str,
                   body: dict | None, hop: int,
                   method: str = "POST") -> None:
    """Hub -> spoke over the live channel: http-RPC frames streamed
    through verbatim (SSE deltas arrive as chunk frames)."""
    req: dict = {"method": method, "path": path,
                 "x_klanker_hop": hop}
    if body is not None:
        import base64

        req["body_b64"] = base64.b64encode(
            json.dumps(body).encode()).decode("ascii")
        req["content_type"] = "application/json"
    accept = str(handler.headers.get("Accept") or "")
    if accept:
        req["accept"] = accept
    frames = ch.rpc_call(device_id, "http", {"req": req},
                         timeout_sec=600.0)
    first = next(frames, None)
    if first is None:
        _fail(handler, 502, error="device returned empty rpc")
        return
    if "error" in first:
        code = 503 if first["error"] in (
            "device offline", "device disconnected") else int(
            first.get("status") or 502)
        _fail(handler, code, error=str(first["error"]))
        return
    status = int(first.get("status") or 502)
    ctype = str(first.get("content_type") or "application/json")
    handler.send_response(status)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_header("X-Klanker-Hop", str(hop))
    handler.end_headers()
    try:
        if "body_b64" in first:
            import base64

            handler.wfile.write(base64.b64decode(str(first["body_b64"])))
        elif "body" in first:
            handler.wfile.write(str(first["body"]).encode("utf-8"))
        for fr in frames:
            if "chunk_b64" in fr:
                import base64

                handler.wfile.write(
                    base64.b64decode(str(fr["chunk_b64"])))
                handler.wfile.flush()
            elif "chunk" in fr:
                handler.wfile.write(str(fr["chunk"]).encode("utf-8"))
                handler.wfile.flush()
            elif "error" in fr or fr.get("done"):
                break
    except (BrokenPipeError, ConnectionResetError):
        pass


def _proxy_spoke(handler, row: dict, hub_id: str, device: str,
                 path: str, body: dict | None, hop: int,
                 method: str = "POST") -> bool:
    """Spoke -> hub HTTP proxy: the hub re-dispatches dev-<id> frames."""
    from agents_relay.channel_client import hub_token

    token = hub_token(hub_id)
    if not token:
        return False
    url = (row["hub_url"].rstrip("/")
           + f"/v1/remote/dev-{device}{path}")
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            "Accept": str(handler.headers.get("Accept")
                          or "application/json"),
            "Authorization": f"Bearer {token}",
            "X-Device-Id": str(row.get("device_id") or ""),
            "X-Klanker-Hop": str(hop),
        },
        method=method)
    resp = None
    try:
        resp = urllib.request.urlopen(req, timeout=600)
        status, ctype = resp.status, str(
            resp.headers.get("Content-Type") or "application/json")
    except urllib.error.HTTPError as exc:
        resp = exc
        status, ctype = exc.code, "application/json"
    except Exception as exc:  # noqa: BLE001
        log.info("remote dispatch via %s failed: %s", hub_id, exc)
        return False
    handler.send_response(status)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()
    try:
        read_chunk = getattr(resp, "read1", None) or resp.read
        while True:
            # read1 keeps SSE deltas + `: ping` keepalives flowing —
            # read(4096) stalls until the buffer fills (klanker#148)
            chunk = read_chunk(4096)
            if not chunk:
                break
            handler.wfile.write(chunk)
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        resp.close()
    return True


# -- leases -----------------------------------------------------------------

def _is_hub() -> bool:
    """This process IS the hub when it has no paired-hub client rows."""
    return not _hub_rows()


def _lease_holder() -> str:
    ids = sorted(_own_device_ids())
    return ids[0] if ids else "__local__"


def _lease_ttl(ws_id: str) -> float:
    try:
        ttl = float(_execution_policy(ws_id).get("lease_sec") or 0)
        if ttl > 0:
            return ttl
    except (TypeError, ValueError):
        pass
    try:
        from agents_relay.leases import TTL_SEC

        return float(TTL_SEC)
    except Exception:  # noqa: BLE001
        return 45.0


def _lockfile(ws_dir: Path, session_id: str) -> Path:
    import re

    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", session_id)[:96]
    return ws_dir / "run" / f"session-{safe}.lock"


def _local_lock(ws, session_id: str, holder: str, ttl: float) -> dict | None:
    """Offline fallback only: hub unreachable -> file lock in the ws.
    A fresh lock held by another holder conflicts; a stale one is
    reclaimed."""
    lf = _lockfile(Path(ws.dir), session_id)
    try:
        if lf.is_file():
            meta = json.loads(lf.read_text(encoding="utf-8"))
            age = time.time() - float(meta.get("ts") or 0)
            if age < ttl and str(meta.get("holder")) != holder:
                return {"ok": False, "error": "lease_held",
                        "holder": str(meta.get("holder") or ""),
                        "expires_in": round(ttl - age, 1),
                        "status": 409}
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass
    try:
        lf.parent.mkdir(parents=True, exist_ok=True)
        lf.write_text(json.dumps(
            {"holder": holder, "ts": time.time(), "ttl": ttl}))
    except OSError as exc:
        return {"ok": False, "error": f"lease_unavailable: {exc}",
                "status": 503}
    return None


def _local_unlock(ws, session_id: str, holder: str) -> None:
    lf = _lockfile(Path(ws.dir), session_id)
    try:
        meta = json.loads(lf.read_text(encoding="utf-8"))
        if str(meta.get("holder")) == holder:
            lf.unlink()
    except (OSError, json.JSONDecodeError):
        pass


def _hub_lease_call(action: str, ws: str, session: str, **extra) -> dict:
    """POST /v1/hub/lease on the paired hub; {} when unreachable."""
    rows = _hub_rows()
    for hub_id, row in rows.items():
        from agents_relay.channel_client import hub_token

        token = hub_token(hub_id)
        if not token:
            continue
        req = urllib.request.Request(
            row["hub_url"].rstrip("/") + "/v1/hub/lease",
            data=json.dumps({"action": action, "ws": ws,
                             "session": session, **extra}).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {token}",
                     "X-Device-Id": str(row.get("device_id") or "")},
            method="POST")
        try:
            return json.loads(
                urllib.request.urlopen(req, timeout=15).read())
        except urllib.error.HTTPError as exc:
            try:
                return json.loads(exc.read() or b"{}")
            except Exception:  # noqa: BLE001
                return {"granted": False, "error": f"http {exc.code}"}
        except Exception:  # noqa: BLE001
            continue
    return {}


def _renew_held() -> None:
    """Heartbeat: extend every held lease at lease_sec//3 cadence."""
    while True:
        time.sleep(5.0)
        with _HELD_LOCK:
            held = list(_HELD.items())
        for (ws_id, session), rec in held:
            ttl = float(rec.get("ttl") or 45.0)
            if time.time() - float(rec.get("touched") or 0) < ttl / 3.0:
                continue
            if rec.get("lock") is not None:
                try:
                    Path(rec["lock"]).write_text(json.dumps(
                        {"holder": rec["holder"],
                         "ts": time.time(), "ttl": ttl}))
                    rec["touched"] = time.time()
                except OSError:
                    pass
                continue
            out = _hub_lease_call(
                "renew", ws_id, session, fence=rec.get("fence") or 0) \
                if not rec.get("hub_book") else rec["hub_book"].renew(
                    ws_id, session, rec["holder"],
                    int(rec.get("fence") or 0), ttl=ttl)
            if out.get("granted"):
                rec["touched"] = time.time()


def turn_lease_guard(handler, body: dict, ctx: dict) -> dict | None:
    """Acquire (ws, session) before the first local turn execution.

    Returns the conflict payload for a 409/503, None when the lease is
    held (or the request carries no session — nothing to lock).
    """
    session = str(body.get("session") or "").strip()
    if not session:
        return None
    ws_id = str(body.get("workspace") or "").strip()
    ws = _ws_obj(ws_id)
    if ws is None:
        return None
    ws_id = ws.id
    run_id = str(body.get("run") or "").strip()
    holder = _lease_holder()
    ttl = _lease_ttl(ws_id)
    with _HELD_LOCK:
        if (ws_id, session) in _HELD:
            return None  # already ours (re-posted run / re-attach)
    if _is_hub():
        from agents_relay.leases import hub_leases

        book = hub_leases()
        out = book.acquire(ws_id, session, holder, run_id, ttl=ttl)
        if not out.get("granted"):
            return {"ok": False, "error": "lease_held",
                    "holder": out.get("holder"),
                    "run_id": out.get("run_id"),
                    "expires_in": out.get("expires_in"),
                    "status": 409}
        rec = {"fence": out.get("fence"), "holder": holder,
               "hub_book": book, "ttl": ttl, "touched": time.time()}
    else:
        out = _hub_lease_call("acquire", ws_id, session, run_id=run_id)
        if not out:
            # hub offline -> ws-local lockfile, never a double-run
            conflict = _local_lock(ws, session, holder, ttl)
            if conflict is not None:
                return conflict
            rec = {"lock": str(_lockfile(Path(ws.dir), session)),
                   "holder": holder, "ttl": ttl,
                   "touched": time.time()}
        elif not out.get("granted"):
            return {"ok": False, "error": "lease_held",
                    "holder": out.get("holder"),
                    "run_id": out.get("run_id"),
                    "expires_in": out.get("expires_in"),
                    "status": 409}
        else:
            rec = {"fence": out.get("fence"), "holder": holder,
                   "ttl": ttl, "touched": time.time()}
    with _HELD_LOCK:
        _HELD[(ws_id, session)] = rec
    global _renew_thread
    if _renew_thread is None:
        _renew_thread = threading.Thread(
            target=_renew_held, daemon=True, name="klanker-lease-renew")
        _renew_thread.start()
    # bound local sessions run inside their session worktree
    _inject_workdir(body, ws, session)
    return None


_renew_thread = None


def turn_lease_release(body: dict, ctx: dict) -> None:
    session = str(body.get("session") or "").strip()
    ws_id = str(body.get("workspace") or "").strip()
    _release(ws_id, session)


def run_done_release(run_id: str, entry: dict) -> None:
    """web.run_done_hook: async run finished -> drop its lease."""
    meta = entry.get("meta") or {}
    _release(str(meta.get("workspace") or ""),
             str(meta.get("session") or ""))


def _release(ws_id: str, session: str) -> None:
    if not session or not ws_id:
        return
    ws = _ws_obj(ws_id)
    ws_id = ws.id if ws is not None else ws_id
    with _HELD_LOCK:
        rec = _HELD.pop((ws_id, session), None)
    if rec is None:
        return
    if rec.get("lock") is not None and ws is not None:
        _local_unlock(ws, session, rec["holder"])
    elif rec.get("hub_book") is not None:
        try:
            rec["hub_book"].release(ws_id, session, rec["holder"],
                                    int(rec.get("fence") or 0))
        except Exception:  # noqa: BLE001
            pass
    else:
        _hub_lease_call("release", ws_id, session,
                        fence=int(rec.get("fence") or 0))


def _inject_workdir(body: dict, ws, session: str) -> None:
    """Bound local session with repo+branch -> run inside the session
    worktree; host-local checkout resolves via host_paths.json."""
    if body.get("workdir"):
        return
    from agents_store.db import connect

    from .session import find_worktree, session_view

    conn = None
    try:
        conn = connect(ws.dir / "store.db", check_same_thread=False)
        view = session_view(conn, session)
    except Exception:  # noqa: BLE001
        return
    finally:
        if conn is not None:
            conn.close()
    repo_ref, branch = view.get("repo") or "", view.get("branch") or ""
    if not repo_ref or not branch:
        return
    slug = repo_ref.split(":", 1)[0]
    checkout = _host_path_for(ws, slug)
    if checkout is None:
        return
    try:
        wt = find_worktree(checkout, branch)
    except Exception:  # noqa: BLE001
        wt = None
    if wt is not None and wt.is_dir():
        body["workdir"] = str(wt)


def _host_paths_path() -> Path:
    from agents_workspace import Host

    return Host.from_env().dir / "host_paths.json"


def read_host_paths() -> dict:
    try:
        return json.loads(_host_paths_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_host_path(ws_id: str, slug: str, path: str) -> None:
    """Host-local slug -> checkout map: synced datoms carry the canonical
    slug only; every host resolves its own absolute path (klanker#148)."""
    data = read_host_paths()
    data.setdefault(ws_id, {})[slug] = str(path)
    p = _host_paths_path()
    try:
        p.write_text(json.dumps(data, indent=1, sort_keys=True))
    except OSError as exc:
        log.warning("host_paths write failed: %s", exc)


def _host_path_for(ws, slug: str) -> Path | None:
    raw = str((read_host_paths().get(ws.id) or {}).get(slug) or "")
    if raw:
        p = Path(raw)
        return p if p.is_dir() else None
    return None
