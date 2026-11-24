---
type: concept
id: frag-flake-labels-hide-shared-root-causes
provenance: W12 landing — klanker serve e2e + mgmt.install failures, 2026-11-24
ts: 2026-11-24
---

Belief: a failure classified "environmental / flaky" must be matched by
error signature against every other red before it is waived, not by
vibes about where it probably came from.

The klanker serve e2e ("serve A did not boot") was carried as a
Windows/environment flake for a wave while `klanker.mgmt.install` was
loudly missing in two mocked unit tests. Same root cause: f11fcff
rewrote `mgmt.py` and left `__main__.serve` calling `install()` — a real
serve crash on any host, mislabeled as noise because the loudest
symptom was a subprocess that never bound a port.

Mechanical rule: before writing "env failure" on a red row, grep the
failure signature across the whole run output. Two tests failing on the
same missing symbol means the symbol is the bug, never the environment.
