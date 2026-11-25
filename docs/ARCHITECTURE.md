# Suite architecture

Canonical layering of the Lolaplex agent suite. Ground truth is the
running code; this file names the modules that own each contract so a
claim can be re-verified with `git grep`.

```
 surface   klanker            CLI / Web (apps/web) / Desktop (apps/desktop)
 gate      agents-harness     runner.loop + session_gate (pre-exec bind)
 hub       agents-relay       channel, pairing, leases, /v1/remote proxy
 transport agents-sync        opdist op-log envelopes + peer cursors
 log       agents-store       store.db: datoms, HLC ord, v_current views
 root      agents-workspace   Host/Workspace split, workspace.json, vault
```

A turn flows top-down: klanker resolves the workspace, the harness runs
the loop, host-local tools bind the session to this host, and state
moves between machines only as store op-log envelopes over the relay
hub channel. Nothing else crosses the wire.

## agents-workspace — the host/ws boundary (repo `agents-workspace`, package `agents_workspace`)

- One host root per machine: `AGENTS_HOST_DIR`, default `~/.agents`.
  It holds infrastructure only — `keys/`, `secrets/`, `run/`, `cache/`,
  `logs/`, `clients/`, `providers/`, `mcp/`, `agents.json`,
  `users.json`, `host_paths.json`.
- Every data workspace lives at `<host>/workspaces/<id>` and is
  selected by id (`AGENTS_WORKSPACE`), never by a process-global root.
- Dir domains inside a workspace: `memory`, `rules`, `skills`,
  `modules`, `schedules`, `traces`, `routine-runs`, `relay`,
  `personas`, `content`, `work`, `browser`. File domains:
  `config.json`, `members.json`, `sync_config.json`, `mcp.json`,
  `calendar.json`, `workspace.json`, `store.db`.
- `workspace.json` carries the ownership contract:
  - `sync_policy`: `local | synced | shared`. Reads are fail-closed —
    a missing, empty, or unknown value resolves to `local` (`workspace.py`
    `_read_sync_policy`); `local` never emits ops. `synced` fans the
    op-log out to `sync_hosts`; `shared` is reserved multi-user.
  - `sync_hosts`: hub device ids (the channel's ids, not
    `Host.host_id()`); the hub fan-out allowlist. Strict write-side
    validation — a malformed shape fails closed to `()`. `local` with a
    non-empty list is a `ValueError`.
  - `default_host`: host-picker id used when a session is unbound.
  - `repos`: `[{slug, url, checkout_mode}]`, `checkout_mode` =
    `shared | worktree`. Paths stay host-local.
  - `execution`: `{owner, failover: standby | none, lease_sec}` —
    `owner` is the peer id that owns execution (or `""`),
    `lease_sec` an int in `[15, 3600]`.
- `secrets.py` owns the host vault: `<host>/secrets/host.json` and
  `<host>/secrets/ws-<id>.json` (0700/0600). `resolve_secret` default
  order for workspace/provider secrets is `ws-<id>.json` > legacy
  `<ws>/secrets.json` > keyring > `host.json` > legacy
  `<host>/secrets.json` > `ENV` (`AGENTS_SECRETS_ORDER=env-first`
  flips `ENV` + `/run/secrets` to the front); `scope="host"` and
  `INFRA_SECRET_KEYS` follow `ENV > /run/secrets > keyring >
  host.json` and never read workspace files, while
  `scope="workspace"` reads only the target ws vault files.
  `INFRA_SECRET_KEYS` (`RELAY_SECRET`,
  `GATEWAY_SECRET`, `RELAY_WEB_TOKEN`, `TELEGRAM_BOT_TOKEN`, …) are
  stripped from every env the resolver hands to a turn.
- `migrate.py` moves a legacy flat `~/.agents` layout into
  Host/Workspace form (see `docs/RUNBOOK.md`).

### The never-sync boundary

Host-local by contract — no sync path may carry them:

- `<host>/secrets/host.json`, `<host>/secrets/ws-*.json` (the vault)
- `<host>/keys/*.ed25519` (private key material)
- `<host>/users.json`, `<host>/host_paths.json`, `<host>/agents.json`
- hub tokens / pairing secrets (vault-resident), `<host>/clients/hubs.json`
- provider manifests `<host>/providers/*` and ACP config
- ephemeral `<ws>/run/` state (delegates, procs, lockfiles)

Enforcement is at two ends: `agents_sync/domains.py` blocks names,
parts and extensions (`FORBIDDEN_*`, `is_path_safe`) before collection,
and `agents_store.ingest` refuses unknown attrs on the receiving host —
so a hostile or buggy payload dies as a refusal, never a partial apply.

## agents-store — the op-log (repo `agents-store`, package `agents_store`)

- One SQLite `store.db` per workspace (`<ws>/store.db`; raw
  `.db`/`.db-wal`/`.db-shm` never file-sync — only ops move).
