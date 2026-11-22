# klanker roadmap (Felix direction, keep current)

## Direction (fixed)

- **One UI**: `apps/web/` is the single frontend source of truth. Desktop =
  thin Tauri 2 shell (`apps/desktop/src-tauri/`, ~1.5k LOC) that renders the web
  bundle and adds OS glue only: tray, hotkey, keyring, serve
  lifecycle, provisioning, updater. NO standalone desktop logic.
- The old full desktop app (window-model, ~4k LOC Rust,
  `feat/desktop-window-model`) was discarded Nov 2025 — branch
  deleted. Do not resurrect it or port its instance-manager model.
- klanker = adaptive shell: prompt + CLI + serve + desktop glue over
  suite CLIs (`runner.loop`, `agents_relay`, `agents_terminal`,
  `agents_memory`, `agents_traces`). Never import harness internals.
- Board = board.lolaplex.org project `klanker` (single source for all
  klanker-repo cards incl. web/desktop/CLI).

## Card-verification rule (every agent)

Board status ≠ code truth. Agent waves commit continuously.
**Before starting any card: check `dev` first.** If the code already
exists, mark the card done with an evidence comment — do NOT rebuild.
If partially built, implement only the missing slice. A card marked
done must name commit/file evidence.

## Wave map (Nov 2025)

Done waves 1-2: suite cards (harness/relay/workspace/traces/terminal),
klanker CLI commands, `apps/web/` UI cards, thin desktop shell (#57, #58,
#60, #62, #63, #76, #78 — all verified on dev).

Open now:

- **Desktop rest**: #59 notification wiring (plugin + `notify()`
  helper exist, no callers — wire pending-approval + turn-done
  triggers), #61 OS autostart (tauri-plugin-autostart not yet added),
  #94 backend checklist doc, #91 Windows verification (Felix manual).
- **Web rest**: #53 auto-recall (needs harness recall provider +
  klanker serve wiring + web toggle), #92 cross-device turn streaming
  (relay SSE attach to running session), #37 VAPID web push (push
  client exists; needs key gen + relay subscription storage).
- **IDE-grade approval UX**: current approval cards show action +
  params only. Target = Zed's agent review surface: inline
  diff-preview per edit/write (old vs new hunk, syntax-highlighted),
  per-hunk accept/reject where feasible, command preview with
  expanded argv + cwd, risk badges on mutating verbs, batch
  approve-always rules (tool/pattern scoped, persisted to the harness
  allowlist instead of one-shot). Orient on Zed's `agent` thread UI —
  steal the interaction model, not the Rust codebase. Needs richer
  pending-approval payloads from `agents-relay` (diffs/argv/context
  beyond the current summary) before web can render it.
- **Gated on Felix (Phase 4)**: E-track exec backends, P3 identity/PR
  path, umbrella/spec cards (#21, #23, #24, #29, #30, #66, #67, #68,
  #88, #93, #84, #1, #2), memory cards, ops (workspace#13, board#4/#7).

## Working rules

- `dev` only. NEVER push to `main` (release = Felix merge).
- One commit per card, English, `CHANGELOG.md` [Unreleased] entry.
- After each card: `POST /projects/klanker/issues/<n>` `verb=move`
  `status=done` — or a comment if partial/blocked.
