# Two-host verification

E2E proof that a `klanker serve` hub + two spokes behave as one system:
pairing isolation, workspace share/invite convergence, offline divergence
with scrub replay, session bind/switch with worktree checkpointing, and
device revocation — all over real HTTP processes, real channels, real
`store.db` files. No mocks, no sockets faked, no silent skips.

## The automated gate

```bash
python scripts/gate-two-host.py            # all five scenarios
python scripts/gate-two-host.py --list     # scenario names
python scripts/gate-two-host.py --scenario pair-isolation --scenario revocation
python scripts/gate-two-host.py --keep     # keep the scratch dir for inspection
```

Exit: `0` all checks pass, `1` any check failed (each FAIL line prints
measured evidence), `2` environment refuse (missing agents-relay /
agents-store install). The gate spawns three real `klanker serve`
processes on loopback free ports, each with its own `AGENTS_HOST_DIR`,
then drives the same CLI/HTTP surface an operator uses.

Env knobs (all optional; nothing is hardcoded):

| Env | Default | Meaning |
| --- | --- | --- |
| `KLANKER_GATE_DIR` | fresh tempdir | scratch root for hosts + git fixture |
| `KLANKER_GATE_TICK` | `4` | `KLANKER_SYNC_TICK_SEC` for the serves |
| `KLANKER_GATE_TIMEOUT` | `120` | per-assertion poll budget (seconds) |
| `KLANKER_GATE_LOG_DIR` | `<dir>/logs` | serve stdout/stderr logs |
| `KLANKER_GATE_KEEP` | unset | `1` keeps the scratch dir |

### Scenario map

| Scenario | Proves |
| --- | --- |
| `pair-isolation` | Fresh-pair A→hub: a `local` policy ws and its datoms never cross the channel — the hub never provisions it, no sync worker exists, the local datom stays put. |
| `share-sync` | `workspace invite` mints a ws code on the hub (owner checked over the channel, single attempt); B `workspace join`s as `ws_member`; announce provisions the ws on hub + B and grows `sync_hosts` to A+B. Two `/v1/turn`s on A + one on B land in all three `store.db`s — B's own msgs sync upstream; B has *no trace files* — `store.db` is the history. `mem:*` file→datom→`memory/projection/*.md` and `cfg:*` converge. A third paired device (`role=host`, no ws grant) is refused on every surface: ws lease 403, devices GET/DELETE 401, workspace create 403, `/v1/send` 403, approval decide 403, `/v1/hub/leases` 200 filtered empty. Forged `ws:op`/`ws:announce`/`approval-res` frames from it are transport-acked but dropped at ingest (zero rows, member set unchanged, `malformed:1`). `v_current` byte-identical on all three. |
| `divergence-scrub` | B serve stopped → A and B write divergent datoms (LWW by hlc) → `scrub_entity` + attr/value `scrub_datoms` on A (`removed>0`, tombstone notes `entity`/`attr-hash:<sha>` on the wire, never the plaintext). On rejoin: tombstone replays everywhere (entity purged on all three, `scrubbed` row held), exactly one scrub tx per node (no echo storm), B's later write wins on all three. Wire-level probes: same-ord multi-value op → `card_one_same_ord` refusal + `max(v)` converged; backdated datom below the scrub cutoff never resurrects; scrub of a non-syncable attr → `scrub_forbidden_attr` refusal — all logged as physical `refusal` rows. |
| `bind-switch` | `PUT /v1/workspaces/<ws>/repo-paths` maps slug→checkout on B. Unbound chat leaves `session:host` empty; first mutating `mcp.terminal` tool binds host+worktree+branch (`bind@` actor, `session:repo` = slug only) and writes WIP inside the worktree; a second turn is idempotent (`already_bound`). `chat/stream` first delta <1s. On B with `AGENTS_APPROVAL_MODE=ask`: mutating call → pending file + lease held → concurrent turn 409 `lease_held`, host switch 409 `lease_held` → ask mirrored to the hub → `POST /v1/approvals/<id>` on the hub → `approval-res` back to B (`record_decision`) → bind lands → `chat/stop` cancels mid-run → lease released. Hub-routed `POST .../sessions/<sid>/host` remote-checkpoints A (commit+push, branch fetchable on B), rebinds, prepares a worktree on B, cleans A's orphan via a `cleanup` RPC. A turn on A then dispatches over the channel to B (`msg:host` = B). Dirty B worktree + dead origin → 409 `wip_unpushed` + `session:wip_unpushed` flag; `force:true` rebinds. |
| `revocation` | B holds a live ws lease. `DELETE /v1/hub/devices/<dev>` → B's link flips `revoked:true` in ~1s (`device revoked (401)`), `/v1/hub/send`/`stream`/`lease`/`/v1/turn` RPC all 401, leases released, registry row dropped. A's writes still reach the hub; B receives nothing, and nothing from B reaches the hub — zero new rows except the legit A→hub hop. |

