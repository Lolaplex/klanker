---
name: agent-identity-github-app
area: wire
needs: []
accept: gh api shows a commit authored by a klanker GitHub App installation on a scratch repo
surface: any
status: open
evidence: D
provenance: discord thread 2026-11-15 (Cypoe: github app for klanker, own email like devin)
---

# agent-identity-github-app

Klanker acts on GitHub under a shared or ambient identity today (push auth,
`gh` CLI token). Devin lands commits as `devin-ai-integration[bot]` — a real
GitHub App with its own actor, email, and attribution. The gap: klanker has
no first-class git host identity, so its work is indistinguishable from
Fabian's in the log and can't be policy-targeted (auto-merge rules,
reviewers, audit trails).

## Acceptance

`gh api repos/<scratch>/commits` returns a commit whose `author`/`committer`
is the klanker app installation — created through the app's installation
token, not a user PAT. A second check: `gh api apps/<app-slug>` resolves the
registered app with klanker metadata.

## Notes

- GitHub App creation is a console step (secrets stay out of the repo);
  the repo-side work is the token-minting + install flow and where the
  private key lives (agents-keys territory).
- Commit-trailer etiquette raised in the thread: agent trailers should be
  configurable/suppressible, not hardcoded.
- Felix volunteered then punted ("mach du das iwann") — slot is unowned.
