---
type: concept
id: frag-the-dep-list-exists-once
provenance: dev-suite switch — the remembered pyproject shim never existed; the Dockerfile's copy of the dep list had already begun to drift
ts: 2026-11-20
---

Belief: the agents-* dependency list exists exactly once — in
`pyproject.toml` — and every surface that needs it derives from there.

A second copy is a lie on a delay: the Dockerfile's hardcoded install list
was already silently incomplete for any dep added to pyproject (pip would
have pulled the PyPI release instead of the git ref — the exact failure
the *_REF build-args exist to prevent). `scripts/dev-suite.py` generates
the requirement lines; the Dockerfile and local installs both consume it.

The dev switch is one name everywhere: `SUITE_REF` (default `dev`), with
per-package `<NAME>_REF` overrides (dashes → underscores). Local installs
prefer sibling checkouts over git refs — editable installs put uncommitted
dev work in the loop, which is what "lock-step" means. Missing siblings
fall back to `git+…@$SUITE_REF`, never to PyPI.
