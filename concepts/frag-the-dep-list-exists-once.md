---
type: concept
id: frag-the-dep-list-exists-once
provenance: dev-suite switch — the remembered pyproject shim never existed; the Dockerfile's copy of the dep list had already begun to drift
ts: 2026-11-28
---

Belief: the agents-* dependency list exists exactly once — in
`pyproject.toml` — and every surface that needs it derives from there.
The dev switch is `scripts/dev-suite.py`, and it is one step: install
those dependencies from source, then install this repo editable.

A second copy is a lie on a delay: the Dockerfile's hardcoded install list
was already silently incomplete for any dep added to pyproject (pip would
have pulled the PyPI release instead of the git ref — the exact failure
the *_REF build-args exist to prevent). `scripts/dev-suite.py` generates
the requirement lines. The Dockerfile consumes `--emit`. A local dev
install runs the script, which then installs klanker editable.

The dev switch is one name everywhere: `SUITE_REF`, with per-package
`<NAME>_REF` overrides (dashes → underscores). **Defaults differ by
surface on purpose**: the Dockerfile defaults `main` — an image is a
release artifact, and a bare `docker build` must not silently build dev —
while `dev-suite.py` defaults `dev`, because running it IS the explicit
dev act. `self-deploy.sh` always forwards `KLANKER_REF` explicitly, so it
inherits neither default. Local installs prefer sibling checkouts over
git refs — editable installs put uncommitted dev work in the loop, which
is what "lock-step" means. Missing siblings fall back to
`git+…@$SUITE_REF`, never to PyPI.

The lockstep floors are unpublished. Resolving this repo against PyPI
before those source installs fails on a clean venv, because nothing on
the index satisfies `agents-workspace>=0.2.0,<1` (and the same is true
of the other 0.2 floors). The script installs the suite first and only
then installs klanker editable. That one command is the dev install.
