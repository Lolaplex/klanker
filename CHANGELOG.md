# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `klanker serve` secure-by-default web auth: when `RELAY_WEB_TOKEN` is unset an ephemeral token is generated per serve and printed once (`klanker serve -> http://host:port/?token=…`, Jupyter-style). `GET /?token=…` on the relay mints the HttpOnly cookie and redirects to `/`, so the pasted URL is the whole login flow. `--no-auth` (or `RELAY_NO_AUTH=1`) is the explicit opt-out.
- Prompt evidence rules: the system prompt now forbids asserting git state (clean tree, empty diff, committed, merged) or file contents without a successful read in the same turn, and requires reporting the failure + re-reading actual state when an edit's `old` text misses or a run is denied — 'verworfen'/'diff leer'/'committed' without a matching tool result is a fabricated claim.
- Shell `/usage` (alias `:usage`): per-session token, cost, tool and error stats sourced from agents-traces — uses the live gateway session when one is active, today's aggregate otherwise.
- Shell `/insights [days]` (alias `:insights`): sessions, turns, tool calls, costs and error rates aggregated over the last N days (default 7) from agents-traces.
- `klanker doctor`: one-shot health check — python/suite versions, runtimes, workspace writability, mcp.json validity + per-server probes, provider keys, agent keys, disk space, relay secret — with pass/warn/fail per row, a fix hint on problems, `--json`, and exit 1 on any failure.
- Shell `/plan` (alias `:plan`): plan mode — bare toggles (status line shows `plan`), `/plan <goal>` runs one planning turn without toggling. Plan-mode turns instruct the agent to inspect read-only and write a markdown implementation plan to `plans/<slug>.md` instead of editing code.
- Shell `/persona [id]` (alias `:persona`): switch the persona mid-session — the choice is persisted to shell prefs, so it becomes the default for that channel; bare `/persona` shows the active persona and workspace roster.
- `klanker update`: one command updates the whole suite — editable checkouts get `git pull --ff-only`, PyPI installs `pip install -U`, and a uv-tool klanker `uv tool upgrade`; `--check` prints the plan without running it.
- `klanker import`: migration importer for `~/.claude`, `~/.codex` and `~/.cursor` — previews rules/instruction files (`<ws>/rules/imported/<src>`), skills (`<ws>/skills`) and `mcpServers` (merged into the workspace `mcp.json` overlay) per source, and only writes with `--apply`.
- Dashboard/PWA management surfaces: `klanker serve` grafts `/v1/klanker/*` routes onto the relay handler (skills list/delete, routines list/create/pause/resume/run/remove, memory list/read/delete — relay-secret authed), and the web app gets a Manage panel (Header button) with skills, routines and memory tabs scoped to the selected workspace.
- The add-instance modal lists signed presence offers from the serving relay (`/v1/presence/offers`) — valid roads are one-click picks, forged/expired entries show their refusal reason. A "publish this host" form signs a `road-declaration/1` via `agents_keys` through `POST /v1/presence/publish`.
- Sent attachments echo back as filename chips on the user bubble instead of disappearing into a bare `[attach]` path.
- The system prompt tells the agent that a `<page .../>` line marks only the first page of tool output and to continue it with `read_content` before counting or summarizing.
- `klanker bg "<task>"`: detached background runner — spawns the turn as a fire-and-forget hidden child under `<ws>/bg-sessions/` (`bg_<ts>.json` meta + `.log`), `klanker ps` lists live/exited sessions, `klanker logs <id> [-f]` prints or tails the log, `klanker kill <id>` stops the process tree and marks the session `killed`.

### Fixed
- Web UI touch targets: on devices where the primary input cannot hover, interactive elements (buttons, selects, inputs) now enforce 44px minimum hit area via a base CSS rule — previously icon buttons like code-fence copy, attachment remove, the sidebar `auth` chip and panel refresh sat well under 44px. Message text stays selectable and replies render as Markdown with copy buttons (already in place).
- Mobile chats healed from dead streams: when the SSE fetch dies client-side (iOS suspend / "Load failed"), the app re-pulls the session's trace events (brief retry window) and merges them over localStorage state — stranded empty bubbles and stale error text converge to server truth. The open chat also reconciles on open and when the app regains visibility, so replies recorded on other devices appear without a manual restore.
- Live cross-device sync: the open chat polls the session's newest trace ts every 12s (one raw JSONL line) and only pulls full events on change — turns from Telegram/other devices surface without a reload.
- A stream that goes silent without erroring (suspended fetch, dead network) no longer pins the spinner and busy-lock forever: a 5-minute idle watchdog fails the turn and the reconcile path heals the bubbles.

### Fixed
- `serve_restart` actually restarts: an owned serve is killed and the respawn waits for the pid to die — previously the health probe re-adopted the still-running process, so a new agents-relay build or changed env was never picked up. Foreign serves are still never killed.

