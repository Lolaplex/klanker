"""Klanker routines: LLM turns on a schedule, plus the serve ticker.

Job files live in ``AGENTS_SCHEDULES_DIR`` or ``~/.agents/schedules`` and use
``kind=routine``. The verb is ``python -m klanker routine run <name> --scheduled``
so a harness ``tick()`` that only knows verbs still runs them.

Same-minute duplicates share ``<job>.json.last``.

A harness that exposes ``register_routine_handler`` locks ``<schedules>/tick.lock``
inside ``tick()`` (blocking flock). This process must not flock that file: a
second fd in the same process deadlocks. The ticker calls ``tick()`` directly.

Older harness builds have no handler. The ticker then takes a non-blocking lock
on ``<schedules>/.tick.lock`` (a different file) so two Klanker processes do not
overlap. An external Coolify ``python -m runner.schedule tick`` does not share
that file. Delete that task in the same deploy as this image.

When the harness callback exists, this module registers it via
``register_routine_handler`` (or ``tick(run_routine=...)`` /
``tick(routine_handler=...)`` / ``set_routine_handler`` / ``set_run_routine``).
"""

from __future__ import annotations

import argparse
import contextlib
import inspect
import json
import logging
import os
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger("klanker.routine")

TICK_INTERVAL_SEC = 60
TICK_LOCK_NAME = ".tick.lock"
TRAILER = "---agents-loop-trailer---"
# Finish the turn before the harness job timeout so that timeout wins the race.
TURN_TIMEOUT_SLACK_SEC = 30
_HANDLER_READY = False

TurnFn = Callable[[dict[str, Any]], tuple[int, str]]
DeliverFn = Callable[[str, str], None]


def schedules_dir() -> Path:
    raw = os.environ.get("AGENTS_SCHEDULES_DIR", "").strip()
    if raw:
        path = Path(raw).expanduser()
    else:
        path = Path.home() / ".agents" / "schedules"
    path.mkdir(parents=True, exist_ok=True)
    return path


def tick_lock_path() -> Path:
    return schedules_dir() / TICK_LOCK_NAME


def ticker_enabled() -> bool:
    return os.environ.get("KLANKER_TICK", "1").strip().lower() not in ("0", "false", "no", "off")


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_\-\.]", "_", (name or "").strip())
    if not slug or slug in (".", ".."):
        raise ValueError("name is required")
    return slug


def is_no_update(text: str) -> bool:
    body = (text or "").strip()
    return body == "NO_UPDATE" or body.startswith("NO_UPDATE")


def extract_reply(stdout: str) -> str:
    text = stdout or ""
    if TRAILER in text:
        text = text.split(TRAILER, 1)[0]
    return text.strip()


def _zone(name: str):
    cleaned = (name or "").strip() or "UTC"
    try:
        return ZoneInfo(cleaned)
    except (ZoneInfoNotFoundError, ValueError, OSError, KeyError):
        return timezone.utc


def minute_key(job: dict[str, Any], now: datetime | None = None) -> str:
    tz = _zone(str(job.get("timezone") or os.environ.get("TZ") or "UTC"))
    current = now.astimezone(tz) if now else datetime.now(tz)
    return current.strftime("%Y-%m-%dT%H:%M")


def _lock_nb(fh: Any) -> bool:
    try:
        import fcntl
    except ImportError:
        fcntl = None  # type: ignore[assignment]
    if fcntl is not None:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False
    import msvcrt

    try:
        fh.seek(0)
        if fh.read(1) == b"":
            fh.write(b"\0")
            fh.flush()
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        return True
    except OSError:
        return False


def _lock_ex(fh: Any) -> None:
    try:
        import fcntl
    except ImportError:
        fcntl = None  # type: ignore[assignment]
    if fcntl is not None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        return
    import msvcrt

    fh.seek(0)
    if fh.read(1) == b"":
        fh.write(b"\0")
        fh.flush()
    fh.seek(0)
    msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)


def _unlock(fh: Any) -> None:
    try:
        import fcntl
    except ImportError:
        fcntl = None  # type: ignore[assignment]
    if fcntl is not None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        return
    import msvcrt

    try:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass


@contextlib.contextmanager
def tick_lock() -> Iterator[bool]:
    """Yield True when this process holds ``.tick.lock``, else False."""
    path = tick_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "a+b")
    owned = False
    try:
        owned = _lock_nb(fh)
        yield owned
    finally:
        if owned:
            _unlock(fh)
        fh.close()


@contextlib.contextmanager
def _job_lock(path: Path) -> Iterator[None]:
    lock_path = path.with_suffix(".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lock_path, "a+b")
    try:
        _lock_ex(fh)
        yield
    finally:
        _unlock(fh)
        fh.close()


def _stamp_path(path: Path) -> Path:
    return path.with_name(path.name + ".last")


def claim_minute(path: Path, minute: str, *, force: bool) -> bool:
    """Return True if this caller should run the routine for ``minute``."""
    stamp = _stamp_path(path)
    with _job_lock(path):
        current = stamp.read_text(encoding="utf-8").strip() if stamp.is_file() else ""
        if not force and current == minute:
            return False
        stamp.write_text(minute + "\n", encoding="utf-8")
        return True


def release_minute(path: Path, minute: str) -> None:
    stamp = _stamp_path(path)
    with _job_lock(path):
        if stamp.is_file() and stamp.read_text(encoding="utf-8").strip() == minute:
            stamp.unlink()


def _normalize_at(at: str, timezone_name: str) -> str:
    try:
        from runner.schedule import parse_due_time

        return parse_due_time(at, timezone_name=timezone_name).isoformat()
    except Exception:
        return at.strip()


def configured_timezone_name() -> str:
    """Job zone: harness ``configured_timezone()``, else ``AGENTS_TIMEZONE`` / ``TZ`` / UTC."""
    try:
        from runner.schedule import configured_timezone

        zone = str(configured_timezone() or "").strip()
        if zone:
            return zone
    except Exception:
        pass
    named = os.environ.get("AGENTS_TIMEZONE", "").strip()
    if named:
        return named
    return os.environ.get("TZ", "").strip() or "UTC"


def turn_timeout_sec(job: dict[str, Any]) -> int:
    """Subprocess budget strictly under the job's ``timeout_sec`` when that is > 1."""
    raw = job.get("timeout_sec")
    try:
        job_timeout = int(300 if raw in (None, "") else raw)
    except (TypeError, ValueError):
        job_timeout = 300
    job_timeout = max(1, job_timeout)
    if job_timeout <= 1:
        return 1
    margin = TURN_TIMEOUT_SLACK_SEC if job_timeout > TURN_TIMEOUT_SLACK_SEC else 1
    return job_timeout - margin


def harness_owns_tick_lock() -> bool:
    """True when ``tick()`` takes ``tick.lock`` itself (do not flock it here)."""
    try:
        from runner import schedule as sched
    except ImportError:
        return False
    return callable(getattr(sched, "register_routine_handler", None))


def add_routine(
    *,
    name: str = "",
    prompt: str = "",
    user: str = "",
    at: str | None = None,
    cron: str | None = None,
    timezone_name: str = "",
    timeout_sec: int = 300,
) -> dict[str, Any]:
    if not (prompt or "").strip():
        raise ValueError("prompt is required")
    if not (user or "").strip():
        raise ValueError("user is required")
    if not (at or cron):
        raise ValueError("at or cron is required")
    if at and cron:
        raise ValueError("pass either at or cron")
    slug = slugify(name) if (name or "").strip() else slugify(f"routine_{int(datetime.now(timezone.utc).timestamp())}")
    session = f"routine:{slug}"
    zone = (timezone_name or "").strip() or configured_timezone_name()
    manifest: dict[str, Any] = {
        "name": slug,
        "kind": "routine",
        "prompt": prompt.strip(),
        "user": str(user).strip(),
        "session": session,
        "verb": f"python -m klanker routine run {slug} --scheduled",
        "cadence": "one_shot" if at else "cron",
        "rests_on": f"Klanker routine {slug}",
        "expected_exit": 0,
        "timeout_sec": int(timeout_sec or 300),
        "one_shot": bool(at) and not bool(cron),
        "channel": "telegram",
        "timezone": zone,
    }
    if at:
        manifest["at"] = _normalize_at(at, zone)
        manifest["cadence"] = "one_shot"
        manifest["one_shot"] = True
    if cron:
        manifest["cron"] = cron.strip()
        manifest["cadence"] = "cron"
        manifest["one_shot"] = False
    path = schedules_dir() / f"{slug}.json"
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    manifest["_file"] = str(path)
    return manifest


def list_routines() -> list[dict[str, Any]]:
    root = schedules_dir()
    rows: list[dict[str, Any]] = []
    for path in sorted(root.glob("*.json")):
        if path.name.startswith("."):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("kind") == "routine":
            data["_file"] = str(path)
            rows.append(data)
    return rows


def job_path(name: str) -> Path:
    return schedules_dir() / f"{slugify(name)}.json"


def load_routine(name: str) -> dict[str, Any]:
    path = job_path(name)
    if not path.is_file():
        raise FileNotFoundError(name)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("kind") != "routine":
        raise ValueError(f"{name} is not a routine")
    data["_file"] = str(path)
    return data


def remove_routine(name: str) -> bool:
    path = job_path(name)
    if not path.is_file():
        return False
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("kind") != "routine":
        raise ValueError(f"{name} is not a routine")
    path.unlink()
    stamp = _stamp_path(path)
    if stamp.is_file():
        stamp.unlink()
    return True


def default_turn(job: dict[str, Any]) -> tuple[int, str]:
    from .prompt import save_system_prompt
    from .sensing import probe_host

    prompt_file = save_system_prompt(probe_host())
    user = str(job.get("user") or "").strip()
    session = str(job.get("session") or f"routine:{job.get('name')}")
    message = str(job.get("prompt") or "")
    provider = os.environ.get("LOOP_PROVIDER", "openai.default") or "openai.default"
    timeout = turn_timeout_sec(job)
    cmd = [
        sys.executable,
        "-m",
        "klanker.turn",
        "--channel",
        "telegram" if user else "local",
        "--user",
        user or "routine",
        "--session",
        session,
        "--message",
        message,
        "--system",
        str(prompt_file),
        "--complete",
        "--provider",
        provider,
        "--deliver",
        "buffered",
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return int(proc.returncode), extract_reply(proc.stdout or "")


def deliver_reply(user: str, text: str) -> None:
    target = str(user).strip()
    if not target:
        raise ValueError("user is required to deliver")
    chat_id = int(target)
    try:
        from agents_relay.config import RelayConfig
        from agents_relay.telegram_adapter import send_to_user
    except ImportError:
        proc = subprocess.run(
            [sys.executable, "-m", "agents_relay", "send", "--user", target, "--text", text],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "send failed").strip()
            raise RuntimeError(detail)
        return
    cfg = RelayConfig.from_env()
    _send_to_user(send_to_user, cfg, chat_id, text)


def _send_to_user(send_to_user: Callable[..., Any], cfg: Any, chat_id: int, text: str) -> None:
    """Pass ``allow_anyone`` when this relay build accepts it."""
    kwargs: dict[str, Any] = {
        "token": cfg.telegram_bot_token,
        "chat_id": chat_id,
        "text": text,
        "allowed": cfg.telegram_allowed_chat_ids,
    }
    try:
        accepted = inspect.signature(send_to_user).parameters
    except (TypeError, ValueError):
        accepted = {}
    if "allow_anyone" in accepted:
        kwargs["allow_anyone"] = cfg.allow_anyone
    send_to_user(**kwargs)


def perform_routine(
    job: dict[str, Any],
    *,
    force: bool = False,
    turn: TurnFn | None = None,
    deliver: DeliverFn | None = None,
    under_harness: bool = False,
) -> dict[str, Any]:
    """Run one routine turn. Drop ``NO_UPDATE``. Otherwise deliver via relay.

    ``under_harness`` is the in-process handler. Harness already records the
    attempt, so clearing the minute stamp on failure does not schedule a retry.
    The verb path (``--scheduled``) still releases the stamp so a failed run
    can be tried again in that minute.
    """
    path = Path(str(job.get("_file") or job_path(str(job.get("name") or ""))))
    minute = minute_key(job)
    if not claim_minute(path, minute, force=force):
        return {"status": "skipped", "reply": "", "name": job.get("name")}
    runner = turn or default_turn
    sender = deliver or deliver_reply

    def _release() -> None:
        if under_harness:
            return
        release_minute(path, minute)

    try:
        code, reply = runner(job)
    except Exception:
        _release()
        raise
    if code != 0:
        _release()
        return {"status": "failed", "reply": reply, "name": job.get("name")}
    if is_no_update(reply) or not reply.strip():
        _consume_one_shot(job, path)
        return {"status": "no_update" if reply.strip() else "empty", "reply": reply, "name": job.get("name")}
    user = str(job.get("user") or "").strip()
    try:
        if user:
            sender(user, reply)
        else:
            print(reply)
    except Exception:
        _release()
        raise
    _consume_one_shot(job, path)
    return {
        "status": "delivered" if user else "local",
        "reply": reply,
        "name": job.get("name"),
    }


def _consume_one_shot(job: dict[str, Any], path: Path) -> None:
    if not job.get("one_shot"):
        return
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            log.warning("could not remove one-shot routine %s", path)


def routine_handler(job: dict[str, Any]) -> dict[str, Any]:
    return perform_routine(job, force=False, under_harness=True)


def _register_once(sched: Any, handler: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
    global _HANDLER_READY
    if _HANDLER_READY:
        return
    for name in ("register_routine_handler", "set_routine_handler", "set_run_routine"):
        fn = getattr(sched, name, None)
        if callable(fn):
            fn(handler)
            _HANDLER_READY = True
            return


def default_tick() -> None:
    try:
        from runner import schedule as sched
    except ImportError:
        log.warning("agents-harness not installed; schedule tick skipped")
        return
    handler = routine_handler
    tick = sched.tick
    kwargs: dict[str, Any] = {}
    try:
        params = inspect.signature(tick).parameters
    except (TypeError, ValueError):
        params = {}
    if "run_routine" in params:
        kwargs["run_routine"] = handler
    elif "routine_handler" in params:
        kwargs["routine_handler"] = handler
    else:
        _register_once(sched, handler)
    tick(**kwargs)


def run_due_schedules(tick_fn: Callable[[], None] | None = None) -> bool:
    """Run one tick.

    New harness locks ``tick.lock`` inside ``tick()``. Skip the outer
    ``.tick.lock`` in that case. Older harness still uses the outer lock.
    Return False only when that older lock is already held.
    """
    if harness_owns_tick_lock():
        (tick_fn or default_tick)()
        return True
    with tick_lock() as owned:
        if not owned:
            log.info("schedule tick skipped; %s is held", tick_lock_path())
            return False
        (tick_fn or default_tick)()
        return True


def start_ticker() -> threading.Event | None:
    """Daemon thread: tick immediately, then every 60s. ``KLANKER_TICK=0`` disables."""
    if not ticker_enabled():
        log.info("schedule ticker disabled (KLANKER_TICK=0)")
        return None
    stop = threading.Event()

    def _loop() -> None:
        while not stop.is_set():
            try:
                run_due_schedules()
            except Exception:
                log.exception("schedule tick failed")
            if stop.wait(TICK_INTERVAL_SEC):
                return

    threading.Thread(target=_loop, name="klanker-tick", daemon=True).start()
    return stop


def dispatch(args: argparse.Namespace) -> int:
    cmd = getattr(args, "routine_cmd", None)
    try:
        if cmd == "add":
            row = add_routine(
                name=args.name,
                prompt=args.prompt,
                user=args.user,
                at=args.at or None,
                cron=args.cron or None,
                timezone_name=args.timezone_name,
                timeout_sec=args.timeout_sec,
            )
            print(json.dumps(row, indent=2, ensure_ascii=False))
            return 0
        if cmd == "list":
            print(json.dumps(list_routines(), indent=2, ensure_ascii=False))
            return 0
        if cmd == "remove":
            ok = remove_routine(args.name)
            if not ok:
                print(f"Routine '{args.name}' not found", file=sys.stderr)
                return 1
            print(f"Removed routine '{args.name}'")
            return 0
        if cmd == "run":
            job = load_routine(args.name)
            force = bool(args.force or not args.scheduled)
            result = perform_routine(job, force=force)
            status = result["status"]
            if status == "skipped":
                print("skipped")
                return 0
            if status == "no_update":
                print("NO_UPDATE")
                return 0
            if status == "failed":
                print(result.get("reply") or "routine failed", file=sys.stderr)
                return 1
            if status == "delivered":
                print(result.get("reply") or "")
            return 0
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print("usage: klanker routine add|list|remove|run", file=sys.stderr)
    return 2