- Append-only `datom` rows `{e, a, v, added}`; no UPDATE or DELETE.
  Current state is the `v_current` view keyed by `ord`
  (`db.py`: "datom.ord + tx origin/hlc + ord-keyed v_current").
- `hlc.py` assigns hybrid-logical-clock ord keys so txs merge into one
  total order across hosts; dedupe identity is `(origin_actor,
  origin_seq)` — a re-broadcast tx collapses instead of replaying.
- `ingest.py` is the only write path for remote ops: schema-checked
  attrs (`unknown_attr` refusals), `ops_since(cursor)` is the tail a
  sync worker drains, `cursor()` is the resume point.
- `scrub.py` is the privileged physical redaction path — the only
  code that can delete datom rows (GDPR/accident removal). It drops
  the append-only triggers inside a guarded section, deletes, and
  restores them; an append-only refusal row audits the scrub first,
  and a PII-free `scrubbed(e,T)` tombstone tx makes synced peers
  replay the same scrub and drop late-arriving datoms for `e`.
  Operator tooling only — never reachable through `transact()`.
  Credential hygiene is a different concern, handled at the
  projection boundary: klanker's `migrate --to-store` redacts
  secret-shaped keys/values before anything becomes a datom
  (`src/klanker/migrate.py`).

## agents-sync — distribution (repo `agents-sync`, package `agents_sync`)

- `opdist.py` is the wire carrier: `pack_ops` turns a store's
  `ops_since` tail into envelopes
  `{v:1, actor, seq, hlc, op:"assert", note, datoms:[]}`.
- Dedupe is `(actor, seq)`: locally minted ops get the sender's node id
  stamped at send, re-broadcast ops keep their true origin — echo and
  re-delivery collapse in `BoundedSeen`.
- `PeerBook` persists per-peer cursors in `sync_peers.json`
  (`cursor`/`acked`/`advance`/`ack`/`resync`). Delivery is ack-gated:
  a peer's cursor advances only on `ack`, so re-delivery after loss is
  automatic. `deliver`/`receive` hand envelopes to a caller-supplied
  ingest callback — agents-sync owns transport, agents-store owns
  semantics.
- Plane 1 (file-bundle domain sync: `sync`/`push`/`pull`/`serve`,
  `bundle.py`, `merge.py`, `tombstones.py`) is the legacy path, being
  deprecated in favour of the op-log plane above; workspaces under
  `sync_policy="local"` must never emit Plane 1 transfers either.

## agents-relay — the hub (repo `agents-relay`, package `agents_relay`)

`channel.py` is the hub-side channel manager: one connected device =
one channel = one seq space. Downstream is a per-device SSE stream
(`GET /v1/hub/stream`), upstream is batched envelopes
(`POST /v1/hub/send`). Kinds: `hello`, `presence`, `op`, `rpc-req`,
`rpc-res`, `ack`, `resync`, `ws:announce`, `ws:revoke`,
`approval-req`, `approval-res`; a replay ring feeds `?since=` resume.
`ws:*` frames are ws-share control traffic routed to the hub's
`set_ws_handler` and the spoke's `ChannelClient.on_ws` (never through
`op`); `approval-*` frames mirror host approvals across devices.
`channel_client.py` is the spoke-side client klanker's `WsSync` uses.

Hub surface (`http_adapter.py`):

- `POST /v1/pair/create` + `POST /v1/pair/redeem` (`pairing.py`) —
  pair-once device enrolment; redemption yields a device credential and
  optional `ws_member` workspace grants.
- `GET/DELETE /v1/hub/devices[/<id>]` (`devices.py`) — paired-device
  list and per-device revocation.
- `POST /v1/hub/lease`, `GET /v1/hub/leases` (`leases.py`) — session
  run-lock leases: acquire/renew/release with fencing; one live run
  per (ws, session).
- `GET|POST|DELETE /v1/remote/<id>/<path>` — authenticated proxy into a
  paired device's local API (remote mounts `/v1/remotes`).
- `/v1/workspaces[...]` (`workspaces.py`) — workspace CRUD, members,
  personas, sessions, `store/append`, `store/items`, `store/pane`,
  `inbox` (`store_api.py`, `providers_api.py` for provider manifests).
- `presence` frames carry device liveness on the channel.

## agents-harness — the pre-exec gate (repo `agents-harness`, package `runner`)

- `runner.loop` runs one turn per process: catalog modules become
  tools, `call_job` executes Cordis jobs, approvals gate mutating
  calls. No harness state crosses machines.
- `session_gate.py` binds a session to a host the first time a
  host-local tool executes in a loop process. Host-local = canonical
  module names in `HOST_LOCAL_TOOLS`, manifests flagged
  `host_local: true`, or stdio `mcp_remote` servers; ws-data tools
  (memory, calendar, traces, persona, schedule, skills) and HTTP/SSE
  remotes stay portable.