## Manual two-host runbook

Same flow on real machines. Placeholders: `klanker-hub.example` (hub),
host `A` (compute spoke), host `B` (second spoke).

### 1. Hub

```bash
klanker serve                 # RELAY_HOST/PORT env as needed
klanker pair --remote         # single-use code + pair URL (TTY only)
```

### 2. Spoke A

```bash
klanker serve                                              # own host dir
agents-relay channel connect https://klanker-hub.example <code> --label A
```

`connect` stores `clients/hubs.json` + the device token in the host
vault; a running `klanker serve` attaches the channel live. Verify:

```bash
curl -H "Authorization: Bearer <hub-admin>" \
  https://klanker-hub.example/v1/hub/devices   # A: connected=true, role=host
```

### 3. Share a workspace to B

On A:

```bash
klanker workspace create alpha
klanker workspace invite alpha --json      # -> {"code","pair_url",...}
```

On B:

```bash
klanker workspace join 'https://klanker-hub.example/#pair=<token>' --label B
klanker serve                              # provisions alpha on next tick
```

B registers as `role=ws_member` with `allowlist=[alpha]` — it can open
the channel and sync `alpha` but cannot mint credentials, touch remotes,
or widen policy keys. Owner check: only `execution.owner` mints invites;
a non-owner device gets `403 not the workspace owner`.

### 4. Turns + history

Any member POSTs `{"workspace":"alpha","session":"ses_x","message":"hi"}`
to `/v1/turn` on *any* node. Unbound sessions execute locally; once a
git-scoped tool fires the session gate binds `session:host`, and further
turns route to the bound host over the channel (`X-Klanker-Hop` guards
loops). History is the store — a fresh member reads prior turns from
`store.db` without any trace files.

### 5. Switch a session host

```bash
klanker session show ses_x                 # host/branch/repo/wip_unpushed
klanker session switch ses_x <device-id>   # checkpoints + pushes first
```

The switch commits WIP in the session worktree, pushes `klanker/s-<sid>`
to the repo remote, rebinds, and removes the orphaned worktree. On the
new host the branch is already fetchable; `session:repo` is a slug
resolved per host via `host_paths.json` (never synced — each host maps
its own checkout).

### 6. Revoke

```bash
klanker workspace unshare alpha --to <devB>   # member shrink -> ws:revoke
# or fully:
curl -X DELETE -H "Authorization: Bearer <hub-admin>" \
  https://klanker-hub.example/v1/hub/devices/<devB>
```

Unshare freezes B's `alpha` to `local` (existing data stays, sync stops).
Device delete drops the channel, releases its leases, and 401s the
stored token.

## Behind an HTTPS reverse proxy

Terminate TLS at the proxy and forward to the loopback serve:

```
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    # channel is SSE — no buffering, generous read timeout
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Then set `RELAY_TRUST_PROXY=1` on the serve — without it the relay
(rightly) ignores client-supplied `X-Forwarded-*` and would mint pair
URLs on the loopback origin and mark cookies `Secure` incorrectly.
Never set `RELAY_TRUST_PROXY=1` on a directly exposed serve: a spoofed
header would poison pair URLs and cookie policy.

Generated pair/invite URLs take the public origin from
`X-Forwarded-Proto` + `X-Forwarded-Host`, so
`klanker workspace invite` prints an externally redeemable
`https://klanker-hub.example/#pair=<token>` link.

## PWA surface

`klanker serve` mints `RELAY_WEB_TOKEN` once (host vault) and prints a
`?token=` URL. Open it on the phone, "Add to Home Screen" — the web UI
works as a PWA over the same `/v1/*` surface (cookie auth after first
token redeem). All channel/ws flows above work identically through the
proxy; the gate's `/v1/turn` + `/v1/hub/*` calls are the exact HTTP the
PWA drives.