### Changed
- The desktop file registry reconciles with the managed local relay's `remotes.json`: remotes added via PWA merge into the desktop instance list (deduped by endpoint host), saves mirror into the relay, and deletes remove relay rows for the same endpoint so instances added on either surface appear on both.
- The sidebar `auth` chip is clickable and opens the instance sheet for re-authentication; the sheet flags a rejected secret inline, and saving re-probes the relay immediately instead of waiting for the health poll.
- Remote keyring secrets are stored under the endpoint host (`relay.<host:port>`) instead of the volatile instance id — renaming, slug changes and re-adding the same server no longer orphan the stored token. Legacy `relay.<id>` entries are adopted on first read; deletion cleans both accounts.

### Fixed
- Dashboard iOS PWA bottom gap and keyboard jump: standalone mode now keeps the document at `100vh` with a constant `translateZ(0)` shell (avoiding the 47px WebKit clip and compositor teardown), intercepts first-tap input focus via `touchend` + `focus({ preventScroll: true })` to prevent native viewport panning, starts opening/closing spring transitions immediately at `t = 0`, anchors the message scroll container across keyboard animations, unlocks PWA landscape orientation, and balances `.composer` padding (`sw` cache `v11`).
- Dashboard composer uses a 16px font below the `md` breakpoint so mobile browsers do not zoom the page when the field is focused. Desktop stays at the smaller size.
- Editing a local instance persisted nothing — `save()` hardcoded `kind: "remote"` so every local save died at the empty `base_url` check. The sheet keeps the real kind and hides the cookie "authed" pill on desktop (bearer is the only auth path there).
- Deleting a chat removes it from the sidebar immediately (optimistic removal, refetch on failure) and asks for confirmation first — same for archived workspaces/personas and removed instances.
- Switching instances showed an open-but-empty workspace tree until a manual collapse: sidebar expansion sets outlived the instance while its caches were cleared. The list remounts per instance and re-opens the saved selection.
- Racing instance starts (React StrictMode double-effects in dev) could both spawn `klanker serve` on the same port; probe/spawn is serialized so the loser adopts the winner.
- Saving a local instance whose picked workdir does not exist yet creates the directory instead of leaving a dead path.