- The gate fires `AGENTS_SESSION_BIND_CMD` once per process
  (`{session}`/`{tool}`/`{workspace}` placeholders) — klanker maps that
  to the `session:host` datom. It runs after approval, before the tool
  executes, and fails closed: a bind failure aborts the call
  (`SessionGateError`) instead of running unbound.
  `AGENTS_PARENT_SESSION` makes delegate/persona children bind the
  root session, never `ses_dlg_*`.
- `workspace_config.py` / `workspace_tree.py` read the workspace
  contract (`workspace.json`, domain dirs) for the loop.

## klanker — the surface (`src/klanker/`)

CLI + Web (`apps/web`) + Desktop (`apps/desktop`, thin shell over the
web bundle). `klanker serve` is where the layers join:

- `wssync.py` `SyncRuntime`: one `WsSync` per workspace per channel
  peer. Spoke side drains local ops upstream (`origin_only`), ingests
  incoming batches, acks cursors; hub side `attach_hub` lazily creates
  a `WsSync` per `(ws, device)` to ingest spoke ops and fan every ws's
  tail out to connected devices. Delivery is ack-gated; local push
  fires on `notify()` (turn writes) plus a 60s tick
  (`KLANKER_SYNC_TICK_SEC`).
- `wshare.py` — `klanker workspace share|unshare|members`: edits only
  local `workspace.json`; a running serve reconciles member-set diffs
  on its sync tick into `ws:announce`/`ws:revoke` frames.
  `workspace invite` mints a ws-scoped pair code/QR on the hub;
  `workspace join` redeems it (pairs the device + grants the ws).
- `session.py` — `session:host` is a card-one datom: sessions stay
  unbound (`""`) until a host-local tool needs a host; hosts switch
  between prompts. Writes go through `ingest` with actor
  `bind@<node>:<session>` — LWW-correct, replay-idempotent. Code moves
  by Git, never by file sync: each session gets a worktree on branch
  `klanker/s-<session-id>` under `$KLANKER_WORKTREE_DIR` or
  `<host>/worktrees`, outside the user's repo; checkpoints commit only
  inside the session worktree.
- `remote_dispatch.py` — remote turn/query dispatch on `session:host`
  (or ws `default_host`): hub → `channel.hub().rpc_call`, spoke →
  `<hub>/v1/remote/dev-<host><path>` under the device credential.
  `X-Klanker-Hop` caps at 2 (508) so a bounced request can't loop.
  Fail-loud: unreachable host = `503 host_offline` (or
  `409 wip_unpushed`), never silent local execution; takeover only via
  explicit `switch_host`/`failover`. `turn_lease_guard` acquires one
  live run per (ws, session), renews every `lease_sec // 3`; spokes
  POST `/v1/hub/lease`, a dead hub falls back to a local lockfile in
  `<ws>/run/` — never to running twice.
- `mgmt.py` — hooks wired into `agents_relay.http_adapter`:
  `hub_links` (hubs.json rows + live state, never tokens),
  `hub_connect` (redeem invite → hubs.json row + vault token; a running
  `SyncRuntime` attaches a `ChannelClient` immediately via
  `_attach_new_hubs` — no serve restart, no next-tick wait),
  `hub_disconnect`,
  `session_host_switch` (checkpoint → rebind → cleanup).
- `msgsync.py` — projects trace message events into `msg:*` datoms:
  entity `msg:<session>:<key>` where `key` is a content hash (never a
  local ordinal), origin `proj@<node>:<session>` with per-actor
  `origin_seq`, `msg:host`/`msg:ts` carry provenance. `session:*`
  entities (`session:host`, `session:title`, `session:last_active`,
  `session:branch`, `session:repo`, `session:wip_unpushed`) and
  content-addressed `frame:*` entities maintained the same way.
  Incremental: per-file byte offsets in `<ws>/msg_cursors.json`.
- `migrate.py` — `klanker migrate --to-store`: folds `personas/`,
  `config.json`, `memory/` into `persona:<id>` / `cfg:<key>` /
  `mem:<slug>` datoms (`origin_actor="import@<host>:store"`). The store
  copy is scrubbed — secret-named keys, credential-shaped values and
  embedded credentials are redacted; only env-indirection names survive.
  `--archive` moves sources to `<ws>/archive/pre-store/` unchanged.
- `store_domains.py` — `ensure_domains` registers the full attr set
  (`MSG_ATTRS + MIGRATE_ATTRS`) on hub AND spokes before any sync or
  import runs; `ingest` refuses unknown attrs, so a half-registered
  host turns remote datoms into `unknown_attr` refusals.

## Lifecycle invariants

- Pair once, share per workspace: device enrolment is a hub concern
  (`/v1/pair/*` → hubs.json + vault); access is a workspace concern
  (`sync_hosts` member list → ws frames).
- Fail closed everywhere: `sync_policy` unreadable → `local`; a bound
  host unreachable → `503`, not local execution; unknown attrs →
  refusal; bind failure → the tool does not run.
- Code moves by Git (`klanker/s-<id>` worktrees); state moves by
  op-log; secrets never move.
