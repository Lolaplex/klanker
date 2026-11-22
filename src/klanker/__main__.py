"""Klanker CLI."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .nucleus import Nucleus
from .sensing import probe_host

log = logging.getLogger("klanker")


def note_custom_loop_cmd() -> None:
    """A pre-set LOOP_CMD skips Klanker's prompt file and ``klanker.turn`` shims."""
    custom = os.environ.get("LOOP_CMD", "").strip()
    if not custom:
        return
    log.warning(
        "LOOP_CMD=%s bypasses Klanker's system prompt and argv shims (klanker.turn)",
        custom,
    )


def _maybe_generate_web_token(no_auth: bool) -> str:
    """Secure-by-default web token: mint once per host, print URL, else "".

    An explicit ``RELAY_WEB_TOKEN`` always wins. ``--no-auth`` or
    ``RELAY_NO_AUTH=1`` is the only way to serve unprotected. Otherwise the
    token is stored in the host secret vault (``RELAY_WEB_TOKEN``,
    ``scope="host"``) with a one-release read-only fallback to legacy
    ``~/.klanker/relay-secret``.
    """
    no_auth = no_auth or os.environ.get("RELAY_NO_AUTH", "").strip().lower() in (
        "1", "true", "yes")
    if os.environ.get("RELAY_WEB_TOKEN") or no_auth:
        return ""
    import secrets

    from agents_workspace import Host, resolve_secret, write_secret

    host_obj = Host.from_env()
    token = resolve_secret("RELAY_WEB_TOKEN", host=host_obj, scope="host").strip()
    need_persist = False
    if not token:
        pin = Path.home() / ".klanker" / "relay-secret"
        try:
            token = pin.read_text("utf-8").strip()
        except OSError:
            token = ""
        if token:
            need_persist = True
    if not token:
        token = secrets.token_urlsafe(24)
        need_persist = True
    if need_persist:
        try:
            write_secret("RELAY_WEB_TOKEN", token, host=host_obj, scope="host")
        except OSError as exc:
            log.warning("failed to persist RELAY_WEB_TOKEN to host vault: %s", exc)
    os.environ["RELAY_WEB_TOKEN"] = token
    os.environ.setdefault("RELAY_SECRET", token)
    bind_host = os.environ.get("RELAY_HOST", "127.0.0.1")
    port = os.environ.get("RELAY_PORT", "8787")
    return f"http://{bind_host}:{port}/?token={token}"


