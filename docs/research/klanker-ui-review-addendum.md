# Klanker UI Review — Addendum: `dsh`, `pi`, and `omp` (+ `omp` v2)

**Date:** 2026-11-27  
**Mode:** Read-only research addendum to [`klanker-ui-review.md`](klanker-ui-review.md) (gathered with no repository edits).

---

## 1. Precise Identification, Repo URLs, and Licenses

| Term | Project | Verified Repo URL | License (Verified) | Notes / Clarifications |
| --- | --- | --- | --- | --- |
| **`dhs`** *(officially **`dsh`**)* | **DeepSeek Harness** (`@deepseek-ai/dsh`) — *"Everything is a Plugin"* | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) | **MIT** ([`LICENSE`](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)) | Official CLI/acronym is `dsh` (community wikis sometimes write `dhs`). Built on [**Cordis**](https://github.com/cordiverse/cordis) (TypeScript IoC plugin framework with reversible effects, arXiv:2608.25512) — distinct from Lolaplex's Python "Cordis job kernel" in `agents-harness`, though sharing the name and plugin/effect ethos. Developer preview (`0.2.3-alpha.2`). |
| **`pi`** | **Pi** (`@earendil-works/pi-coding-agent` + monorepo) | [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) *(docs also link `earendil-works/pi`)* | **MIT** ([`LICENSE`](https://github.com/badlogic/pi-mono/blob/main/LICENSE), Earendil Inc.) | Minimal extensible coding harness (`pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`, `pi-durable`). Also now contains **`@earendil-works/chord`** (`packages/chord`), a cross-process object/delta/plugin runtime with hot reload. |
| **`omp`** | **Oh My Pi** (`@oh-my-pi/pi-coding-agent`) | [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) | **MIT** ([`LICENSE`](https://github.com/can1357/oh-my-pi/blob/main/LICENSE), M. Zechner / C. Bölük / Stencil Labs) | Batteries-included fork of Pi on `main` (Bun/TypeScript + ~80k LOC native Rust crates). **Also hosts an orphan [`omp2`](https://github.com/can1357/oh-my-pi/tree/omp2) branch** (pre-release ground-up Rust rewrite, **MIT** [`LICENSE`](https://github.com/can1357/oh-my-pi/blob/omp2/LICENSE); `Cargo.toml` references private `stencil-hq/omp`). |

---

## 2. Protocol, Plugin Model, and UI Architecture per System

### A. DeepSeek Harness (`dsh` — `deepseek-ai/deepseek-harness`)
- **Client/Server Protocol** ([`docs/api-gateway.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.md), [`docs/subsystems/web-client.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md), [`docs/subsystems/conversation.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/conversation.md)):
  - **Unary + bidirectional streams:** Typert API Gateway (`@Remote` / `@RemoteScope` decorators compiled at build time into strict runtime codecs) over `POST /api/<namespace>/<method>` + multiplexed WebSocket (`/api/remote.mux`) + exact Fetch routes for binary downloads. Also ships `sdk` JSON-RPC and `acp` profiles.
  - **Session streaming & resume:** Separate durable data protocol (`follow()` / `page()`). Every WebSocket generation opens `follow()` with a complete baseline (header, tail page, cursor, projections), then appends sequenced durable `SessionEvent`s and Client-only `assistant/live-chunk` deltas. Reconnect replaces the window atomically from the new opening baseline; `page()` backfills older pages and repairs gaps. Durable `assistant/message` embeds compact timed streams so reconnect/history replay reproduces identical UI without storing per-token rows.
- **Extension/Plugin Model** ([`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md), [`docs/subsystems/slots.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.md)):
  - **Cordis layered composition:** Profiles stack bundles + `cordis.patch.yml` overlays (`dsh plugin` manages pnpm packages). Every registration (service, HTTP route, Slot, conversation node) is a **reversible effect** that cleanly unwinds on unload.
  - **UI plugins:** Feature packages never import each other at runtime; they register into typed **Slots** (`single`, `list`, `keyed`, `chain`, `hoc`) via `ctx.slots.register()` and register conversation folds (`match`/`start`/`update`/`buildViewNode`) via `ctx.uiConversation.events.register()`.
  - **Sandboxing & persistence:** Execution confinement uses swappable `ctx.sandbox` / `ctx.fs` / `ctx.subprocess` capability seams (browser plugins run in-document via a lazy CommonJS loader, not iframes). Sessions persist as versioned append-only JSONL (`session.vN.jsonl[.zstd]`) with adjacent `vN -> vN+1` migrations; Workspace ordering/pins/unread state live in host controllers.
- **UI Architecture:** React 18 Web SPA (and Electron wrapper loading the same Web SPA over `file://` + IPC), **strictly isolating React at the leaf**: Client models, Conversation assembler, and Slot registry are all React-free; only `ui-renderer` binds bare observables via `useSyncExternalStore`.

### B. Pi (`badlogic/pi-mono`)
- **Client/Server Protocol** ([`packages/coding-agent/docs/rpc.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md), [`json.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md), [`rpc-extension-ui.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)):
  - Strict LF-delimited JSONL over child-process stdin/stdout (`pi --mode rpc`, custom protocol — not JSON-RPC 2.0). Warns explicitly against Node `readline` (which breaks on JSON-valid `U+2028`/`U+2029`).
  - 4 record families: commands (`id`-correlated), `response`, delta-only session events (`message_update` strips cumulative `partial` snapshots on the wire; distinguishes low-level `agent_end` from final `agent_settled`), and bidirectional `extension_ui_request`/`extension_ui_response` (`select`, `confirm`, `input`, `editor`, plus fire-and-forget `notify`, `setStatus`, string-array `setWidget`, `setTitle`, `set_editor_text`). No chunking or paged history in stock Pi RPC.
  - **New in repo — `@earendil-works/chord`** ([`packages/chord/README.md`](https://github.com/badlogic/pi-mono/blob/main/packages/chord/README.md)): Cross-process object runtime (Node server, forked workers, browser tabs, sandboxed TUI) over WebSocket/IPC/HTTP with hot-reloadable plugin **facets**, transactional JSON deltas (`@earendil-works/chord/delta`), and `WatchHandle<T>` that folds `PendingOps` and collapses >10,000 pending ops into one root replacement `[["r", newest]]`.
- **Extension/Plugin Model** ([`packages/coding-agent/docs/extensions.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md), [`session-format.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)):
  - In-process TypeScript modules loaded from disk/npm/git (`pi.on`, `pi.registerTool`, `pi.registerCommand`, `pi.registerEntryRenderer`). **Zero built-in sandboxing** (runs with full user OS permissions; README recommends Gondolin micro-VM, Docker, or OpenShell).
  - Persistence: tree-structured JSONL (`id`/`parentId` for in-place branching, `compaction`, `context_edit`, and `custom` entries via `pi.appendEntry(customType, data)` for extension state that stays out of LLM context).
- **UI Architecture:** Differential-rendered TUI (`@earendil-works/pi-tui`); no first-party web chat UI in `pi-coding-agent` (`chord` provides optional Web/TUI/React surfaces for apps built on Chord).

### C. Oh My Pi (`omp` — `can1357/oh-my-pi`, `main` branch)
- **Client/Server Protocol** ([`docs/rpc.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)):
  - Extends Pi's stdio JSONL RPC with **Protocol v2** (see §3A) plus rich sub-protocols: **Extension UI** (adds full HTML `form` dialogs via `ui.formDialog` / `ask` tool, structured `ask`, `open_url`, `secret` input), **Host Tools** (`set_host_tools` → `host_tool_call` / `host_tool_update` / `host_tool_result` / `host_tool_cancel`, letting GUI hosts expose custom tools back to the agent), **Host URI**, **Live Voice** (WebRTC SDP + Opus), **Dictation**, and separate **Collab** (multiplayer session sync) / **Stream** (one-way terminal broadcast).
- **Extension/Plugin Model:** Pi-compatible TS extensions + plugin manager (`docs/extension-loading.md`), Gemini-manifest compat, MCP servers, approval mode (`docs/approval-mode.md`), and Pi-compatible JSONL session trees.
- **UI Architecture:** Custom high-speed differential TUI (`docs/tui-core-renderer.md`); no official web/desktop GUI yet (requested in [#5742](https://github.com/can1357/oh-my-pi/issues/5742) / daemon proposal [#5405](https://github.com/can1357/oh-my-pi/issues/5405); third-party GUIs like T4 Code wrap RPC).

---

## 3. What Changes in `omp` v2 — and Why It Is Better

There are **two distinct "v2" efforts** in `can1357/oh-my-pi` that are easy to conflate; both are verified from primary sources:

### A. Shipped Mainline `omp` RPC Protocol v2 (Merged July 23, 2026)
**Sources:** [PR #6330 (`feat(coding-agent): add lossless paged RPC transport`)](https://github.com/can1357/oh-my-pi/pull/6330), [`docs/rpc.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md), [Issue #5405](https://github.com/can1357/oh-my-pi/issues/5405), [`sdk/rust/omp-rpc/README.md`](https://github.com/can1357/oh-my-pi/blob/main/sdk/rust/omp-rpc/README.md).

- **What changed over v1:**
  1. **Capability handshake:** `ready` frame advertises `supportedProtocolVersions: [1, 2]`, `maxFrameBytes` (1 MiB), `maxReassembledFrameBytes` (64 MiB); client opts in with `{"type":"negotiate_protocol","protocolVersion":2}`.
  2. **Lossless chunked framing (`rpc_chunk`):** Oversized stdout JSON objects split into uninterrupted, validated 256 KiB base64 chunks (`chunkId`, `index`, `count`, `byteLength`) up to 64 MiB instead of failing or silently eliding fields. Interleaved/corrupt chunks fail closed.
  3. **Cursor-paginated history (`get_messages_page`):** Cursors are bound to `(sessionId, durableLeaf, messageCount)` (1–256 items/page) and reject stale cursors or mid-stream pagination.
  4. **Terminal-frame compaction:** Before sending oversized `agent_end`, strips leading messages already delivered via `message_end` and includes `messageCount`.
  5. **Disk-spilled backpressure:** Slow GUI readers no longer blow server RAM — pending stdout spills to a private temp file drained in 64 KiB blocks in strict frame order.
- **Why it's better:** Fixes the exact real-world GUI failure documented in [#5405](https://github.com/can1357/oh-my-pi/issues/5405) where a >1 MiB `agent_end` frame broke the RPC pipe while the child stayed alive holding the session lock — making stock `omp` viable for headless/web/desktop GUIs without forking. (Note: multi-client local daemon/UDS attach-replay proposed in #5405 remains open on `main`.)

### B. The `omp2` Orphan Branch — Ground-Up Rust Rewrite (Pre-release, August 2026)
**Sources:** [`can1357/oh-my-pi/tree/omp2`](https://github.com/can1357/oh-my-pi/tree/omp2), [`README.md`](https://github.com/can1357/oh-my-pi/blob/omp2/README.md), [`PHILOSOPHY.md`](https://github.com/can1357/oh-my-pi/blob/omp2/PHILOSOPHY.md), [`crates/proto/README.md`](https://github.com/can1357/oh-my-pi/blob/omp2/crates/proto/README.md), [`Cargo.toml`](https://github.com/can1357/oh-my-pi/blob/omp2/Cargo.toml).

- **What changed:**
  1. **Multi-client daemon split:** Frontend clients (`omp chat|print|rpc|acp`) connect `N:1` to a per-project **`omp envd`** daemon over build-keyed Unix domain sockets / named pipes (`<state_dir>/<build_id>-env`, enabling zero-downtime upgrades) and optionally to **`omp serve`** (central Tonic gRPC inference/auth/blob daemon).
  2. **Typed binary wire contracts (`omp-proto`):** Replaces ad-hoc JSONL with **varint length-delimited Protobuf** (`omp.env.v1`, `omp.thread.v1`, `omp.document.v1`, `omp.blob.v1`, `omp.toolhost.v1`, exposing `SCHEMA_REV`), with revision-fenced document compare-and-swap + 3-way fuzzy rebase. Stdio JSON-RPC 2.0 remains only for external IDE `omp rpc` bridges.
  3. **Content-addressed `BlobStore`:** Large tool outputs spill out-of-band to `<data_dir>/blobs/<hh>/<hh>/<sha256>` (`artifact://sha256/<hex>`) rather than bloating protocol frames or session journals.
  4. **Sandboxed Python extensions:** Replaces TypeScript extensions with embedded free-threaded CPython (`crates/py`) running in a bounded worker pool (`DEFAULT_WORKER_LAYER_CEILING = 8`) + optional Bubblewrap/Seatbelt `__omp-ext-host` over an inherited FD 3 socketpair, with parent-death watchdogs (`kill(-pgid, SIGKILL)`). Extension/MCP tools ride a discoverable `dyn` bus at **zero prompt-schema slots**.
  5. **Journal-first DOM + UI:** Single-writer `.oms` raw-SSE journal folds into `omp-dom` → `omp-chat` actor → retained-mode `omp-tui` / GPU-accelerated `omp-gui` (`wgpu`/`winit`) + `omp-webview`.
- **Why it's better (and trade-offs):** Eliminates multi-client lock fights, oversized frames, prompt-cache bloat from unused tool schemas, and extension crashes taking down the host. **Caveat:** Unreleased, unstable pre-release (~48 nightly-Rust crates + embedded CPython); binary Protobuf/UDS is not directly consumable from a browser without an HTTP/SSE/WS gateway anyway.

---

## 4. Comparison with Our Klanker Design: What to Adopt, Change, and License Notes

**Validation of our core bet:** All three systems reinforce our earlier recommendation **not** to bind Klanker's core state/protocol to React:
- `dsh` keeps Client models, Conversation assembly, and Slot registries **100% React-free** (React sits only at the leaf `ui-renderer`).
- `pi`'s new `chord/delta` independently converges on **Two Piles / deui** (transactional JSON deltas + `PendingOps` folding with automatic root-replace fallback).
- `omp` already sends **plain HTML `<form>`** over RPC for interactive agent prompts (`ui.formDialog`) — a native fit for `web-engine` + `agents-design`!

### Concrete Upgrades to Adopt into Klanker (`web-engine` + `agents-harness` + `agents-workspace`)

1. **Generation-based reconnect + opening baseline (from `dsh` `follow()` & `omp` #5405):**
   - Start every `<w-stream>` / `/v1/stream` connection with `{ type: "baseline", generation, cursor, tailPage, projections }` followed by sequenced deltas. On reconnect, atomically replace the client window from the new baseline rather than guessing missed events.
2. **Cursor-paginated history + compacted terminal frames (from `omp` RPC v2 PR #6330 & `pi`):**
   - Add `GET /v1/sessions/:id/messages?cursor=<leaf:count>&limit=N` for scrolling older history; reject stale cursors explicitly.
   - Strip cumulative partials on the wire (`message_update` = deltas only), omit already-streamed messages from `turn_end`/`agent_end` (carry `messageCount` instead), and emit a distinct **`agent_settled`** event after retries/compaction/follow-ups finish.
3. **Coalesced deltas + bounded fallback (from `pi` `chord/delta` & `dsh` `conversation.md`):**
   - Fold high-frequency streaming deltas at `requestAnimationFrame` cadence in `web-engine`; if pending ops exceed a ceiling or a sequence gap occurs, cleanly replace the view snapshot (`replace()`) instead of corrupting incremental state.
4. **Reversible plugin effect lifetimes + Slot cardinalities (from `dsh` Cordis / `ui-slots`):**
   - Adopt DSH's `single` / `list` / `keyed` slot types and strict **reversible teardown** in Klanker's plugin host: unloading a plugin atomically unmounts its tabs/slots, removes commands/SSE listeners, and aborts in-flight calls. Keep our **two-tier isolation** (`shadow-wc` + `iframe-mcp` / MCP Apps) — unlike DSH's in-document CommonJS loader, Klanker's Tier-2 iframe gives real security isolation for third-party/agent plugins.
5. **Host Tools + HTML `<form>` dialogs (from `omp` `main` RPC):**
   - Allow Klanker UI plugins to expose **host tools** back to `agents-harness` (same pattern as OMP's `set_host_tools` and Synara's WebMCP, gated by Cordis approvals), and support declarative HTML `<form>` prompts for human-in-the-loop questions/approvals directly via `web-engine`.
6. **Out-of-band SHA-256 `BlobStore` + keep Cordis's zero-slot catalog (from `omp2`):**
   - Spill large tool outputs (>64 KiB) to `<workspace>/blobs/sha256/<hex>` and pass compact artifact refs over `/v1/stream` so frames stay small.
   - Keep `agents-harness`'s existing Cordis meta-tools (`list_catalog` / `load_schema` / `call_job`) — they already deliver `omp2`'s Lesson #6 (zero prompt-schema tax for installed plugins/MCP servers, preserving KV cache!).
7. **Branching + extension entries in session logs (from `pi` `session-format.md`):**
   - If Klanker adds branching or plugin-attached conversation records, store `id`/`parentId` and a dedicated `custom` entry type (persisted and renderable, excluded from LLM context) alongside `agents-workspace`'s `plugins/<id>/state.json`.

### License Constraints for Copying Code

- **`deepseek-ai/deepseek-harness`**, **`badlogic/pi-mono`**, and **`can1357/oh-my-pi` (`main` and `omp2`)** are all **MIT-licensed** — code and wire schemas may be copied or ported freely into Lolaplex repos provided the original copyright and MIT permission notice are retained in copied/derived files.
- **Third-party exclusions:** Both `deepseek-harness` (`THIRD_PARTY_NOTICES.md`) and `oh-my-pi` (`THIRD-PARTY-NOTICES.txt`) explicitly exclude bundled third-party components from their blanket MIT grant; verify any vendored file's header before copying.
- **Unverified / evolving caveat:** `deepseek-harness` (`0.2.3-alpha.2`) and `oh-my-pi`'s `omp2` branch are explicitly marked pre-release with breaking changes expected; copy *patterns and small self-contained primitives*, do not pin Klanker to unstable upstream wire internals.
