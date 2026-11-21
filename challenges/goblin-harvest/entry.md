---
name: goblin-harvest
area: serve
needs: []
accept: a parity checklist against the goblin repo exists covering prompt window, settings, and release packaging — every adopted item has evidence
surface: desktop
status: open
evidence: D
provenance: follow-up session (Cypoe: mine goblin for prompt window, settings, and release packaging; launch icon/animation asset to be dropped in repo)
---

# goblin-harvest

`goblin` (Lolaplex/goblin — Tauri 2 + React browser) already solved three
things klanker's desktop shell will need: the **prompt window** (selection
pill / command surface), **settings** (`settings.json` + credential-store
keys with `.env` override), and **Tauri release packaging** (src-tauri
build, launch icon, boot animation). Klanker absorbed klanker-desktop's
work; goblin is the next mine — harvest patterns and code before
reinventing them.

## Acceptance

An `evidence/` checklist rows through all three areas: for each, what
goblin does (file refs into `C:\Users\fabi0\repos\goblin`), adopt/skip
with reason, and for adopted rows the landed klanker artifact. The launch
icon/animation row stays open until the promised asset lands in the repo —
the oracle is the packaged binary showing it, not the file existing.

## Notes

- goblin's UI golden rule (zinc monochrome, token classes, custom chrome)
  is a *style* klanker's desktop shell may or may not share — harvest the
  mechanics, decide the skin separately.
- Credential-store pattern (keyring for API keys, `settings.json` for
  config, env wins) is directly adjacent to agents-keys — check for the
  join before copying.
- goblin itself is a full browser with injected webviews; the prompt
  window is the piece to lift, not the tab engine.