def apply_workdir(raw: str | None) -> int | None:
    """Point this process and its spawned turns at a working directory.

    ``--workdir`` is the session cwd/jail (``AGENTS_WORKDIR``). Returns an
    exit code when the path is unusable, otherwise ``None``.
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        resolved = Path(text).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        print(f"Error: workdir does not exist: {text}", file=sys.stderr)
        return 2
    if not resolved.is_dir():
        print(f"Error: workdir is not a directory: {text}", file=sys.stderr)
        return 2
    os.environ["AGENTS_WORKDIR"] = str(resolved)
    os.environ["AGENTS_WORKDIR_LOCK"] = "1"
    return None


def apply_workspace(raw: str | None) -> int | None:
    """Select the data workspace by id (``AGENTS_WORKSPACE=<id>``).

    An existing directory is accepted one release as the old workdir meaning
    (``--workdir`` now), with a deprecation warning.
    """
    text = (raw or "").strip()
    if not text:
        return None
    import warnings

    from agents_workspace import Host

    host = Host.from_env()
    if host.workspace_exists(text):
        os.environ["AGENTS_WORKSPACE"] = text
        return None
    candidate = Path(text).expanduser()
    if candidate.is_dir():
        warnings.warn(
            "--workspace <dir> is deprecated as a workdir; "
            "use --workdir for a directory and --workspace <id> for a "
            "data workspace (alias removed after one release)",
            DeprecationWarning,
        )
        os.environ["AGENTS_WORKDIR"] = str(candidate.resolve())
        os.environ["AGENTS_WORKDIR_LOCK"] = "1"
        return None
    print(f"Error: unknown workspace id: {text}", file=sys.stderr)
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="klanker",
        description="Klanker — Adaptive Agent Shell",
    )
    parser.add_argument("--user", type=str, default="user", help="User alias")
    parser.add_argument("--provider", type=str, default=None, help="LLM provider")
    parser.add_argument("--seal", action="store_true", help="Cryptographically seal tool trace records")
    parser.add_argument(
        "--workspace",
        default=None,
        help="Data workspace id (AGENTS_WORKSPACE); a directory is accepted once as deprecated --workdir alias",
    )
    parser.add_argument(
        "--workdir",
        default=None,
        help="Working directory for this session and spawned turns (AGENTS_WORKDIR)",
    )
    parser.add_argument(
        "--remote",
        default="",
        help="Registered remote id (<host>/clients/remotes.json); connects instead of the local daemon",
    )

    sub = parser.add_subparsers(dest="command")

    # 1. Sense host capabilities
    sense_p = sub.add_parser("sense", help="Probe host environment and available feelers")
    sense_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 1b. Dump system prompt
    prompt_p = sub.add_parser("prompt", help="Print the dynamic Klanker system prompt")
    prompt_p.add_argument(
        "--workspace",
        default=None,
        help="Data workspace id (AGENTS_WORKSPACE)",
    )

    # 1b2. Health check
    doctor_p = sub.add_parser("doctor", help="Check config, keys, MCP health, tokens, disk and suite versions")
    doctor_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 1b3. Pull suite packages to latest refs/releases
    update_p = sub.add_parser("update", help="Update all suite packages (git checkouts pull, installs upgrade)")

    drift_p = sub.add_parser("drift", help="Suite drift check vs remote ref (--deploy triggers host deploy on drift)")
    drift_p.add_argument("--ref", default="", help="Suite ref to compare (default: SUITE_REF or dev)")
    drift_p.add_argument("--deploy", action="store_true", help="Trigger host deploy path on drift")
    update_p.add_argument("--check", action="store_true", help="Show the update plan without running it")

    # 1b4. Detached background runner
    bg_p = sub.add_parser("bg", help="Spawn a detached background turn (klanker ps/logs/kill)")
    bg_p.add_argument("task", type=str, help="Task for the background turn")
    bg_p.add_argument("--workspace", default=argparse.SUPPRESS, help="Data workspace id (AGENTS_WORKSPACE)")
    bg_p.add_argument("--workdir", default=argparse.SUPPRESS, help="Working directory (AGENTS_WORKDIR)")
    ps_p = sub.add_parser("ps", help="List background sessions")
    ps_p.add_argument("--workspace", default=argparse.SUPPRESS, help="Filter by workspace id")
    logs_p = sub.add_parser("logs", help="Print a background session's log")
    logs_p.add_argument("id", type=str, help="bg_<id> session id")
    logs_p.add_argument("-f", "--follow", action="store_true", help="Follow the log until the child exits")
    logs_p.add_argument("-n", "--lines", type=int, default=0, help="Only the last N lines")
    kill_p = sub.add_parser("kill", help="Kill a running background session")
    kill_p.add_argument("id", type=str, help="bg_<id> session id")
    bgrun_p = sub.add_parser("_bg-run", help=argparse.SUPPRESS)
    bgrun_p.add_argument("id", type=str)

    # 1c. Audit trace integrity & replay
    audit_p = sub.add_parser("audit", help="Audit trace integrity and replay verification via agents-traces")
    audit_p.add_argument("target", type=str, nargs="?", default="", help="Session ID, trace file path, or empty for all")
    audit_p.add_argument("--json", action="store_true", help="Output JSON format")

    # 2. Interactive or one-turn chat (alias)
    chat_p = sub.add_parser("chat", help="Chat with Klanker (spawns harness turn)")
    chat_p.add_argument("message", type=str, nargs="?", default="", help="Message content")
    chat_p.add_argument("--user", type=str, default="user", help="User alias")
    chat_p.add_argument("--provider", type=str, default=None, help="LLM provider")
    chat_p.add_argument("--seal", action="store_true", help="Cryptographically seal tool trace records")
    chat_p.add_argument(
        "--workspace",
        default=None,
        help="Data workspace id (AGENTS_WORKSPACE)",
    )
    chat_p.add_argument(
        "--workdir",
        default=None,
        help="Working directory for the spawned turn (AGENTS_WORKDIR)",
    )
    chat_p.add_argument(
        "--persona",
        default="",
        help="Persona id for this turn (<ws>/personas/<id> or package; default: AGENTS_PERSONA or ws default_persona)",
    )
    chat_p.add_argument(
        "--resume",
        default="",
        help="Resume an existing session id (ses_…)",
    )
    chat_p.add_argument(
        "--fork",
        action="store_true",
        help="With --resume: branch that session's history into a new session instead of continuing it",
    )

    # 3. Serve gateway
    serve_p = sub.add_parser("serve", help="Start I/O Gateway (HTTP /v1/turn & Telegram)")
    serve_p.add_argument("--no-telegram", action="store_true", help="Disable Telegram polling")
    serve_p.add_argument(
        "--no-auth",
        action="store_true",
        help="Run the web surface without a token (explicit opt-out; RELAY_NO_AUTH=1 works too)",
    )

    # 3b. Interactive agent shell (client of a running relay)
    shell_p = sub.add_parser("shell", help="Interactive shell — builtins, exec, agent tier via relay")
    shell_p.add_argument("--plain", action="store_true", help="Force line-based UI (no TUI)")
    shell_p.add_argument("--stream", action="store_true", help="Stream agent replies (SSE /v1/stream)")
    shell_p.add_argument("--url", default="http://127.0.0.1:8787", help="Relay base URL")
    shell_p.add_argument("--secret", default="", help="Relay secret (X-Gateway-Secret)")
    shell_p.add_argument("--user", type=str, default="local", help="User alias")
    shell_p.add_argument("--project", type=str, default="", help="Project name")
    shell_p.add_argument("--provider", type=str, default="", help="LLM provider")
    shell_p.add_argument("--persona", type=str, default="default", help="Persona")
    shell_p.add_argument("--session", type=str, default="", help="Resume session id")
    shell_p.add_argument("--workspace", type=str, default="", help="Data workspace id (AGENTS_WORKSPACE)")
    shell_p.add_argument("--no-gateway", action="store_true", help="Builtins/exec only, no agent tier")

    # 3c. Stop the local daemon
    sub.add_parser("stop", help="Stop the local klanker daemon (pid file)")

    # 3d. Personas (equal, workspace-scoped)
    persona_p = sub.add_parser("persona", help="List or add personas in a workspace")
    persona_sub = persona_p.add_subparsers(dest="persona_cmd")
    persona_list = persona_sub.add_parser("list", help="List personas in the workspace")
    persona_list.add_argument("--workspace", default="", help="Data workspace id")
    persona_add = persona_sub.add_parser("add", help="Add an equal persona")
    persona_add.add_argument("id", help="Persona id (ids only: no paths, no labels)")
    persona_add.add_argument("--workspace", default="", help="Data workspace id")
    persona_add.add_argument("--role", default="", help="Role description (text, not a layer)")
    persona_add.add_argument("--system-append", default="", dest="system_append", help="System prompt fragment")
    persona_inbox = persona_sub.add_parser("inbox", help="List tasks in a persona's inbox")
    persona_inbox.add_argument("id", help="Persona id")
    persona_inbox.add_argument("--workspace", default="", help="Data workspace id")
    persona_task = persona_sub.add_parser("task", help="Create a task owned by a persona")
    persona_task.add_argument("id", help="Persona id (task owner)")
    persona_task.add_argument("title", help="Task title")
    persona_task.add_argument("--note", default="", help="Free-form note")
    persona_task.add_argument("--user", default="", help="Creating user")
    persona_task.add_argument("--workspace", default="", help="Data workspace id")
    persona_hand = persona_sub.add_parser("handoff", help="Move a task to another persona (explicit ownership)")
    persona_hand.add_argument("task", help="Task id (tsk_...)")
    persona_hand.add_argument("--to", required=True, help="Target persona id")
    persona_hand.add_argument("--from", dest="from_persona", default="", help="Expected current owner (fails on mismatch)")
    persona_hand.add_argument("--note", default="", help="Handoff note")
    persona_hand.add_argument("--workspace", default="", help="Data workspace id")

    # 3d2. Import agent assets from other CLIs
    import_p = sub.add_parser("import", help="Import ~/.claude, ~/.codex, ~/.cursor rules/skills/mcp into a workspace")
    import_p.add_argument("--from", dest="source", choices=["all", "claude", "codex", "cursor"], default="all")
    import_p.add_argument("--workspace", default="", help="Data workspace id")
    import_p.add_argument("--apply", action="store_true", help="Write the import (default: preview only)")

    # 3d3. Fold file domains into the workspace store.db
    migrate_p = sub.add_parser(
        "migrate", help="Migrate file domains into store.db datoms")
    migrate_p.add_argument(
        "--to-store", action="store_true", required=True,
        help="Import personas/config/memory into <ws>/store.db")
    migrate_p.add_argument(
        "--workspace", default="", help="Data workspace id (default: env)")
    migrate_p.add_argument(
        "--keep-files", action="store_true",
        help="Do not archive sources to <ws>/archive/pre-store/")

    # 3e. Workspaces
    ws_p = sub.add_parser("workspace", help="Create or list workspaces")
    ws_sub = ws_p.add_subparsers(dest="ws_cmd")
    ws_create = ws_sub.add_parser("create", help="Create a workspace")
    ws_create.add_argument("id", help="Workspace id")
    ws_create.add_argument("--label", default="", help="Display label")
    ws_create.add_argument(
        "--isolation", choices=["local", "container"], default="",
        help="Isolation backend (default: AGENTS_WS_ISOLATION or local)")
    ws_create.add_argument("--image", default="", help="Container image (isolation=container)")
    ws_sub.add_parser("list", help="List workspaces")

    # 4. Run background cron / scheduled flows
    cron_p = sub.add_parser("cron", help="Run scheduled care flows via harness executor")
    cron_p.add_argument("op", nargs="?", default="", help="'add' synthesises a new flow manifest")
    cron_p.add_argument("--flow", type=str, default="", help="Run specific flow name")
    cron_p.add_argument("--name", default="", help="Flow name/slug")
    cron_p.add_argument("--verb", default="", help="Direct command to execute (e.g. 'python -m agents_traces audit')")
    cron_p.add_argument("--text", default="", help="Reminder text (turns into a runner.loop verb with --sched-user/--channel)")
    cron_p.add_argument("--prompt", default="", help="Routine prompt (full LLM turn) instead of a fixed verb")
    cron_p.add_argument("--channel", default="", help="Target channel for --text")
    cron_p.add_argument("--sched-user", dest="sched_user", default="", help="Target user for --text/--prompt")
    cron_p.add_argument("--at", default="", help="Due time ISO or relative (+10m)")
    cron_p.add_argument("--cron", default="", help="5-part cron expression")
    cron_p.add_argument("--natural", default="", help="Natural-language schedule ('every morning 8', 'weekdays 9', 'in 30 minutes')")
    cron_p.add_argument("--cadence", default="", help="Cadence name (hourly, daily, …)")
    cron_p.add_argument("--timezone", default="", dest="timezone_name")
    cron_p.add_argument("--timeout", type=int, default=None, dest="timeout_sec")
    cron_p.add_argument("--grace", type=int, default=None, dest="grace_min")
    cron_p.add_argument("--session", default="", help="Routine session id")
    cron_p.add_argument("--one-shot", action="store_true", help="Delete manifest after execution")
    cron_p.add_argument("--apply", action="store_true", help="Register the manifest live (default: dry-run validation only)")

    # 5. LLM routines (scheduled turns)
    routine_p = sub.add_parser("routine", help="Manage LLM routines (scheduled full turns)")
    routine_sub = routine_p.add_subparsers(dest="routine_cmd")
    routine_add = routine_sub.add_parser("add", help="Add a routine")
    routine_add.add_argument("--name", default="")
    routine_add.add_argument("--prompt", default="")
    routine_add.add_argument("--user", default="")
    routine_add.add_argument("--channel", default="", help="Originating channel (http, telegram, local, …)")
    routine_add.add_argument("--at", default="")
    routine_add.add_argument("--cron", default="")
    routine_add.add_argument("--timezone", default="", dest="timezone_name")
    routine_add.add_argument("--timeout", type=int, default=None, dest="timeout_sec", help="Job timeout in seconds (default: approval wait + 330s)")
    routine_add.add_argument("--workspace", default="", help="Workspace id")
    routine_say = routine_sub.add_parser("say", help="Create a routine from one sentence plus --at or --cron")
    routine_say.add_argument("prompt", help="Prompt sentence")
    routine_say.add_argument("--name", default="")
    routine_say.add_argument("--user", default="", help="Target user (default: KLANKER_USER or local)")
    routine_say.add_argument("--channel", default="", help="Originating channel (http, telegram, local, …)")
    routine_say.add_argument("--at", default="", help="Due time ISO or relative (+10m)")
    routine_say.add_argument("--cron", default="")
    routine_say.add_argument("--timezone", default="", dest="timezone_name")
    routine_say.add_argument("--timeout", type=int, default=None, dest="timeout_sec")
    routine_say.add_argument("--workspace", default="", help="Workspace id")
    routine_sub.add_parser("list", help="List routines")
    routine_pause = routine_sub.add_parser("pause", help="Keep a routine and stop it firing")
    routine_pause.add_argument("name")
    routine_resume = routine_sub.add_parser("resume", help="Let a paused routine fire again")
    routine_resume.add_argument("name")
    routine_rm = routine_sub.add_parser("remove", help="Remove a routine")
    routine_rm.add_argument("name")
    routine_run = routine_sub.add_parser("run", help="Run a routine now")
    routine_run.add_argument("name")
    routine_run.add_argument("--scheduled", action="store_true", help="Respect same-minute dedupe (ticker path)")
    routine_run.add_argument("--force", action="store_true", help="Run even if this minute already ran")

    evidence_p = sub.add_parser(
        "evidence",
        help="List routine outputs and workspace files by day (read-only)",
    )
    evidence_p.add_argument("--from", dest="date_from", required=True, help="First day YYYY-MM-DD (inclusive)")
    evidence_p.add_argument("--to", dest="date_to", required=True, help="Last day YYYY-MM-DD (inclusive)")
    evidence_p.add_argument("--json", action="store_true", help="Print the coverage report as JSON")
    evidence_p.add_argument(
        "--root",
        action="append",
        default=[],
        help="Extra directory to scan (repeatable). Does not search memory or traces.",
    )

    remote_p = sub.add_parser("remote", help="Manage remote klanker hosts (list/add/rm)")
    remote_sub = remote_p.add_subparsers(dest="remote_cmd")
    remote_list = remote_sub.add_parser("list", help="List registered remotes")
    remote_list.add_argument("--json", action="store_true", help="Print JSON")
    remote_add = remote_sub.add_parser("add", help="Register a remote host")
    remote_add.add_argument("name", help="Display name (also the default id slug)")
    remote_add.add_argument("url", help="Remote base URL (http/https)")
    remote_add.add_argument("--id", default="", help="Explicit remote id slug")
    remote_add.add_argument("--token", default="", help="Remote token (prefer --token-stdin)")
    remote_add.add_argument("--token-stdin", action="store_true", help="Read token from stdin")
    remote_add.add_argument("--prompt", action="store_true", help="Ask for the token via getpass")
    remote_rm = remote_sub.add_parser("rm", help="Remove a remote and its vault token")
    remote_rm.add_argument("id", help="Remote id")
    remote_pair = remote_sub.add_parser("pair", help="Pair a remote host using a single-use code")
    remote_pair.add_argument("name", help="Display name (also default id slug)")
    remote_pair.add_argument("url", help="Remote base URL (http/https)")
    remote_pair.add_argument("code", nargs="?", default="", help="One-time pairing code")
    remote_pair.add_argument("--id", default="", help="Explicit remote id slug")

    pair_p = sub.add_parser("pair", help="Create a single-use 60s pairing code/QR for Web or remote CLI")
    pair_p.add_argument("--remote", action="store_true", help="Mint a remote CLI pairing code")
    pair_p.add_argument("--ttl", type=int, default=60, help="Validity window in seconds (15-120)")

    return parser


KNOWN_SUBCOMMANDS = {
    "sense",
    "prompt",
    "serve",
    "shell",
    "stop",
    "cron",
    "chat",
    "remind",
    "audit",
    "doctor",
    "update",
    "drift",
    "routine",
    "remote",
    "pair",
    "evidence",
    "persona",
    "workspace",
    "import",
    "migrate",
    "bg",
    "ps",
    "logs",
    "kill",
    "-h",
    "--help",
}


def parse_cli_args(argv: list[str] | None = None) -> tuple[argparse.Namespace, str]:
    """Parse CLI arguments allowing both subcommands and direct prompts."""
    raw_args = list(sys.argv[1:] if argv is None else argv)
    direct_prompt = ""

    # If first positional argument is not a known subcommand or flag, treat it as direct prompt
    if raw_args and not raw_args[0].startswith("-") and raw_args[0] not in KNOWN_SUBCOMMANDS:
        direct_prompt = raw_args.pop(0)

    parser = build_parser()
    parsed = parser.parse_args(raw_args)
    return parsed, direct_prompt


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] == "remind":
        from .overlay import install_overlay
        from . import remind
        install_overlay(generate=False)
        return remind.main(raw[1:])
    args, direct_prompt = parse_cli_args(argv)
    workspace_error = apply_workspace(getattr(args, "workspace", None))
    if workspace_error is not None:
        return workspace_error
    workdir_error = apply_workdir(getattr(args, "workdir", None))
    if workdir_error is not None:
        return workdir_error
    try:
        from . import __version__
        from .updates import check_for_updates
        check_for_updates("klanker", __version__)
    except Exception:
        pass
    nucleus = Nucleus()

    if args.command == "sense":
        summary = nucleus.sense()
        if args.json:
            print(json.dumps(summary, indent=2))
        else:
            print("Klanker Host Sensing:")
            for k, v in summary.items():
                print(f"  * {k}: {v}")
        return 0

    elif args.command == "prompt":
        from .prompt import build_system_prompt
        print(build_system_prompt(nucleus.caps))
        return 0

    elif args.command == "persona":
        from agents_workspace import Host
        from agents_relay.workspaces import create_persona, list_personas

        host = Host.from_env()
        ws_ref = getattr(args, "workspace", "") or ""
        if ws_ref and not host.workspace_exists(ws_ref):
            print(f"Error: unknown workspace: {ws_ref}", file=sys.stderr)
            return 2
        try:
            ws = host.workspace(ws_ref) if ws_ref else host.select_workspace()
        except (KeyError, ValueError, RuntimeError) as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2
        cmd = getattr(args, "persona_cmd", "")
        if cmd in ("inbox", "task", "handoff"):
            from agents_workspace.inbox import create_task, handoff, list_inbox
            if cmd == "inbox":
                rows = list_inbox(ws, args.id)
                for row in rows:
                    note = row.get("note") or ""
                    suffix = f" — {note}" if note else ""
                    print(f"{row['id']}  {row.get('title','')}{suffix}")
                return 0
            if cmd == "task":
                try:
                    task = create_task(
                        ws, args.id, args.title,
                        note=getattr(args, "note", "") or "",
                        user=getattr(args, "user", "") or "",
                    )
                except ValueError as exc:
                    print(f"Error: {exc}", file=sys.stderr)
                    return 2
                print(f"task {task['id']} -> {task['owner']}: {task.get('title','')}")
                return 0
            try:
                task = handoff(
                    ws, args.task, args.to,
                    from_persona=getattr(args, "from_persona", "") or "",
                    note=getattr(args, "note", "") or "",
                )
            except ValueError as exc:
                print(f"Error: {exc}", file=sys.stderr)
                return 2
            print(f"task {task['id']} -> {task['owner']}")
            return 0
        if cmd == "add":
            pid = args.id.strip()
            from agents_relay.turn import valid_id
            if not valid_id(pid):
                print(f"Error: invalid persona id: {pid!r}", file=sys.stderr)
                return 2
            row = create_persona(ws, pid, {
                "role": getattr(args, "role", "") or "",
                "system_append": getattr(args, "system_append", "") or "",
            })
            print(f"persona {pid} added to workspace {ws.id}")
            return 0
        rows = list_personas(ws)
        for row in rows:
            rid = row.get("id", "?")
            role = row.get("role") or ""
            suffix = f" — {role}" if role else ""
            print(f"{rid}{suffix}")
        return 0

    elif args.command == "import":
        from .importer import run as import_run

        return import_run(
            source=getattr(args, "source", "all") or "all",
            workspace=getattr(args, "workspace", "") or "",
            apply=bool(getattr(args, "apply", False)),
        )

    elif args.command == "migrate":
        from agents_workspace import Workspace

        from .migrate import migrate_to_store

        ws_id = getattr(args, "workspace", "") or ""
        if ws_id:
            from agents_workspace import Host

            ws = Host.from_env().workspace(ws_id)
        else:
            ws = Workspace.from_env()
        stats = migrate_to_store(ws.dir, archive=not args.keep_files)
        for domain, s in stats.items():
            line = ", ".join(f"{k}={v}" for k, v in s.items())
            print(f"{domain}: {line}")
        return 0

    elif args.command == "workspace":
        from agents_workspace import Host

        host = Host.from_env()
        cmd = getattr(args, "ws_cmd", "") or ""
        if cmd == "create":
            from agents_relay.turn import valid_id
            wid = args.id.strip()
            if not valid_id(wid):
                print(f"Error: invalid workspace id: {wid!r}", file=sys.stderr)
                return 2
            if host.workspace_exists(wid):
                print(f"Error: workspace exists: {wid}", file=sys.stderr)
                return 2
            ws = host.create(
                wid,
                getattr(args, "label", "") or "",
                isolation=getattr(args, "isolation", "") or "",
                image=getattr(args, "image", "") or "",
            )
            print(f"workspace {ws.id} created")
            return 0
        for w in host.list_workspaces():
            iso = getattr(w, "isolation", "") or "local"
            print(f"{w.id}  {w.label or ''}  isolation={iso}")
        return 0

    elif args.command == "doctor":
        from .doctor import run as doctor_run

        return doctor_run(as_json=bool(getattr(args, "json", False)))

    elif args.command == "update":
        from .suite_update import run as update_run

        return update_run(check=bool(getattr(args, "check", False)))

    elif args.command == "drift":
        from .drift import main as drift_main

        drift_argv = []
        if getattr(args, "ref", ""):
            drift_argv += ["--ref", args.ref]
        if getattr(args, "deploy", False):
            drift_argv.append("--deploy")
        return drift_main(drift_argv)

    elif args.command == "audit":
        if not nucleus.caps.has_traces:
            print("Error: agents-traces is not installed. Install via pip install agents-traces", file=sys.stderr)
            return 1
        from agents_traces.__main__ import main as traces_main
        sub_argv = ["audit"]
        if getattr(args, "target", ""):
            sub_argv.append(args.target)
        if getattr(args, "json", False):
            sub_argv.append("--json")
        return traces_main(sub_argv)

    elif args.command == "serve":
        if not (nucleus.caps.has_relay or nucleus.caps.has_gateway):
            print("Error: agents-relay is not installed. Install via pip install agents-relay", file=sys.stderr)
            return 1

        from agents_workspace import Host, Workspace

        from .gating import apply_approval_env, telegram_refusal, telegram_would_poll
        from .overlay import ensure_workspace_overlay

        refusal = telegram_refusal(no_telegram=bool(getattr(args, "no_telegram", False)))
        if refusal:
            print(f"Error: {refusal}", file=sys.stderr)
            return 1

        host = Host.from_env()
        if host.has_legacy_layout():
            print(
                "Error: legacy host layout detected. Run "
                "`agents-workspace migrate` first (explicit, one-shot).",
                file=sys.stderr,
            )
            return 1

        entry_ws = host.resolve_entry_workspace()
        entry_ws.ensure()
        for _ws in Workspace.list_all():
            ensure_workspace_overlay(_ws)
        # Children spawned without an explicit workspace inherit this
        # workspace's context; per-request turns override it via ws.env().
        os.environ.update(entry_ws.env())
        telegram_on = telegram_would_poll(no_telegram=bool(getattr(args, "no_telegram", False)))
        apply_approval_env(telegram=telegram_on)

        # If LOOP_CMD is default and harness is present, klanker.turn builds
        # the system prompt per turn for the request's workspace — no frozen
        # entry-workspace prompt is baked into the command here.
        # klanker.turn installs argv shims, then runs runner.loop.
        note_custom_loop_cmd()
        if "LOOP_CMD" not in os.environ and nucleus.caps.has_harness:
            os.environ["LOOP_CMD"] = f"{sys.executable} -m klanker.turn"

        if nucleus.caps.has_harness:
            from .routine import start_ticker

            start_ticker()

        # Dashboard: vendored wheel assets are served when no explicit dir is
        # configured. Static serving itself stays gated on RELAY_WEB_TOKEN.
        if "AGENTS_RELAY_WEB_DIR" not in os.environ and "RELAY_STATIC_DIR" not in os.environ:
            from .web_assets import default_web_dir

            web_dir = default_web_dir()
            if web_dir is not None:
                os.environ["AGENTS_RELAY_WEB_DIR"] = str(web_dir)

        from . import mgmt as _mgmt

        if not _mgmt.install():
            log.warning("management routes unavailable: agents-relay not importable")

        # Secure by default: no explicit token means an ephemeral one per serve,
        # printed once Jupyter-style when interactive. Non-TTY output (e.g. serve.log)
        # omits the query token so secrets never land in log files.
        url = _maybe_generate_web_token(getattr(args, "no_auth", False))
        if url:
            if sys.stdout.isatty():
                print(f"klanker serve -> {url}", flush=True)
            else:
                safe_url = url.split("?", 1)[0]
                print(f"klanker serve -> {safe_url} (token stored in host vault)", flush=True)
        elif not os.environ.get("RELAY_WEB_TOKEN"):
            print("klanker serve: warning — web auth disabled (--no-auth)", flush=True)

        from agents_relay.__main__ import main as relay_main
        sub_argv = ["serve"]
        if getattr(args, "no_telegram", False):
            sub_argv.append("--no-telegram")

        from . import daemon as _daemon

        state_path = _daemon.serve_state_path()
        bind_host = os.environ.get("RELAY_HOST", "127.0.0.1").strip() or "127.0.0.1"
        try:
            bind_port = int(os.environ.get("RELAY_PORT", "8787").strip() or "8787")
        except ValueError:
            bind_port = _daemon.DEFAULT_RELAY_PORT
        _daemon.write_serve_state(
            state_path,
            os.getpid(),
            bind_port,
            f"http://{bind_host}:{bind_port}",
            host_id=str(host.host_id()),
        )

        # Workspace sync: bind every ws store.db to the channel op/ack
        # frames — spoke drains via hub links, hub ingests + fans out.
        _sync_rt = None
        try:
            from agents_relay import channel as _ch, channel_client as _cc

            from .wssync import SyncRuntime, sync_workspaces

            _sync_rt = SyncRuntime()
            _ws_map = sync_workspaces()
            _sync_rt.attach_hub(_ch.hub(), _ws_map, str(host.host_id()))
            _cc.on_client(lambda c: _sync_rt.attach_client(
                c, [(ws_id, e["dir"]) for ws_id, e in _ws_map.items()]))
            _sync_rt.start()
        except Exception as exc:  # noqa: BLE001
            log.warning("workspace sync unavailable: %s", exc)

        try:
            return relay_main(sub_argv)
        finally:
            if _sync_rt is not None:
                _sync_rt.stop()
            _daemon.release_pid_file(state_path, os.getpid())

    elif args.command == "routine":
        from .routine import dispatch

        return dispatch(args)

    elif args.command == "remote":
        from .remotes_cli import cmd_remote

        return cmd_remote(args)

    elif args.command == "pair":
        from .remotes_cli import cmd_pair

        return cmd_pair(args)

    elif args.command == "evidence":
        from .evidence import run_evidence

        return run_evidence(args)

    elif args.command == "stop":
        from . import daemon as _daemon

        return _daemon.stop_daemon()

    elif args.command == "shell":
        from . import daemon as _daemon
        from .shell.repl.loop import run_interactive_shell

        url = getattr(args, "url", "http://127.0.0.1:8787") or "http://127.0.0.1:8787"
        remote_id = (getattr(args, "remote", "") or "").strip()
        if remote_id:
            from .remotes_cli import resolve_remote

            row = resolve_remote(remote_id)
            if row is None:
                print(f"Error: unknown remote: {remote_id}", file=sys.stderr)
                return 2
            url = row["base_url"]
        elif not getattr(args, "no_gateway", False) and _daemon._is_loopback(url):
            live = _daemon.discover_live_serve()
            if live:
                url = live
            elif not _daemon.relay_health(url):
                started = _daemon.ensure_daemon(url)
                if started:
                    url = started
                    print(f"klanker daemon started at {url}")
                else:
                    print(
                        f"warning: no relay at {url} — agent tier unavailable",
                        file=sys.stderr,
                    )
        return run_interactive_shell(
            plain=bool(getattr(args, "plain", False)),
            stream=bool(getattr(args, "stream", False)),
            url=url,
            secret=getattr(args, "secret", "") or "",
            user=getattr(args, "user", "local") or "local",
            project=getattr(args, "project", "") or "",
            provider=getattr(args, "provider", "") or "",
            persona=getattr(args, "persona", "default") or "default",
            session=getattr(args, "session", "") or "",
            workspace=getattr(args, "workspace", "") or "",
            workdir=os.environ.get("AGENTS_WORKDIR", "") or "",
            remote_id=remote_id,
            no_gateway=bool(getattr(args, "no_gateway", False)),
        )

    elif args.command in ("bg", "ps", "logs", "kill", "_bg-run"):
        from .bg import dispatch as bg_dispatch

        return bg_dispatch(args)

    elif args.command == "cron":
        if not nucleus.caps.has_harness:
            print("Error: agents-harness is not installed. Install via pip install agents-harness", file=sys.stderr)
            return 1
        if getattr(args, "op", "") == "add":
            from . import flows

            return flows.dispatch(args)
        if args.op:
            print(f"Error: unknown cron op: {args.op}", file=sys.stderr)
            return 2
        from runner.executor import main as executor_main
        if args.flow:
            return executor_main(["--run", args.flow])
        return executor_main(["--all"])

    else:
        # Chat mode: either explicit 'chat', direct prompt argument, stdin pipe, or interactive REPL
        msg = direct_prompt or getattr(args, "message", None) or ""
        user = getattr(args, "user", "user")
        provider = getattr(args, "provider", None)
        seal = getattr(args, "seal", False)

        if msg:
            from .overlay import ensure_default_overlay

            ensure_default_overlay()
            cli_workdir = os.environ.get("AGENTS_WORKDIR", "") or os.getcwd()
            session = getattr(args, "resume", "") or ""
            detached = False
            if getattr(args, "fork", False):
                if not session:
                    print("Error: --fork needs --resume <session-id>", file=sys.stderr)
                    return 2
                if not nucleus.caps.has_traces:
                    print("Error: agents-traces is required for --fork", file=sys.stderr)
                    return 1
                try:
                    from .fork import fork_session

                    session = fork_session(session)
                except ValueError as exc:
                    print(f"Error: {exc}", file=sys.stderr)
                    return 2
                print(f"forked session -> {session}")
                detached = True
            return nucleus.run_turn(
                message=msg, user=user, provider=provider, seal=seal,
                workdir=cli_workdir,
                persona=getattr(args, "persona", "") or "",
                session=session or None,
                detached=detached,
            )

        # If piped input via stdin (e.g. echo "hi" | klanker)
        if not sys.stdin.isatty():
            piped_msg = sys.stdin.read().strip()
            if piped_msg:
                from .overlay import ensure_default_overlay

                ensure_default_overlay()
                cli_workdir = os.environ.get("AGENTS_WORKDIR", "") or os.getcwd()
                return nucleus.run_turn(
                    message=piped_msg, user=user, provider=provider, seal=seal,
                    workdir=cli_workdir,
                )
            return 0

        # Interactive shell: ensure local daemon, then agent shell client
        from . import daemon as _daemon
        from .overlay import ensure_default_overlay
        from .shell.repl.loop import run_interactive_shell

        ensure_default_overlay()
        remote_id = (getattr(args, "remote", "") or "").strip()
        if remote_id:
            from .remotes_cli import resolve_remote

            row = resolve_remote(remote_id)
            if row is None:
                print(f"Error: unknown remote: {remote_id}", file=sys.stderr)
                return 2
            url = row["base_url"]
        else:
            url = _daemon.discover_live_serve() or _daemon.DEFAULT_RELAY_URL
        if not remote_id and not _daemon.relay_health(url):
            started = _daemon.ensure_daemon(url)
            if started:
                url = started
                print(f"klanker daemon started at {url}")
            else:
                print(
                    f"warning: no relay at {url} — agent tier unavailable",
                    file=sys.stderr,
                )
        rc = run_interactive_shell(
            user=user,
            provider=provider or "",
            workspace=getattr(args, "workspace", "") or "",
            workdir=os.environ.get("AGENTS_WORKDIR", "") or "",
            remote_id=remote_id,
        )
        if not remote_id and _daemon.relay_health(url):
            print(f"\ndaemon still running at {url} — `klanker stop` to halt")
        return rc


if __name__ == "__main__":
    raise SystemExit(main())
