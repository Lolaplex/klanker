---
type: concept
id: frag-the-shell-owns-the-prompt
provenance: distilled from .agents/memory/decisions/009-clanker-interactive-shell.md (ADR, accepted 2026-09-02)
ts: 2026-11-21
---

Belief: `klanker` with no subcommand IS the interactive shell — one prompt,
one product; never a thin wrapper around bash/PowerShell.

Two programs once both printed `clanker>` and only routed colon-commands +
gateway turns — a chat UI, not a shell. The ruling: the shell core owns
state (cwd, env), parses, execs real programs, and exposes an agent tier.
Resolution order is **builtin → exec → agent**: exec of PATH argv is native
shell behavior (spawn a child), agent interpretation is the klanker-specific
plug on top. When a full-screen TUI child (`vim`, `htop`) runs, the shell UI
suspends and hands the real TTY to the subprocess.

Rejects: `klanker` as a login-shell wrapper around another shell; two human
entrypoints with the same prompt (`client-repl` merges or becomes a thin
wrapper); agents-terminal as the human shell (it is the agent jail).
