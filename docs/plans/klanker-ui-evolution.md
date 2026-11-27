# Klanker UI evolution

**Status:** Research filed as the UI plan (2026-11-27). The eight architectural choices it fed are `DECIDED` in [`klanker-plugin-architecture.md`](klanker-plugin-architecture.md).
**Sources:** the UI architecture review and the `dsh` / `pi` / `omp` addendum, kept in full below.

This is the plan for how Klanker's shell should evolve: two piles of state, a `web-engine` shell, and a small persistent plugin model. The research was written before the neutral-naming rule. Where the review says `klanker.plugin/v1`, `klanker-app-*`, or `klanker/state/*`, use the names in the plugin architecture plan instead (`plugin/v1`, `ui-state/v2`, `host/state/get`, `host/state/set`, `jobs.call:<verb>`, `turn.submit`, `stream.subscribe`).

`klanker-desktop` (Tauri + React) stays up until the web shell can carry chat and plugins. After that it loads the same shell. Do not grow a second UI.

The lines in the research that say "no repository edits" describe how the notes were gathered. They are not a constraint on later implementation.

## Candidate work items

1. One `WorkspaceUIState` document (`ui-state/v2`) for shell chrome, with `strip(state)` dropping focus, drag, and live stream buffers before save.
2. `POST /v1/stream` opens with a baseline and then typed deltas; reconnect replaces the window.
3. Mount the seven contribution points on the shell: `theme`, `background`, `avatar`, `overlay`, `tab`, `sidebarItem`, `nativeMount`. A pure CSS theme or static avatar is a `css-only` plugin.
4. Persist sidebar ribbon order in that UI state.
5. Install, hot-mount, and reversible teardown for a plugin, with no rebuild of the shell.
6. Trust: `shadow-wc` only for verified compiled IR; custom JS in an iframe sandbox that does not get `allow-same-origin`.
7. When chat and plugin parity exist, point the Tauri window at this shell and stop adding React screens.
8. Optional and later: an ephemeral in-chat UI adapter as its own plugin, not inside the engine core.

---

# Klanker UI Architecture Review: Two Piles, Prior Art, React vs. `web-engine`, and a Minimal Persistent Plugin Model

