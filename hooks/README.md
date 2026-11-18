# hooks/

Commit discipline — **installed, not convention.** Ported from
`koru-os/hooks/` (the donor; its AGENTS.md documents the doctrine).

```bash
bash hooks/install.sh            # install into THIS repo
bash hooks/install.sh /repo/x    # or into another clone
```

What it installs into `.git/hooks/`:

| hook | job |
|---|---|
| `commit-msg` | three-section gate: `## World Model` (Signal or `acknowledged-none`), `## Membrane` (lineage or `Evolution: acknowledged-none`), `## Gates` (measured rows or `deferred — <reason>`) — all three universal per AGENTS.md |
| `pre-commit` | `scripts/git_wall.sh --staged` — .gitignore oracle + orphan lockfile pairs |
| `post-commit` | appends Signal cards to `.git/signal-cards.jsonl` (untracked telemetry) |

Extras shipped here: `hooks/signals/*.signal` — install seeds only MISSING
signal interfaces into the repo's `signals/` (a gardened one is never
clobbered). `node` is required (the gates are `.cjs` so `package.json`
"type" can't break them).

**Local hooks are bypassable** (`--no-verify`, or never installed). The
server-side wall is `.github/workflows/commit-discipline.yml`, which
re-runs this exact grammar over every commit a PR adds — that is the leg
that cannot be skipped.

**Distribution:** a GitHub repo template can vendor `hooks/` +
`scripts/git_wall*` + the workflow at creation time, but it cannot run
`git config core.hooksPath` or the install — the one-command install per
clone is irreducible.