### Fixed
- Desktop no longer gates the whole dashboard on the managed local serve: the window renders immediately from the registry while the serve spawns in the background — usable even when the local relay is down.
- Remote instances showed as "down" and never loaded their workspace tree on reload: the status poll hits `/health`, which the relay never CORS-echoed, so every cross-origin fetch died before the load effect ran (agents-relay#50).
- Managed local serve died silently once the host held more than one workspace: `klanker serve` requires an entry workspace and refused to guess. The spawn now passes `AGENTS_WORKSPACE` (`default` first, else the first workspace).
- The stale-secret probe checked `/v1/auth/status`, which is a public route and answers 200 for everyone — unauthorized remotes looked healthy. The probe now hits the protected `/v1/workspaces`, so a bad secret marks the row `auth` for real.

### Added
- Desktop shell rewritten as a thin lifecycle adapter: the bundled `web/dist` dashboard talks to `klanker serve` over explicit HTTP+Bearer, and Rust owns only native concerns (one managed local serve on `127.0.0.1`, OS keyring, tray, Alt+Space hotkey, notifications, updater, uv provisioning).
- Desktop boots straight into the dashboard: on startup the app spawns or attaches the managed local serve and hands the webview `{instance, base_url, secret}` via `desktop_bootstrap` — the token prompt only exists for remote/web relays.
- Frameless window: in-DOM titlebar controls (minimize/maximize/close) with a preserved drag region; hidden in the web/PWA build.
- Per-chat model picker in the console toolbar (favorites + recent of the instance's effective provider) overrides the instance default for that chat.
- Remote instance onboarding asks for the secret in the same form as the URL, so `workspaces failed to fetch` no longer means "secret was missing from step one".
- Instance sheets show a `saved` / `save: <error>` line and an explicit Save button — autosave used to swallow failures into the console. Job rows open their session directly.
- Settings panel is an app-defaults surface: it edits the default workdir (native folder picker on desktop via `tauri-plugin-dialog`) and labels provider/model explicitly as the fallback used when an instance or chat sets nothing.
- Sidebar separates the managed local instance from the rest: the spawned instance on top, connected remotes under "connected".
- Local serve lifecycle: the app adopts an already-running serve (never kills it) or spawns a single tracked `klanker serve` with a generated `RELAY_WEB_TOKEN` stored in the keyring; close-to-tray keeps it alive, tray Quit kills only app-owned children, and one bounded respawn follows an unexpected death.
- Settings gains an Updates section on desktop: app update check/install via `tauri-plugin-updater`, plus guided `uv`-based `klanker` install/upgrade when the CLI is missing.
- Host secrets and the OpenRouter key are stored in the OS keyring on desktop (`secret_get`/`secret_set`/`secret_delete`); localStorage keeps only `has_secret` markers there. Browser/PWA storage is unchanged.
- In-window dialogs replace native `prompt()`/`confirm()` everywhere (workspace/persona creation, delete/archive confirmations): the same styled modal renders on desktop webview, browser and PWA, with Enter/Escape/backdrop handling and a danger style for destructive actions.
- One-time import of the legacy `~/.klanker` store on desktop: pre-thin-shell instance configs and app settings merge into the new localStorage registry (`legacy_state` command); remote bookmarks keep working because secrets already live in the OS keyring under the same `relay.<id>` accounts.
- Durable instance registry on desktop: connected remotes persist to `~/.klanker/instances/<id>/instance.json` — the same files the legacy build wrote — so bookmarks survive reloads, origin/port changes, and webview-data resets. New remotes get slug-stable ids (`vps`, not a uuid) so the keyring account `relay.<id>` stays attached across renames. Browser/PWA keeps localStorage until the relay hosts the registry.
- Health poll probes `/v1/auth/status` after `/health`: a stale or missing remote secret marks the sidebar row `auth` instead of looking like an empty instance.
- Dev builds load `tauri-plugin-mcp-bridge` (`debug_assertions` only) for webview automation; release artifacts do not link it.
- Tailnet peer discovery on desktop (`discover_peers`): `tailscale status --json` provides the roster, each peer is probed for `klanker serve` on ports 8787/8000 — the "discover" flow in Add Instance finds relays again (stdlib TCP probe, no new deps). Browser/PWA has no local tailscale access and returns an empty list.
- Web/PWA remotes mount through the serving relay (agents-relay#49): the registry and remote secrets live in the relay's `remotes.json`, every remote call proxies via `/v1/remote/<id>/…` with the bearer injected server-side — no plaintext secrets in browser storage, remote relays without browser CORS work through the mount, and the connected graph is shared across devices. One-time migration moves localStorage bookmarks (with their secrets) onto the relay; relays predating the API fall back to localStorage.

### Changed
- `TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`/`GH_TOKEN` resolve through `agents_workspace.resolve_secret`: `<ws>/secrets.json`, then `<host>/secrets.json`, then the environment. Shell env behaviour is unchanged when no secrets file defines the key.
- `src-tauri` shed ~2,800 lines of the legacy multi-instance manager (`commands.rs`, `models.rs`, `presence.rs`); the dead same-origin auth gate is skipped on desktop. The window is frameless again with in-DOM titlebar controls.
- The managed local serve's host root is `~/.klanker/instances/default` (`AGENTS_HOST_DIR`) — the instance dir is the host root with `workspaces/<id>` inside, no `.agents` nesting; `~/.agents` stays untouched. The settings workdir is passed as `AGENTS_WORKDIR` (created if missing).
- UI and code say "instance" consistently: `HostSheet` became `InstanceSheet` and "ADD HOST / Host settings / Host URL / Host secret" labels read "instance" — genuine network-host terms (`AGENTS_HOST_DIR`, `window.location.host`) keep the word.

### Added
- Suite packages `agents-keys`, `agents-docs`, `agents-voice` and `agents-store` are core dependencies and are installed in the Docker image (overridable via `KEYS_REF`, `DOCS_REF`, `VOICE_REF`, `STORE_REF`). The `keys` extra was dropped (now a core dep). Klanker instances can mint did:key identities and prove them to board.lolaplex.org out of the box.

### Fixed
- Dashboard iOS PWA bottom gap (root cause): the app shell used `fixed inset-0`, and in installed standalone PWAs `bottom: 0` pins to a fixed-position viewport that excludes phantom bottom chrome — the shell ended ~50px above the real screen edge. The shell (and `body`) now size to `100dvh` from `top: 0`, which is the real visible height; sibling PWAs using `100dvh` flow layouts never had the gap. The `kbBox` keyboard override still sets explicit top/height.
- Dashboard iOS PWA bottom gap: `env(safe-area-inset-bottom)` is inflated in installed standalone PWAs (WebKit counts phantom browser chrome that is never rendered, ~80px instead of the ~34px home indicator), which padded the composer/sidebar/sheets ~46px too far off the screen edge. All bottom-inset consumers now use a `--sab` variable that is clamped to the real inset size in `display-mode: standalone`; browser mode keeps env as-is.
- Dashboard iOS PWA keyboard handling rebuilt on the real full-height probe: `window.innerHeight` permanently shrinks after the first keyboard open in installed PWAs and `visualViewport` under-reports by the safe-area insets, so the keyboard box could go stale and leave a fixed gap under the composer. The shell now tracks `visualViewport` only while an editable element is focused (`focusin`/`focusout` + settle timer + rotation re-probe), covers both iOS shrink and pan modes, and no longer calls `scrollTo`, which caused stale viewport pans in standalone mode.
- Dashboard composer uses a 16px font below the `md` breakpoint so mobile browsers do not zoom the page when the field is focused. Desktop stays at the smaller size.
- Dashboard chat sessions: the last open chat (workspace, persona, thread, and even the half-typed composer text) is restored on reload. Sidebar rows no longer show raw `ses_…` ids — names are prefetched from session history when a persona expands and cached across reloads. "new chat" is now a single per-persona draft that only becomes a real session on first send, so clicking it no longer stacks empty chats, and reopening a session can no longer spawn a duplicate.

### Changed
- Dashboard chat text can be selected. Assistant replies render as Markdown (raw HTML stays text; links are limited to http, https, mailto, and relative URLs). Each message and each code block has a copy control. Buttons are at least 44px. On a coarse pointer, Enter inserts a newline and only the send button submits.

### Added
- `web/` — the Klanker dashboard, extracted from klanker-desktop as a standalone React/Vite PWA. It talks to `agents-relay` over `/v1/*` (chat SSE stream + stop, workspaces, personas, auth cookie login, approvals, traces) and stores the instance list/settings in the browser. Installable on phone (manifest + service worker + safe-area layout).
- `klanker serve` serves the vendored dashboard automatically: `src/klanker/_web` (via `scripts/vendor-web.py` or the Docker build) becomes `AGENTS_RELAY_WEB_DIR` when no static dir is configured. `RELAY_WEB_TOKEN` still gates the web surface, so API-only operation stays the default.
- Dashboard tree sidebar mirrors the real hierarchy: host -> workspace -> persona -> sessions. Sessions come from the relay (`GET .../sessions`), restore their trace-event history on open, and can be deleted server-side (`DELETE .../sessions/<s>`). Chat state is cached in the browser per host+workspace+persona. The add-host modal carries network discovery; the mobile sidebar is a drawer.
- Dockerfile is now multi-stage: a throwaway node stage builds `web/dist`; the final image stays Python-only.
- `src-tauri/` — the Tauri 2 desktop shell moved in from `klanker-desktop`. Same `web/` frontend (`frontendDist: ../web/dist`), same Rust layer (instance sidecars, keyring secrets, tray, presence). Root `package.json` carries `desktop:dev` / `desktop:build`; `klanker-desktop` repo is superseded.

### Fixed
- `klanker chat` no longer crashes on inline `--system` prompt text: the stale-path guard only refuses path-like values (single line, <500 chars, missing file). Long inline prompts caused `OSError: File name too long` instead of reaching `runner.loop`.
- Dashboard: first message on a fresh host/workspace/persona bucket silently vanished — `handleSendMessage` returned early when no chat item existed. A chat is now minted on send, so a brand-new console just works.
- Dashboard jobs tab: the persona picker listed personas of the *config* workspace instead of the selected job workspace, leaving the select empty and Run job disabled. Personas are fetched per selected workspace; an inline create appears when a workspace has none.
- PWA service worker could serve a poisoned cached asset (0-rule stylesheet → unstyled app). `sw.js` is now `v3` with stale-while-revalidate for immutable `/assets/*`, so a bad entry self-heals on next load.
- Desktop shell loads the shared frontend in a frameless window: the header now declares `data-tauri-drag-region`, and service-worker registration is skipped inside Tauri (`__TAURI__` guard) so the app can't self-cache a stale bundle.
- `klanker workspace` subcommand was parsed as a prompt (`KNOWN_SUBCOMMANDS` missing `workspace`); multi-workspace hosts crashed `Host.from_env()`/sense paths — resolved with explicit host-dir resolution.

### Changed
- `.mailmap` maps legacy `Klix`/`Felix Kempf` author names to `Klix927` (no history rewrite; display only).

### Added
- `klanker persona list|add <id> [--workspace <id>] [--role ..] [--system-append ..]` — manages equal workspace-scoped personas (`<ws>/personas/<id>/persona.json`). Bad ids (paths, labels) are rejected.
- `klanker chat ... --persona <id>` — threads the persona into the spawned `runner.loop` (`--persona` argv + `AGENTS_PERSONA` in the child env). `klanker shell --persona` already reaches the relay `/v1/turn` body.
- `klanker persona inbox <id>`, `klanker persona task <id> <title>`, `klanker persona handoff <task> --to <id> [--from <id>] [--note ..]` — explicit task handoffs between equal personas; a `--from` mismatch is refused (no silent steals, no default-persona privilege). Backed by `agents_workspace.inbox` and the relay inbox routes.

### Fixed
- `test_stop_daemon_kills_pidfile_process` is platform-aware: POSIX
  `stop_daemon` signals the process group via `os.killpg`, it never calls
  `subprocess.run`/`taskkill`.

### Changed
- Docs (README, AGENTS.md, prompt/routine strings, `.env.example`) now name
  the Host > Workspace layout (`AGENTS_HOST_DIR`, `AGENTS_WORKSPACE=<id>`,
  `AGENTS_WORKDIR`, `<ws>/…`). Historic entries below document the old
  `~/.agents` layout and stay untouched.

### Added
- `tests/test_gate_workspaces.py`: P1 gate — two workspaces in one process and
  over real `serve_http` stay isolated (domains, env, memory/traces/relay
  state, members, tick iteration, serve legacy refusal, HTTP `/v1/turn`
  workspace routing + traversal 400).
- `scripts/gate-container.sh`: container variant of the gate.

### Changed
- Deploy scripts take every host-specific value via env/args: `NAS_HOST`,
  `NAS_PROJECT`, `REMOTE_REPO`, `PROJECT_DIRS`, `SEED_SRC`/`SEED_DST` —
  no personal defaults (registry, user@host, volume paths) remain.
- README/`RELAY_WEB_USER` example uses `web`; `.agents` memory files and
  generated metadata no longer carry absolute local paths.
- `klanker serve` refuses a legacy host layout and points at
  `agents-workspace migrate` instead of silently bridging.
- Container `entrypoint.sh` auto-migration (`AGENTS_AUTO_MIGRATE=1`) fails
  the entrypoint on migration errors instead of `|| true`.

### Changed
- Container host layout: `entrypoint.sh` exports only `AGENTS_HOST_DIR=/data/.agents` and creates `workspaces/`, `run/`, `cache/`, `keys/`, `logs/`. No process-global `AGENTS_WORKSPACE`, workdir, home/root aliases, or `AGENTS_*_DIR` domain overrides — every workspace owns its memory/traces/schedules. `AGENTS_AUTO_MIGRATE=1` runs `agents-workspace migrate` on boot (container only).
- `Dockerfile`: `RELAY_HOST`/`RELAY_PORT` instead of legacy `GATEWAY_HOST`/`GATEWAY_PORT`; no docs/memory/traces dirs in the image.
- `compose.nas.yaml` replaced by `compose.example.yaml` with `<placeholders>` — no personal values, no domain overrides.

### Changed
- `klanker serve` pid file moves from `~/.klanker/daemon.pid` to `<host>/run/serve.pid`; `stop`/`status` read the new path first and the legacy file once with a `DeprecationWarning`. Two hosts now keep independent pid files.
- `save_system_prompt` writes `<host>/run/klanker_prompt_<workspace-id>.txt` instead of `<workspace>/klanker_prompt.txt` — generated prompts are host artifacts and differ per workspace.

### Fixed
- POSIX `klanker stop`/`stop_daemon` now signals the daemon's whole process group (SIGTERM, SIGKILL after a 5s timeout) instead of only the leader pid — in-flight `runner.loop` children can no longer be orphaned.

### Added
- 'home' terms removed: dead `agents_home()` helper deleted, sense field `has_agents_home` -> `has_workspace`.
- `mcp_config_path()` matches the harness resolver contract: `<host>/mcp.json` (`AGENTS_MCP_CONFIG_FILE`; `AGENTS_MCP_CONFIG` deprecated alias), with `<ws>/mcp.json` as per-server overlay. REPL prefs move to `<host>/clients/shell/prefs.json` (legacy `<cwd>/.agents/repl/prefs.json` read once). Update-check cache under `<host>/cache/updates/`.
- `agents-workspace` is a hard dependency: one root resolves memory, rules, skills, modules, schedules, traces, routine runs, relay state, personas, identity, and config. `AGENTS_WORKSPACE_ROOT` is the canonical root; `AGENTS_HOME` stays readable as a legacy alias.
- Multi-workspace: `klanker serve` hosts the default workspace plus every workspace under `AGENTS_WORKSPACES_DIR`. `GET /v1/workspaces`, `POST /v1/workspaces {"label": ...}`, and a `"workspace"` field on `/v1/turn` and `/v1/stream`. `klanker routine add|say --workspace <ref>` pins a routine to a workspace; the ticker ticks every workspace.
- `agents-workspace` CLI: `info`, `path`, `init`, `migrate`, `list`, `create`.
- `compose.nas.yaml` + `scripts/nas-{deploy,sync}.ps1`, `publish-registry.ps1`, `nas-pull-latest.sh`: private-registry deploy flow (env-configured host) (build → save → scp → NAS-side load/push → `pull-latest.sh` recreate). Container listens on 8000, host maps 8787 — the port klanker-desktop discovery probes first.
- `scripts/nas-seed.py`: one-time NAS seed — inherits `.agents` (memory/docs/rules/skills/traces/identity, missing files only) from the assistant project, writes a filtered `.env` (keeps `TELEGRAM_*` — klanker takes over the bot on cutover, replacing the assistant), and ingests `assistant.db` `messages` as `origin:"ingested"` agents-traces `message` events into daily JSONL.

### Changed
- `--workspace <id>` now selects the data workspace (`AGENTS_WORKSPACE=<id>`); the new `--workdir <dir>` flag carries the old directory meaning (`AGENTS_WORKDIR`, plus `AGENTS_WORKSPACE_LOCK=1`). A directory passed to `--workspace` still works for one release with a deprecation warning. `klanker routine add|say --workspace` takes a workspace id. A chat turn without `--workdir` runs in the current directory.
- Module overlay is per-workspace: `klanker serve` installs bundled modules into each workspace's `modules/` and turns receive `AGENTS_MODULES_DIR` via `ws.env()`. `publish_modules_dir` and the process-global `KLANKER_CHANNEL` default under `serve` are removed — `klanker.turn` derives its module dir and channel per turn.
- `nucleus.run_turn` accepts `workspace=` and `workdir=` and spawns the child with the explicit `ws.env()` instead of inherited process state.
- `--workspace` now also sets `AGENTS_WORKSPACE_LOCK=1`, so pointing a turn at a repo confines it to that repo. A server that only sets `AGENTS_WORKSPACE_DIR` keeps its previous reach. It sets `AGENTS_WORKDIR` (and the legacy `AGENTS_WORKSPACE_DIR`).
- Routine ticker ticks each workspace with an explicit `tick(workspace=ws)` (requires agents-harness >= the workspace-aware tick). The process env is no longer mutated per workspace, so a concurrent turn on another workspace can never see ticked paths. Routine turns spawn with `ws.env()`; the handler accepts `workspace_obj` injected by the harness scheduler. `save_system_prompt` and `record_routine_run` accept `workspace=...`.
- Dockerfile installs `agents-workspace` from git before the rest of the suite; `CACHE_BUST=3`.

### Fixed
- Dockerfile ran `useradd` twice; the second invocation failed the build.
- `compose.nas.yaml` starts the container as root (`user: "0"`) so `entrypoint.sh` can chown the bind-mounted `/data` before dropping to the `klanker` user — otherwise mkdir fails and the container restart-loops.

## [0.2.2] - 2026-11-08

### Added
- `--workspace PATH` on `klanker` (REPL), `klanker chat`, and `klanker prompt`. It resolves the path, requires an existing directory (exit 2 otherwise), and sets `AGENTS_WORKSPACE_DIR` for this process and the spawned `runner.loop`.
- System prompt: file edits use `mcp.terminal.edit` for existing files and `mcp.terminal.write` for new ones, never `mcp.terminal.run`. A git workspace adds a coding block with the repo path, the root `AGENTS.md`, the read → edit → test flow, and no `git push`.
- Root `AGENTS.md` for coding agents: role, stack, commands, and the layering rule (no harness internals, suite via CLIs).
- `klanker routine say "<sentence>"` creates a routine from one sentence plus `--at` (`+10m`) or `--cron`. `pause` and `resume` keep that job and stop it from firing; `list` shows `paused`.
- Finished routine runs (including `NO_UPDATE` and failures) are recorded under `routine-runs` (`index.jsonl` and one markdown file per run) so a later turn can find scheduled output that was never added to memory.
- `klanker evidence --from YYYY-MM-DD --to YYYY-MM-DD` lists routine-run and workspace files for every day in the range. Memory and traces stay separate tool checks.
- System prompt rules: name each source checked and keep a miss distinct from non-existence; cover every day of a requested range; do read-only investigation without asking; retrieve truncated text before summarizing; claim a side effect only after a successful tool call in that turn.
- Routine-run files are replaced atomically. Retention keeps the newest 2000 runs from the last 90 days (`AGENTS_ROUTINE_RUNS_KEEP_COUNT`, `AGENTS_ROUTINE_RUNS_KEEP_DAYS`).
- `klanker.turn` registers `agents-traces` `read_content` as the harness content backend when traces is installed, and registers the evidence side-effect check as the harness final check. A memory save counts only with `agents_memory.write_receipt.v1`.
- Generated tool manifests honor declared `side_effects`. Read-only terminal verbs (`list`, `read`, `grep`, `stat`) stay non-mutating when the package says so.

### Changed
- The system prompt sends clipped trace text to `read_content` and workspace reads to `mcp.terminal.list|read|grep|stat` instead of a shell or a permission ask.
- The evidence policy names `mcp.terminal.edit` and `mcp.terminal.write` beside the read-only verbs. Mutating file edits need an approval only when the host sets `AGENTS_APPROVAL_MODE` to `ask` or `strict`.

### Fixed
- On Windows, `klanker serve` starts its help-json probes without opening a console window.
- README no longer lists `agents-docs` as an integrated package. It is not a dependency.
- `klanker.turn` refuses a `--system` that is not a readable file. `runner.loop` would otherwise keep the path string as the system prompt.
- The running-daemon warning about `AGENTS_WORKSPACE_DIR` fires only when `--workspace` was passed, not when the variable happens to be exported.
- The `repl` extra depends on `agents-relay>=0.1.1` instead of a git URL. A direct reference cannot be resolved from an index and does not belong in published metadata.

## [0.2.1] - 2026-10-21

### Removed
- Removed deprecated `suite` optional extra and all references to suite / monorepo. Use individual feelers or `klanker[all]`.

## [0.2.0] - 2026-10-21

### Added
- `agents-sync>=0.1.0` integrated as fixed core dependency and autonomous sensing feeler.
- Autonomous self-equipping and direct execution directives in dynamic system prompt (`prompt.py`). Klanker immediately installs missing packages via `mcp.terminal` using `{caps.python_executable} -m pip install <pkg>` instead of passively instructing users to run pip commands.
- `python_executable` field recorded in `HostCapabilities` and dynamically probed via `probe_host()`.
- Dynamic capability re-probing (`self.caps = probe_host()`) on each conversational turn in `Nucleus.run_turn()`.

### Changed
- `agents-docs` transitioned from core dependencies to optional extras (`klanker[docs]`), keeping the default installation lightweight.
- Docker build configuration sets default `SUITE_REF=dev` on dev branch.
- `klanker serve` no longer sets `AGENTS_APPROVAL_MODE=ask` or `AGENTS_APPROVAL_CMD`. Unset mode stays ungated. Opt in with `AGENTS_APPROVAL_MODE=ask` or `strict`; serve then fills the default approve command when `AGENTS_APPROVAL_CMD` is unset.
- `klanker serve` sets `LOOP_CMD` using `sys.executable` to prevent Python interpreter mismatches.

## [0.1.0] - 2026-10-06

### Added
- Hard rules from agents-memory appear in the harness system prefix (`<memory_rules>`); the Klanker prompt notes that block. Cordis memory tools are unchanged.
- In-process schedule ticker in `klanker serve` (60s, `KLANKER_TICK=0` disables) with `.tick.lock`, plus `klanker routine add|list|remove|run`. Routines run a full turn in `routine:<name>` and drop `NO_UPDATE` replies.
- `mcp.schedule.add` prompt mode (routine) beside fixed-text reminders.
- Startup overlay generation from suite `--help-json`, with read/mutate classification. Hand-written manifests win. `agents-browser` is installed in the image; keys stay read-only unless `KLANKER_KEYS_WRITE=1`.
- `klanker sense` reports `~/.agents/mcp.json` servers and `~/.agents/skills`. Example config at `examples/mcp.json`.
- Telegram serve defaults `AGENTS_APPROVAL_MODE=ask` and `AGENTS_APPROVAL_CMD` for `agents-relay approve`.
- Auto-derive Git user identity and email via `git_identity` module from GitHub API or environment, setting up `/data/.gitconfig` and credentials with secure file permissions.
- Configurable Dockerfile build arguments (`HARNESS_REF`, `RELAY_REF`, `MEMORY_REF`, `TRACES_REF`, `DOCS_REF`, `TERMINAL_REF`, `CALENDAR_REF`, `BROWSER_REF`) defaulting to `dev` to allow building from custom feature branches or tags.
- `klanker audit` CLI subcommand to run integrity verification and replay analysis via `agents-traces`.
- `--seal` CLI flag on `klanker chat` and REPL to forward cryptographic turn sealing to `runner.loop`.
- System prompt section on Observability, Integrity & Sealing guiding Klanker to use `mcp.traces.audit` and `mcp.traces.seal`.
- CLI (and MCP, when present) check PyPI at most once per day for a newer release and print one stderr / tool-response line (`uv tool upgrade …`). Disabled with `AGENTS_NO_UPDATE_CHECK=1` or when `CI` is set; offline/timeout stays silent.

### Changed
- Requires `agents-docs>=0.45.0`, `agents-terminal>=0.0.5`, and `agents-browser>=0.45.0` (optional browser extra).
- System prompt uses the package version, describes approvals and untrusted tool data, and no longer says to execute mutating tools directly.
- `mcp.schedule.add` sets `approval_ask: false`. The ticker runs each `tick()` on a worker thread. One-shot routines delete their `.json.last` and `.lock` sidecars.
- Routines and reminders store channel and user. Relay delivers Telegram chat ids; other channels, including HTTP `anonymous`, stay local.
- Ask-mode approvals apply when an approver is configured, not only while Telegram is polling.
- Telegram polling refuses to start without `TELEGRAM_ALLOWED_CHAT_IDS` unless `KLANKER_TELEGRAM_OPEN=1`.
- Docker socket access uses the socket group instead of mode `666`. Skills directory is created on the data volume.
- Ground system prompt in Local Agent Memory terminology, document file_id parameters for mcp.memory.read, and explicitly forbid tool-failure content hallucination.
- Requires `agents-harness[mcp]>=0.1.0`, `agents-relay>=0.1.0`, `agents-memory>=1.2.0`, `agents-traces>=0.1.0`, `agents-calendar>=0.1.0`, `agents-docs>=0.45.0`, and `agents-terminal>=0.0.5`. The Docker image builds from `main` by default instead of `dev`; `SUITE_REF` and the per-package `*_REF` build args override it.

### Removed
- Unused `morph.py` schedule synthesizer.
- Stale `klanker[memory]` extra from the system prompt (memory is a core dependency).

### Fixed
- `save_system_prompt` respects `AGENTS_HOME` (same as the rest of the suite) instead of the unused `AGENTS_DIR`.
- Set `AGENTS_MODULES_DIR` so harness loads overlay modules (including `mcp.schedule.add`). Skip Klanker's `.tick.lock` when harness locks `tick.lock` inside `tick()`.
- `KLANKER_TELEGRAM_OPEN=1` sets `AGENTS_RELAY_ALLOW_ANYONE=1`. Routine delivery passes `allow_anyone`.
- `klanker routine add` defaults the timezone from the harness / `AGENTS_TIMEZONE` / `TZ`. Routine turn timeout sits under the job timeout.
- Routine default timeout covers the harness approval wait plus 330 seconds (645 with the default approver) instead of 300, which was shorter than the 315-second approval wait. `mcp.schedule.add` routines without a timeout get the same default.
- `klanker sense` expands `${VAR}` in MCP config before probing. Image installs `agents-harness[mcp]` and accepts `CACHE_BUST` / `SUITE_REF`.
- Clean up plaintext token `insteadOf` configs from `.gitconfig` in favor of secure `credential.helper store` with 0600 file permissions.
- Forward `SIGTERM` and OS signals cleanly in `entrypoint.sh` using `setpriv` instead of `su`, preventing dual-polling 409 conflict errors on container restart.

## [0.0.2] - 2026-09-27

### Added
- Cordis modules `mcp.calendar.list|add|update|delete|calendars` (calendar is core, not an extra).
- Forward `agents-terminal` as core suite module and preserve container environment variables across `su` in `entrypoint.sh`.
- Auto-configure git authentication and `/data/.git-credentials` from `GITHUB_TOKEN` / `GH_TOKEN` on startup.
- Telegram reminders: `mcp.schedule.add` overlay writes a one-shot verb that calls `agents-relay send` instead of an LLM turn. Host must tick `python -m runner.schedule tick`.
- Explicit workspace filesystem grounding (`/data/workspace` or `~/.agents/workspace`) and inbox directory initialization in `entrypoint.sh`.

### Changed
- CI runs only on pull requests to `main`.
- PR-only CI added (ubuntu-latest `pytest` on pull requests to `main`/`dev`). Feature-merge notifications on squash into `dev`. No publish pipeline.
- `agents-calendar` is a core dependency (same as terminal/memory). Extra `[calendar]` stays as an install alias. VPS/container uses Coolify env `CALDAV_*`.
- System prompt treats the clock as the calendar (weekday + local date) and drops the slimemold greeting.
- System prompt instructs autonomous multi-step tool execution without early turn stops on partial outputs.
- Telegram replies: human prose (no CLI status / ASCII boxes / checkmark glyphs). `mcp.memory.add` is documented as `fact`, not `text`.
- Product copy drops the slimemold analogy. Klanker is an adaptive agent distribution on the suite.
- System prompt instructs proactive memory persistence for scheduled briefings and recommendations via `mcp.memory.add`.

## [0.0.1] - 2026-09-05

### Added
- Initial setup and alignment with Autonomous GitHub Standard.
- Universal, adaptive AI agent shell and terminal companion.

[Unreleased]: https://github.com/Lolaplex/klanker/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Lolaplex/klanker/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Lolaplex/klanker/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Lolaplex/klanker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lolaplex/klanker/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/Lolaplex/klanker/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Lolaplex/klanker/releases/tag/v0.0.1

### Fixed

- Per-instance provider selections of real host manifests (`acp.cursor`,
  `openai.default`, `scripted.tool`, …) were silently dropped: the send path
  gated on the UI provider taxonomy, which maps unknown names to "inherit".
  The raw manifest name is now sent; ""/"inherit" still means host default.
- The web app no longer shows desktop-local settings (default workdir, the
  Echo/LM Studio/OpenRouter fallback tri-toggle, LM Studio base URL) — they
  only exist for the managed local serve in the desktop build.
- A turn still running on another device/channel now shows the thinking
  indicator instead of looking idle: the session sync reads the newest trace
  event type, not just completed replies.

### Changed

- The "Echo" fallback provider is labelled "Echo (test)" — it is the scripted
  replay provider, not the env-configured default. The instance provider
  picker labels its empty choice "host default (env)" and only offers
  "inherit app setting" on desktop.