**Date:** 2026-11-27  
**Mode:** Read-only architecture research (no repository edits, no commits, no PRs)  
**Target stack:** [`Lolaplex/web-engine`](https://github.com/Lolaplex/web-engine) (runtime kernel: `w-*` directives, fragment swap, `<w-stream>` SSE), [`Lolaplex/lolaplex-ui`](https://github.com/Lolaplex/lolaplex-ui) (`lx-components` + `w-components` + design tokens), [`Lolaplex/agents-design`](https://github.com/Lolaplex/agents-design) (W3C DTCG tokens, SADT boxes, 5 fail-closed checker rules, deterministic `html_js` derive), [`Lolaplex/klanker`](https://github.com/Lolaplex/klanker) (`/v1/turn`, `/v1/stream`), [`Lolaplex/agents-harness`](https://github.com/Lolaplex/agents-harness) (Cordis job kernel + approvals), [`Lolaplex/agents-workspace`](https://github.com/Lolaplex/agents-workspace).

### Terminology Resolution

- **`cordis harness` (Resolved):** Found in [`Lolaplex/agents-harness`](https://github.com/Lolaplex/agents-harness) (`README.md`), [`Lolaplex/klanker`](https://github.com/Lolaplex/klanker) (`README.md`), and `Lolaplex/agents-board` (`concepts/frag-clanker-fleet-vision.md`). `agents-harness` is the per-request agent loop and Cordis job kernel (`runner.kernel`, `runner.cordis_tools`, `runner/modules/*.json`, `runner.mcp_server` exposing `list_catalog`, `load_schema`, `call_job`), with strict layering ("executor owns no domain state; strictly executes declared CLI verbs and inspects exit codes"), `AGENTS_APPROVAL_MODE` (`ask`/`strict`), and `<untrusted_data>` fencing.
- **`dhs` (Unresolved — not guessed):** Searched `/agent/repos/*` and `org:Lolaplex` repositories/code via GitHub search; zero matches for `dhs`. Left unresolved as requested.

---

## 1. Two Piles (`jbrownson.github.io/two-piles/`): What to Adopt

**Sources opened:**
- [Two Piles of State](https://jbrownson.github.io/two-piles/)
- [`jbrownson/lean-puri`](https://github.com/jbrownson/lean-puri) (metadata verified; Lean 4 incremental UI prototype)

### Core Thesis

Every GUI has **two piles of state**: (1) application data and (2) UI state (focus, caret, selection, scroll, open/closed drawers, active tab). They change independently and have different lifetimes (on quit/relaunch, app state reloads from disk while UI state usually resets). Two Piles evaluates every UI architecture by **two questions**:

1. **Where does UI state live?** (and what identity ties it to app data: widget reference, React `key`, ImGui `ID`, or explicit state placement)
2. **How does the screen learn what changed?** (hand-written dual mutation, full rerun + VDOM diff, full redraw, fine-grained signals, or a checked derivative of the view function)

| Approach | UI State Lives | Identity Cost | How Screen Updates | Key Failure Mode |
| --- | --- | --- | --- | --- |
| **Retained mode** (Win32, jQuery, classic `web-engine` imperative code) | Inside live widgets/DOM | Widget handle | Handler edits data AND DOM by hand | Dual-write drift (missed DOM edit goes unchecked) |
| **React / VDOM** | DOM + component fiber tree | `key` prop | Rerun `view(state)`, diff trees | Work scales with `O(|view|)`, not `O(|change|)`; wrong keys jump caret/focus |
| **Immediate mode** (ImGui / egui) | Library store | Explicit widget `ID` | Redraw entire frame | Full-frame redraw cost; position-based IDs break on delete |
| **Signals** (Solid, Svelte 5, `web-engine` `ReactiveScope`) | DOM + components | Keyed list diffing | Track scalar reads, rerun subscribers | Every change is `"replace value"`; lists still fall back to keyed diffing and cannot express `"insert at 3"` |
| **Puri** (proposed) | **Merged into one app state** | Explicit app choice (on item, keyed map, or position) | Pure `view(state)` rerun | Plumbing every ephemeral UI field; custom widgets lose native text/a11y/IME |
| **deui** (proposed) | **Merged into one app state** | Carried through explicit change actions | Checked derivative `dview(s, ds)` maps state delta `ds` → screen delta `dv` | Writing + proving derivatives for general layout is still research-stage (only proven for one scrolling list widget in `lean-puri`) |

### Concrete Adoptions for `web-engine`, `agents-design`, and Klanker

Do **not** adopt full Puri down to text-input carets (Two Piles explicitly warns custom-drawn textboxes lose platform accessibility and IMEs) and do **not** put Lean proof machinery in `agents-design` core (violates `agents-design/AGENTS.md` boundary #1). Instead, adopt **four high-leverage, pragmatic pieces**:

1. **Puri's Single-Pile + `strip(state)` Persistence Model (for Klanker shell & plugins):**
   - Keep **all durable UI state** (`openTabs`, `activeTabId`, `sidebarCollapsed`, `splitRatio`, `activeBranchByConversation`, `scrollAnchorByTab`, `draftByConversation`, `plugins[id].state`) inside one explicit, JSON-serializable `WorkspaceUIState` object rather than scattered across DOM nodes or closures.
   - Define one explicit `strip(state)` projection that drops truly ephemeral fields (`hoverId`, `isComposing`, `connecting`, transient focus rings) before writing to `agents-workspace` (`disk.save(strip(s))`). Reloading restores tabs, split panels, active branches, and plugin states in one line — and opting a field into persistence across restarts is a one-line edit to `strip()`.
2. **deui's Typed Deltas (`ds`) for Lists & Streams in `web-engine`:**
   - Currently `web-engine/runtime/src/core.js` (`ReactiveScope`) only models scalar `"replace this key"` mutations (`proxy[prop] = value`), which Two Piles points out cannot express structural list changes (`insert`, `remove`, `move`, `appendToken`).
   - Add a small **typed delta channel** on `ReactiveScope` / `<w-stream>` (e.g., `scope.apply(delta)` supporting `{ op: 'append' | 'insert' | 'remove' | 'patch', path, id, value }`) so streaming chat tokens, tool-call cards, and tab reorders apply `O(|delta|)` DOM patches without rebuilding sibling nodes or clobbering user selection/scroll.
   - Pair with `w-preserve` (stolen from htmx's `hx-preserve`) so live elements (composer textarea, active video/audio, open plugin containers) survive parent fragment swaps with focus and caret intact.
3. **The `incremental == recompute` Law as a Property/Playwright Test Invariant (no Lean required):**
   - Two Piles' central mathematical law is the commutative square:
     $$\text{applyView}(\text{view}(s),\; \text{dview}(s, \Delta s)) \equiv \text{view}(\text{applyState}(s, \Delta s))$$
   - Enforce this law in automated tests (Node + Playwright) for Klanker's incremental paths:
     - **Streaming transcript:** DOM after N incremental SSE token/tool deltas must equal a fresh render from the final persisted trace JSON.
     - **Tab strip & branch switcher:** DOM + active tab + preserved state after any sequence of `openTab / closeTab / reorderTab / switchBranch` deltas must equal rendering the final `WorkspaceUIState` from scratch.
     - **`agents-design` `html_js` transitions:** Existing `showcase_parity.playwright.mjs` already approximates this; generalize it to fuzz transition sequences (`design.json` state transitions) and assert incremental DOM state matches fresh-state rendering.
4. **Explicit Collision Policy (No Magic):**
   - Two Piles notes: *"When a change and your focus collide, a policy you chose decides. No magic."*
   - Specify explicit policies in Klanker's shell: e.g., closing the active tab activates MRU unfinished tab (Synara pattern); streaming tokens append without stealing scroll once the user scrolls up (Synara end-follow rule); deleting an active branch selects its nearest sibling.

---

## 2. Repo-by-Repo Teardown: What to Steal, Concrete Files, and Licenses

### A. AI Chat & Workspace Applications

| Repo | License (Verified) | Stack | Concrete Files / Patterns to Steal | What to Skip / Watch Out For |
| --- | --- | --- | --- | --- |
| [`Emanuele-web04/synara`](https://github.com/Emanuele-web04/synara) | **MIT** ([`LICENSE`](https://github.com/Emanuele-web04/synara/blob/main/LICENSE)) | Bun, React 19, Effect-TS, SQLite, Electron | - [`docs/core-concepts.md`](https://github.com/Emanuele-web04/synara/blob/main/docs/core-concepts.md): clean ownership hierarchy (`Workspace → Project → Task → Goal → Turn → Provider session`), Priority activity queue (waiting-on-you → unseen finished/failed → running), tab strip only for saved threads (unsent drafts stay out of tabs), MRU fallback on Archive/Done + Undo toast.<br>- [`AGENTS.md`](https://github.com/Emanuele-web04/synara/blob/main/AGENTS.md): **end-follow transcript rule** (never couple virtualizer measurement to bottom-stick; tool/reconnect activity never rearms detached reader); CSS `:has()` perf guard (`hasSelectorVariants.test.ts`); font-size token test (`uiFontSize.test.ts`); compact submenu rule (`contextMenuGroup.ts`); unified `disclosureMotion.ts`; Beta-only feature gating (server-authoritative, additive migrations).<br>- [`README.md`](https://github.com/Emanuele-web04/synara/blob/main/README.md): **WebMCP** browser surface (page-declared semantic tools for agents) + split-view previews alongside active thread.<br>- `packages/contracts` vs `packages/shared` (explicit subpath exports, no barrels). | Heavy Bun + React 19 + Effect-TS + Electron + Monaco + Lexical + Tailwind stack (`apps/web/package.json`). Do not inherit the runtime weight. |
| [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) | **MIT** ([`LICENSE`](https://github.com/deepseek-ai/chat-demo/blob/main/LICENSE)) | React 18, Zustand, Rspack — **but `src/services/` is pure framework-agnostic TS!** | - [`src/services/api/sse.ts`](https://github.com/deepseek-ai/chat-demo/blob/main/src/services/api/sse.ts): clean 118-LOC WHATWG-compliant `ServerSentEventDecoder` + `readServerSentEvents(stream, signal)` async generator (handles CR/LF/CRLF split across chunks, multi-line `data:`, `AbortSignal` cleanup without leaking readers). **Directly reusable for `POST /v1/stream` in `web-engine`!** (Native `EventSource` only supports `GET`.)<br>- [`src/services/chat/branches.ts`](https://github.com/deepseek-ai/chat-demo/blob/main/src/services/chat/branches.ts): clean immutable tree-as-flat-array (`parentId` + `selectedChildId`) + `buildMessageVersions` referential reuse so streaming tokens don't re-render historical messages.<br>- [`src/components/markdown/useThrottleMarkdownRender.ts`](https://github.com/deepseek-ai/chat-demo/blob/main/src/components/markdown/useThrottleMarkdownRender.ts): **adaptive streaming Markdown throttle** (`nextUpdate = now + min(2000ms, lastRenderMs * 2)`) — trivial to port to vanilla JS in `<lx-markdown>` / `web-engine`.<br>- `src/components/base/anchored.ts` (8 KB zero-dep floating positioning) & `src/services/chat/history/*` (validated ZIP archive export/import excluding secrets). | Direct-to-API browser key storage (`localStorage`) — Klanker must keep secrets server-side / OS keyring (as `klanker-desktop` already does). |
| [`open-webui/open-webui`](https://github.com/open-webui/open-webui) | **Custom "Open WebUI License"** ([`LICENSE`](https://github.com/open-webui/open-webui/blob/main/LICENSE)) — **NOT OSI-open!** Clause 4 forbids altering/removing "Open WebUI" branding if >50 end users in any rolling 30-day window without written permission / enterprise license. | Svelte 5, SvelteKit, FastAPI, SQLAlchemy | **Clean-room architectural ideas ONLY (do NOT copy code!):**<br>- [`backend/open_webui/models/functions.py`](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/models/functions.py): typed plugin configuration via **Valves / UserValves** (admin vs per-user encrypted settings validated by schema), `version_id` + `FunctionHistory` snapshots, `is_active` / `is_global` scopes.<br>- [`package.json`](https://github.com/open-webui/open-webui/blob/main/package.json): adoption of **`@modelcontextprotocol/ext-apps`** (v2.0.4) for interactive sandboxed MCP Apps inside chat. | **License contamination risk — zero code copying.** Also an extreme dependency sprawl (~90 frontend packages including Three.js, Pyodide, Yjs, Tiptap, CodeMirror, Vega, Leaflet, etc., requiring `--max-old-space-size=12288` just to build). |
| [`LibreChat-AI/LibreChat`](https://github.com/LibreChat-AI/LibreChat) *(redirected from `danny-avila/LibreChat`)* | **MIT** ([`LICENSE`](https://github.com/LibreChat-AI/LibreChat/blob/main/LICENSE)); note root [`package.json`](https://github.com/LibreChat-AI/LibreChat/blob/main/package.json) field says `"ISC"` — flag discrepancy if copying files. | React, Jotai/Recoil, Express, Turborepo | - [`client/src/components/Artifacts/state.ts`](https://github.com/LibreChat-AI/LibreChat/blob/main/client/src/components/Artifacts/state.ts) & `UndockedArtifacts.tsx` / `SandboxArtifactTabs.tsx`: **explicitly models docking/undocking state** (`artifactsActiveTab`, `artifactsOpenedArtifactId`, `artifactsPaneFocusRequest`) so moving a live artifact between a side panel and a popup window preserves active tab, edits, and keyboard focus across host remounts (pure Two Piles thinking!).<br>- [`package.json`](https://github.com/LibreChat-AI/LibreChat/blob/main/package.json): **`@shadcn/lint`** rules (`no-raw-colors`, `no-arbitrary-values`, `no-inline-styles` — same discipline as `agents-design` Rule 1) and **`@antithesishq/bombadil`** property-based browser specs (`branch-reload`, `fork-lifecycle`, `hitl-lifecycle`, `steering-lifecycle` — awesome model for testing the Two Piles law!).<br>- `packages/chat/src/core/` separation from `packages/chat/src/react/`. | Heavy multi-service Node/Mongo/Redis/Meilisearch architecture and Recoil+Jotai dual state legacy. |

### B. UI Primitives, State Machines, Compilers, Hypermedia, and Design Tokens

| Project / Repo | License (Verified) | What to Steal | Verdict for Klanker Stack |
| --- | --- | --- | --- |
| [**Zag.js**](https://github.com/chakra-ui/zag) | **MIT** | Framework-agnostic finite state machines (`@zag-js/dialog`, `tabs`, `menu`, `popover`, `combobox`, `splitter`, `toast`) with a `connect(state, send, normalizeProps)` adapter that outputs pure DOM props/ARIA attributes (`data-part`, `data-state`). | **High value.** Either consume `@zag-js/*` inside `lolaplex-ui` Web Components (zero React needed, works in Vanilla JS / Lit / Svelte) or copy its ARIA state-machine specs for accessible tabs, split panes, dialogs, and command palette. |
| [**Mitosis**](https://github.com/BuilderIO/mitosis) | **MIT** | Unified JSON component IR (`MitosisComponent`) with target plugins (Web Components, Svelte, React, HTML). | **Study IR boundaries only.** `agents-design` already has a much cleaner, zero-Node Python DTCG+SADT IR; Mitosis's JSX-lite parser + TS compiler chain would bloat the core. |
| [**Hyperview**](https://github.com/Instawork/hyperview) | **MIT** | Server-driven UI XML (`HXML`) where every interaction is a declarative `<behavior trigger="..." action="replace|append|push|dispatch-event">`. | **Steal the declarative action vocabulary** for agent-emitted interactive UI fragments and approval cards (aligns directly with `web-engine` `w-get`/`w-swap` + `<w-stream>`). |
| [**Adaptive Cards**](https://github.com/microsoft/AdaptiveCards) | **MIT** | Strict separation between **Card Payload (semantic JSON)** and **HostConfig (host theme/tokens/spacing/typography)** — card authors never ship raw colors/CSS, so cards automatically match any host theme. | **Exact philosophical twin of `agents-design` Rule 1!** Steal the `HostConfig` contract for Klanker inline chat cards (tool approvals, status receipts, forms) rendered via `lx-*` / `agents-design` boxes. |
| [**XState**](https://github.com/statelyai/xstate) | **MIT** | Hierarchical/parallel statecharts, guards, invoked actors, and explicit event-driven transitions. | **Steal the mental model** (especially for Klanker's turn lifecycle: `idle → streaming → awaiting_approval → tool_running → settled | error | aborted`, and plugin lifecycle: `installed → mounted → suspended → disposed`). Don't ship full XState inside `web-engine`'s 12 KB kernel; keep `agents-design` transitions simple finite state tables. |
| [**Open Props**](https://github.com/argyleink/open-props) | **MIT** | Zero-JS CSS custom property design scales (`--size-*`, `--radius-*`, `--shadow-*`, `--ease-*`, `--layer-*`), adaptive color schemes, normalized dark/light defaults. | **Steal token taxonomy & z-index layers** (`--layer-1..5`) into `lolaplex-ui` / `agents-design` DTCG token sets. |
| [**Radix Primitives**](https://github.com/radix-ui/primitives) | **MIT** | Gold-standard WAI-ARIA patterns, roving tabindex, focus-trap, portal layering, and `data-state="open|closed"` styling contract. | **Steal the `data-state` / ARIA contract only** (Radix runtime is React-only; use Zag.js for framework-agnostic runtime behavior). |
| [**htmx**](https://github.com/bigskysoftware/htmx) | **0BSD** ([`LICENSE`](https://github.com/bigskysoftware/htmx/blob/master/LICENSE)) | **`hx-swap-oob`** (one response updates multiple targets, e.g., chat message + sidebar unread badge + header status simultaneously), **`hx-preserve`** (preserves live DOM nodes/focus/video across swaps — solves Two Piles!), **`hx-indicator`**, and `htmx.onLoad` lifecycle hook. | **Steal directly into `web-engine`!** Adding `w-swap-oob` (~25 LOC) and `w-preserve` (~20 LOC) to `web-engine/runtime/src/core.js` makes server-driven fragment UIs rock-solid. |
| [**Lit**](https://github.com/lit/lit) | **BSD-3-Clause** | ~5 KB `LitElement` base class, tagged-template `` html`...` `` fine-grained DOM updates (no VDOM, updates only dynamic expressions), reactive properties, and `@lit/context` (reference implementation of the **WCCG Context Protocol**). | **Strong optional addition for `lolaplex-ui` & Tier-1 plugins.** Keeps everything native Web Components with tiny footprint while eliminating raw `innerHTML` / `document.createElement` boilerplate in complex interactive components (e.g., chat composer, virtualized transcript, rich plugin tabs). |

### C. Plugin-Host Prior Art (Opened Docs & Repos)

| Host | Sources Opened | Architecture Pattern to Steal | Lesson / Pitfall to Avoid |
| --- | --- | --- | --- |
| **MCP Apps (`@modelcontextprotocol/ext-apps`)** | [`README.md`](https://github.com/modelcontextprotocol/ext-apps/blob/main/README.md), [`LICENSE`](https://github.com/modelcontextprotocol/ext-apps/blob/main/LICENSE) (Apache-2.0 / MIT transition) | Tools declare `ui://` HTML resources; host renders them in a **sandboxed `iframe`** with bidirectional `postMessage` JSON-RPC (`AppBridge`): host pushes tool data/theme styles in, UI calls MCP tools back through the host (with host approval gate!). Framework-agnostic (examples in Vanilla JS, React, Svelte, Solid, Vue). Supported by Claude, ChatGPT, VS Code, Goose, Open WebUI. | **Adopt as Klanker's Tier-2 plugin protocol!** Every existing `agents-harness` MCP server (`agents-calendar`, `agents-traces`, `agents-board`, user MCP servers) automatically becomes a Klanker UI plugin surface. |
| **VS Code Webview API** | [Webview API Guide](https://code.visualstudio.com/api/extension-guides/webview) | Strict CSP + sandboxed `iframe` + single `acquireVsCodeApi()` handle (`postMessage`, **`getState()` / `setState()`** cheap JSON persistence) + **`WebviewPanelSerializer`** to resurrect open tabs across app restarts. `retainContextWhenHidden` exists only as a high-memory escape hatch. | VS Code explicitly warns: *"Webviews are resource heavy — use sparingly."* Don't put every tiny widget or first-party panel in an iframe; reserve iframes for untrusted / arbitrary-stack plugins. |
| **Obsidian Plugins** | [`obsidianmd/obsidian-sample-plugin`](https://github.com/obsidianmd/obsidian-sample-plugin) (`manifest.json`, `src/main.ts`) | Ultra-simple manifest (`id`, `name`, `version`, `minAppVersion`), lifecycle (`onload`/`onunload`), **`loadData()` / `saveData()`** per-plugin JSON persistence, and **auto-disposing host registrations** (`registerDomEvent`, `registerInterval`, `addCommand`, `addRibbonIcon`, `addStatusBarItem`, `addSettingTab`). | Zero sandbox isolation (every plugin runs in full app DOM/Node context — one bad plugin can corrupt the host or exfiltrate secrets). Keep Obsidian's *ergonomics* (`loadData`/`saveData`, auto-dispose, contribution points), NOT its lack of isolation! |
| **JupyterLab Extensions** | [Develop Extensions Docs](https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html) | **Prebuilt ESM bundles** loadable dynamically per-user/per-workspace **without rebuilding the host and without Node.js**; clean plugin taxonomy (Application plugin, MimeRenderer plugin, Theme plugin); token-based service DI. | Source-extension rebuilds were deprecated in JupyterLab 3.0 specifically because requiring Node.js to install a plugin broke multi-user & local installs. Klanker plugins must NEVER require rebuilding the Klanker shell. |
| **Grafana Plugins** | [Plugin Types & Usage](https://grafana.com/developers/plugin-tools/key-concepts/plugin-types-usage) | Clean 3-type taxonomy (**Panel** visualization, **Data source** connector, **App** multi-page bundle) + **provisioning-as-code** (GitOps / declarative workspace files enable plugins & dashboards reproducibly). | Tightly coupled to Grafana's React runtime + shared bundle versions (`@grafana/ui`), creating upgrade friction across major versions. |
| **Home Assistant Custom Cards** | [Custom Card Docs](https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/) | Zero-build ESM Custom Elements (`setConfig(config)`, `getGridOptions()`, `loadCardHelpers()`) + **WCCG `context-request` event** (`bubbles: true, composed: true`) so any Web Component subscribes to selective host slices without polling or framework coupling. | Passing the full global `hass` object on every state tick causes over-rendering (which is why HA added selective `context-request` subscriptions). Start with selective context subscriptions from day one. |

*(Note: Obsidian's docs SPA at `https://docs.obsidian.md/Plugins/Getting+started/Anatomy+of+a+plugin` returned an empty body to `WebFetch`, so Obsidian details above were verified directly from `obsidianmd/obsidian-sample-plugin` on GitHub instead.)*

---

## 3. React or Not? Direct Architectural Comparison

*(Verified baseline fact: [`Lolaplex/klanker-desktop`](https://github.com/Lolaplex/klanker-desktop) currently uses Tauri 2 + React 19 + TypeScript + Tailwind v3 for its desktop wrapper, while `agents-board` uses PHP + HTML fragments + vendored Svelte-compiled `lx-*` Web Components, `web-engine` is 12.8 KB zero-dep JS, and `agents-design` compiles directly to deterministic `tokens.css` + `components.css` + `index.html` + `fragments/*.html`.)*

| Dimension | React 19 (Vite / SPA) | Svelte 5 (App or Custom Elements) | `web-engine` + Web Components (+ optional Lit / Zag.js) |
| --- | --- | --- | --- |
| **Plugin isolation (iframe / Shadow DOM / WC)** | **Weak as a host.** In-process React plugins must match the host's exact React version (hook dispatcher collisions), so isolation still forces iframes or Module Federation complexity. | **Good for authoring Web Components** (already proven in `lolaplex-ui/packages/lx-components`), awkward as a dynamic plugin host runtime unless compiled to custom elements. | **Best-in-class.** Native browser boundary: Tier-1 plugins are Shadow-DOM Custom Elements (CSS-isolated via inherited `--lx-*` tokens, WCCG `context-request`); Tier-2 plugins are sandboxed iframes (MCP Apps `postMessage`). Any plugin can internally use vanilla JS, Lit, Svelte, or React without host coupling. |
| **Persistent user apps / tabs** | Works well with Zustand/Jotai + `localStorage`/API, but React component state is coupled to mount lifecycle (see LibreChat's complex portal hacks in `Artifacts/state.ts` just to survive host moves). | Same mount-lifecycle constraint; Svelte 5 runes make external stores clean. | **Cleanest fit with Two Piles.** One host `WorkspaceUIState` + `strip(s)` persisted in `agents-workspace`; hidden tabs either serialize via `getState/setState` (VS Code model) or stay parked in DOM with `hidden` + `w-preserve` when stateful. |
| **Streaming chat (`/v1/turn`, `/v1/stream`)** | Strong ecosystem (markdown, virtualizers), but easy to trigger whole-subtree re-renders or virtualizer/scroll feedback loops (Synara's `AGENTS.md` explicitly warns about this). | Very fast fine-grained DOM updates; good streaming ergonomics. | **Very strong** once `web-engine` adds `POST` SSE streaming (steal DeepSeek's 118-LOC `ServerSentEventDecoder`) + adaptive Markdown throttle (`lastRenderMs * 2`) + typed list deltas. Zero VDOM overhead per token. |
| **SSR / HTML fragments (`agents-relay`, docs site)** | Requires Node SSR runtime (Next/Remix) or ships an empty SPA shell + hydration mismatch bugs. Terrible fit for Python stdlib `agents-relay` + `web-engine` SSG. | SvelteKit needs Node for SSR; static adapter works for docs. | **Native fit.** Python `agents-relay` / `web-engine` SSG serves real HTML immediately; `w-get` / `w-swap-oob` / `<w-stream>` enhance progressively with zero hydration step. |
| **Agent-generated UI (`agents-design derive`)** | **High friction.** Generating React plugins requires an npm/Vite/bundler pipeline on the user's machine (breaking Klanker's zero-Node ethos and JupyterLab's hard-won lesson). | Requires Vite/Svelte compiler step on every agent edit. | **Unmatched.** `agents-design derive` emits plain `tokens.css` + `components.css` + `index.html` + `fragments/*.html` directly into `<workspace>/plugins/<id>/` with **zero build step**, checked by 5 fail-closed rules before a byte is written! |
| **Bundle size / no-build** | 150–400 KB+ base bundle + Node/Vite/bundler toolchain required. | Tiny runtime (~5–20 KB), but build step mandatory. | **`web-engine.runtime.js` is 12.8 KB uncompressed** (zero npm deps); optional `Lit` adds ~5 KB; `lx-components` loads lazily on demand. |
| **Long-term maintenance** | Huge ecosystem & hiring pool, high churn (React 18→19, Compiler, RSC, bundler churn, dependency CVEs — see Synara/LibreChat `overrides` lists). | Clean compiler, smaller ecosystem, Svelte 4→5 migration showed major-version churn. | **Lowest churn.** Browser standards (Custom Elements, Shadow DOM, CSS custom properties, `postMessage`, `EventSource`, `fetch`) have decades of backward compatibility. Main cost: you own a small (~500–1,000 LOC) runtime & accessibility discipline (mitigated by Zag.js). |

### Clear Recommendation

1. **Do NOT build Klanker's web shell, docs site, or plugin host on React.** React fights every strength of the stack you already built (`agents-harness` zero-Node Python, `web-engine` 12.8 KB HTML-fragment/SSE runtime, `agents-design` zero-build `html_js` derivation, `lolaplex-ui` custom elements). Making React the host would also trap every user/agent plugin behind a Node bundler and version lock-in.
2. **Build Klanker's web UI + docs + plugin host on `web-engine` + Web Components (`lolaplex-ui`), with two surgical additions:**
   - **Small runtime upgrades in `web-engine`:** (a) `POST` SSE reader (port DeepSeek's 118-LOC `ServerSentEventDecoder` into `<w-stream>` / `streamFetch`), (b) `w-swap-oob` + `w-preserve` (from htmx), (c) typed list deltas on `ReactiveScope` (from Two Piles).
   - **Optional `Lit` (~5 KB) + `Zag.js` inside `lolaplex-ui` complex widgets** (command palette, accessible tabs/split-pane, chat composer, virtualized transcript) — compiled once in `lolaplex-ui`, consumed as plain custom elements by Klanker with zero build step in Klanker itself.
3. **Where React IS still worth it (narrow, explicit scope):**
   - **Inside Tier-2 sandboxed iframe plugins (MCP Apps)** whenever a specific plugin genuinely needs a React-only heavy library (e.g., Excalidraw, React Flow, Lexical, complex Monaco/spreadsheet integrations). Because the plugin boundary is an **iframe + `postMessage` (MCP Apps)**, a React plugin runs happily inside a zero-React `web-engine` host!
   - **Short-term pragmatism in `klanker-desktop`:** Keep the existing Tauri + React 19 UI running while Klanker's `web-engine` web shell is built; once the web shell reaches feature parity, Tauri can load the same `web-engine` shell directly (cutting UI maintenance in half).

---

## 4. Minimal Persistent Plugin Model for Klanker (`web-engine` + `agents-harness` + `agents-workspace`)

### Design Principles

- **"Everything is a plugin"** (chat, traces viewer, memory browser, board/kanban, calendar, docs, user/agent-built mini-apps are all mounted via the same tab/panel registry — just like JupyterLab).
- **Zero host rebuild** (JupyterLab prebuilt model + `agents-design` zero-build `html_js` output).
- **Two isolation tiers, one manifest:**
  - `shadow-wc` (**Tier 1 — trusted / first-party / `agents-design`-derived**): Plain HTML/CSS/ESM Custom Element in Shadow DOM, styled automatically by host `--lx-*` tokens, subscribing via WCCG `context-request`.
  - `iframe-mcp` (**Tier 2 — untrusted / third-party / MCP Apps / React/arbitrary stack**): Sandboxed `iframe` (`sandbox="allow-scripts"`) speaking the **MCP Apps (`@modelcontextprotocol/ext-apps`)** `postMessage` JSON-RPC bridge, receiving host theme tokens via CSS vars notification.
- **Cordis is the only capability boundary:** Plugins NEVER get raw filesystem, shell, or API secrets. Every privileged action invokes a declared Cordis verb (`runner.mcp_server` `call_job`) and goes through `AGENTS_APPROVAL_MODE` (`ask` / `strict`).

### 1. Workspace Directory Layout (`agents-workspace`)

Extends [`Lolaplex/agents-workspace`](https://github.com/Lolaplex/agents-workspace) with one new `ui` / `plugins` domain under `<workspace_root>` (default `~/.agents` or `~/.agents-workspaces/<slug>`):

```text
<workspace_root>/
├── workspace.json                # existing agents-workspace metadata
├── memory/  traces/  schedules/  modules/  skills/  relay/
├── ui/
│   └── workspace-state.json      # Two-Piles strip(state): open tabs, activeTab, split layout, pinned plugins
└── plugins/
    └── <plugin-id>/
        ├── plugin.json           # manifest + declared capabilities
        ├── state.json            # persistent plugin state (getState/setState; or row in store.db)
        ├── design.json           # optional: agents-design IR source (if agent-generated)
        └── dist/                 # derived/prebuilt static files (index.html / element.js / tokens.css)
```

### 2. Plugin Manifest (`plugin.json`)

```json
{
  "schema": "klanker.plugin/v1",
  "id": "com.workspace.budget-tracker",
  "name": "Budget Tracker",
  "version": "0.1.0",
  "kind": "tab",
  "isolation": "shadow-wc",
  "entry": "./dist/index.js",
  "element": "klanker-app-budget-tracker",
  "icon": "wallet",
  "mount": {
    "slots": ["tab", "side-panel"],
    "singleton": true,
    "retainWhenHidden": false
  },
  "capabilities": [
    "workspace.state.rw",
    "cordis.call:mcp.memory.read",
    "cordis.call:mcp.schedule.list",
    "turn.submit",
    "stream.subscribe:turn"
  ],
  "configSchema": {
    "currency": { "type": "string", "default": "EUR" }
  },
  "provenance": {
    "source": "agents-design",
    "ir_sha256": "...",
    "derived_at": "2026-11-27T05:00:00Z"
  }
}
```

### 3. Capabilities & Permissions Matrix

| Capability | Meaning | Enforcement Point |
| --- | --- | --- |
| `workspace.state.rw` | Read/write this plugin's own `<workspace>/plugins/<id>/state.json` (and optional `store.db` namespace) | `agents-relay` HTTP endpoint `/v1/workspaces/:ws/plugins/:id/state` (strictly path-jailed to `:id`) |
| `cordis.call:<verb-glob>` | Invoke specific Cordis catalog verbs (`runner.mcp_server` `call_job`) | Host checks manifest allowlist **and** forwards through `agents-harness` `AGENTS_APPROVAL_MODE` (`ask`/`strict`) — mutating verbs still prompt the user! |
| `turn.submit` | Send a prompt into Klanker `/v1/turn` or `/v1/stream` (e.g., "ask agent to refresh this dashboard") | Host tags origin as `plugin:<id>`; harness fences plugin payload in `<untrusted_data source="plugin:<id>">` |
| `stream.subscribe:<topic>` | Subscribe to host SSE topics (`turn`, `traces`, `approvals`, `schedules`) | Filtered read-only fan-out from `agents-relay` |
| `ui.commands` | Register Command Palette entries & keyboard shortcuts (Obsidian model) | Auto-disposed on plugin unload |
| `network:none` (default) | Tier-2 iframe CSP sets `connect-src 'none'` unless explicit domain allowlist is approved | HTTP `Content-Security-Policy` header on `/plugins/:id/dist/*` |

### 4. Mounting, Lifecycle & Persistence (Two Piles + VS Code + Home Assistant)

1. **Shell state (`ui/workspace-state.json`):** Holds `{ activeTabId, tabs: [{ tabId, pluginId, title, params, pinned }], sidePanel: { open, pluginId, width }, theme }`. Ephemeral fields (`hover`, `resizing`, `connectionStatus`) are stripped via `strip(state)` before debounced `PUT /v1/workspaces/:ws/ui-state`.
2. **Tier-1 (`shadow-wc`) mount contract:**
   - Shell imports `./plugins/<id>/dist/index.js` via native ESM `import()`, creates `<klanker-app-...>`, calls `el.setConfig(config)` + `el.setInitialState(savedState)` (Home Assistant + VS Code pattern).
   - Plugin requests host services (`hostApi`, `theme`, `activeWorkspace`, `stateStore`) via WCCG `context-request` event and persists state via `host.setState(strip(localState))` (debounced write to `state.json`).
   - All listeners/timers attach via `host.onCleanup(fn)` (Obsidian auto-dispose) so closing or disabling a plugin leaks zero memory.
3. **Tier-2 (`iframe-mcp`) mount contract:**
   - Shell mounts `<iframe sandbox="allow-scripts" src="/plugins/:id/dist/index.html">` (or `ui://` resource from an MCP server).
   - Uses `@modelcontextprotocol/ext-apps` JSON-RPC over `postMessage` (`ui/initialize`, `ui/notifications/host-context-changed` for `--lx-*` theme tokens, `tools/call` routed to Cordis with approval gate, plus `klanker/state/get` & `klanker/state/set` for workspace persistence).
4. **Agent-created persistent app loop (the killer workflow):**
   1. User tells Klanker in chat: *"Build me a persistent tab for tracking our weekly hardware orders."*
   2. Klanker designs a `design.json` IR (using `agents-design` MCP tools `design_get_tokens` → `design_check` → `design_derive`), passing all 5 fail-closed checker rules (zero raw colors/lengths, explicit SADT inputs/controls/outputs/mechanisms).
   3. Klanker writes `plugin.json` + derived static files into `<workspace_root>/plugins/<id>/dist/` via a Cordis verb (gated by `AGENTS_APPROVAL_MODE` on first install / capability grant).
   4. `agents-relay` emits a `plugin.registered` SSE event → Klanker's `web-engine` shell adds the tab to `workspace-state.json` and mounts it immediately — **zero npm, zero Vite rebuild, survives restarts, scoped to that workspace.**

### 5. Flagged Unverified / Open Items

- **`dhs`:** Could not be resolved from any accessible Lolaplex repository or local workspace file; needs clarification from Fabian before factoring into the plugin spec.
- **`klanker-desktop` convergence:** Currently React 19 + Tauri 2 (`Lolaplex/klanker-desktop`). Deciding whether `klanker-desktop` becomes a thin Tauri shell over Klanker's `web-engine` HTTP UI (recommended to avoid maintaining two UIs) is an open product call.
- **MCP Apps spec stability:** `@modelcontextprotocol/ext-apps` is actively evolving (spec `2026-01-26` + `draft`, Apache-2.0 transition); pin a specific protocol version in Klanker's `AppBridge` host adapter.
- **`LibreChat` license metadata mismatch:** `LICENSE` file is MIT, while root `package.json` declares `"ISC"`; both are permissive, but keep clean-room or check per-file headers if borrowing code.


---

# Klanker UI Review — Addendum: `dsh`, `pi`, and `omp` (+ `omp` v2)

**Date:** 2026-11-27  
**Mode:** Read-only research addendum to `/cursor/stores/self/klanker-ui-review.md` (no code edits, no commits, no PRs).

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
