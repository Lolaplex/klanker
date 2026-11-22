---
type: concept
id: frag-self-deploy-ends-at-push
provenance: sigmanas self-improve loop — klanker rebuilds its own image inside its own container
ts: 2026-11-20
---

Belief: klanker's deployment is self-rebuilding, and the boundary is `docker push`.

The container may pull its own source (`/src` mount), run `docker build`
through the socket (proxy `BUILD=1` preferred, raw socket accepted on
single-tenant hosts), and push to the registry. It **never recreates
itself** — a container that runs `compose up` on its own service kills the
process mid-flight and leaves the swap to luck. Recreation is the host's
job: `pull-latest.sh` cron runs `compose up -d --pull always` and recreates
only when the digest moved.

Why: agent work inside a container ends at the push. The lifecycle swap —
old container down, new container up — is a host privilege, exercised on a
schedule the agent cannot wedge. This keeps the self-improve loop honest:
klanker can change what it runs, but cannot control *when* the old self
stops running.

Concretely: `entrypoint.sh` already self-wires the docker-socket gid at
boot (no `group_add` needed). The public image stays generic — a
deployment's extras (devin-cli on sigmanas, ACP env) live in an overlay
`Dockerfile.nas` + the host's `compose.yml`, both outside the repo;
`KLANKER_DOCKERFILE` names the Dockerfile self-deploy builds. ACP auth is
runtime env (`AGENTS_ACP_API_KEY`), never a layer. The registry stays
localhost-bound — remote pushes keep the docker-save/scp flow, so no TLS
termination is needed on `sigmanas.local`.

**Overlay mode builds base first.** An overlay `FROM` the registry's last
published image is a trap: layering devin on yesterday's base ships a
stale suite and the whole loop below the overlay becomes a no-op
(measured 2026-11-20 — the pushed overlay carried pre-ACP relay while
dev had it). With `KLANKER_DOCKERFILE` set, self-deploy builds the public
`Dockerfile` against `$KLANKER_REF` first, then layers the overlay onto
that fresh base via `BASE_IMAGE`. The overlay pins its FROM to the build
output, never to the registry tag.

**Deploy decisions need a SHA check, not agent intuition.** Measured
2026-11-22 on the Coolify deploy: the agent's emergent `POST
/api/v1/deploy` calls queued up to three same-commit rebuilds in two
minutes, and did not fire at all when merges landed outside an agent
turn. `klanker drift` makes the watcher deterministic: installed
`agents-*` SHAs vs `git ls-remote` tips, deploy only on real drift. On
Coolify it calls the API from injected `COOLIFY_*` env — that is the
portable self-deploy path for every host (a repo webhook per suite repo
does not scale to thirteen). Where a webhook *does* cover the main repo
(VPS), `KLANKER_DEPLOY_WEBHOOK` tells the agent not to double the build.

Open: whether the drift watch should be a harness schedule (`klanker
cron` manifest per host) or a routine — a bare scheduled verb fits the
manifest shape already used for briefings.
