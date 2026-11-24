import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPresence,
  bindingText,
  checkpointBranch,
  classifySwitch,
  confirmMessage,
  hostBinding,
  hostEventEffect,
  hostLabelFor,
  hostPickerRows,
  leaseHolderFor,
  presenceDelta,
  providerScope,
  remoteMountId,
  runHostSwitch,
} from "./hostPicker.ts";
import { api } from "./services/api.ts";
import type { RelayEvent, SessionHostSwitch, WorkspaceHosts } from "./types/klanker.ts";

// Node host: no __TAURI__ → caps.keyring=false → hub/remote calls take the
// same-origin fetch path, so a fetch stub covers listRemoteProviders.
const lsStore = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
    removeItem: (k: string) => void lsStore.delete(k),
    clear: () => lsStore.clear(),
  },
  configurable: true,
});

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

const wsHosts = (over: Partial<WorkspaceHosts> = {}): WorkspaceHosts => ({
  workspace: "w1",
  sync_policy: "synced",
  owner: "dev-a",
  default_host: "dev-a",
  hub_offline: false,
  hosts: [
    { device_id: "dev-a", label: "laptop", role: "owner", self: true, online: true, via: "channel", last_seen: 1, status: "online", leases: [] },
    { device_id: "dev-b", label: "vps", role: "member", self: false, online: true, via: "channel", last_seen: 2, status: "online", leases: [] },
    { device_id: "dev-c", label: "phone", role: "member", self: false, online: false, via: "channel", last_seen: 0, status: "offline", leases: [] },
  ],
  ...over,
});

// --- picker rows: strictly the ws members the relay returned -------------

test("hostPickerRows lists only members+self from the hosts payload", () => {
  const rows = hostPickerRows(wsHosts());
  assert.deepEqual(
    rows.map((r) => r.deviceId).sort(),
    ["dev-a", "dev-b", "dev-c"]
  );
  // Self floats first, offline members last.
  assert.equal(rows[0].deviceId, "dev-a");
  assert.equal(rows[0].self, true);
  assert.equal(rows[rows.length - 1].online, false);
  // No payload => no rows (old relay hides the chip).
  assert.deepEqual(hostPickerRows(undefined), []);
  // A device that is NOT in sync_hosts never appears.
  const extra = wsHosts();
  const rows2 = hostPickerRows(extra);
  assert.equal(rows2.some((r) => r.deviceId === "dev-stranger"), false);
});

// --- binding states + lock ------------------------------------------------

test("hostBinding: unbound shows the ws default, bound shows host+online, locked wins", () => {
  const h = wsHosts();
  const unbound = hostBinding({ sessionHost: "", session: "s1", hosts: h });
  assert.equal(unbound.kind, "unbound");
  assert.equal(unbound.host, "dev-a");
  assert.equal(bindingText(unbound), "unbound (default: laptop)");

  const bound = hostBinding({ sessionHost: "dev-b", session: "s1", hosts: h });
  assert.equal(bound.kind, "bound");
  assert.equal(bound.label, "vps");
  assert.equal(bound.online, true);
  assert.equal(bindingText(bound), "bound: vps");

  const boundOffline = hostBinding({ sessionHost: "dev-c", session: "s1", hosts: h });
  assert.equal(boundOffline.kind, "bound");
  assert.equal(boundOffline.online, false);

  // A live turn locks the picker (Running).
  const running = hostBinding({ sessionHost: "dev-b", session: "s1", hosts: h, running: true });
  assert.equal(running.kind, "locked");
  assert.equal(bindingText(running), "running (locked): vps");

  // A server-side lease on the session locks it even without a local run.
  const withLease = wsHosts();
  withLease.hosts[1].leases = [{ session: "s9", run_id: "r1", fence: 1, expires_in: 30 }];
  const leased = hostBinding({ sessionHost: "", session: "s9", hosts: withLease });
  assert.equal(leased.kind, "locked");
  assert.equal(leaseHolderFor("s9", withLease), "dev-b");
  // Other sessions are unaffected by that lease.
  const free = hostBinding({ sessionHost: "", session: "s1", hosts: withLease });
  assert.equal(free.kind, "unbound");
});

// --- switch: POST once, confirm only on confirmable conflicts -------------

const okRes = (over: Partial<SessionHostSwitch> = {}): SessionHostSwitch => ({
  ok: true,
  session: "s1",
  host: "dev-b",
  ...over,
});

test("runHostSwitch POSTs sessions/<sid>/host once and binds without force", async () => {
  const calls: { ws: string; session: string; host: string; force: boolean }[] = [];
  const out = await runHostSwitch({
    ws: "w1",
    session: "ses_abc123",
    host: "dev-b",
    post: async (ws, session, host, force) => {
      calls.push({ ws, session, host, force });
      return okRes();
    },
    confirm: () => { throw new Error("confirm must not fire on a clean switch"); },
  });
  assert.deepEqual(calls, [{ ws: "w1", session: "ses_abc123", host: "dev-b", force: false }]);
  assert.equal(out.switched, true);
  assert.equal(out.forced, false);
  assert.equal(out.note, "bound: dev-b · klanker/s-ses_abc123");
});

test("runHostSwitch: 409 wip_unpushed prompts confirm, retries with force:true", async () => {
  const calls: { host: string; force: boolean }[] = [];
  const confirmed: string[] = [];
  const out = await runHostSwitch({
    ws: "w1",
    session: "s1",
    host: "dev-b",
    hostLabel: "vps",
    post: async (_ws, _s, host, force) => {
      calls.push({ host, force });
      if (!force) return { ok: false, error: "wip_unpushed", status: 409 };
      return okRes({ host });
    },
    confirm: async (msg) => { confirmed.push(msg); return true; },
  });
  assert.deepEqual(calls, [
    { host: "dev-b", force: false },
    { host: "dev-b", force: true },
  ]);
  assert.equal(confirmed.length, 1);
  assert.match(confirmed[0], /unpushed wip/i);
  assert.match(confirmed[0], /switch/i);
  assert.match(confirmed[0], /anyway/i);
  assert.equal(out.switched, true);
  assert.equal(out.forced, true);
  assert.equal(out.note, "bound: vps · klanker/s-s1");
});

test("runHostSwitch: declined confirm never retries with force", async () => {
  const calls: { force: boolean }[] = [];
  const out = await runHostSwitch({
    ws: "w1",
    session: "s1",
    host: "dev-b",
    post: async (_w, _s, _h, force) => {
      calls.push({ force });
      return { ok: false, error: "wip_unpushed", status: 409 };
    },
    confirm: async () => false,
  });
  assert.deepEqual(calls, [{ force: false }]);
  assert.equal(out.switched, false);
  assert.equal(out.cancelled, true);
});

test("runHostSwitch: lease_held refuses without a confirm", async () => {
  let confirmFired = false;
  const out = await runHostSwitch({
    ws: "w1",
    session: "s1",
    host: "dev-b",
    post: async () => ({ ok: false, error: "lease_held", holder: "dev-a", status: 409 }),
    confirm: () => { confirmFired = true; return true; },
  });
  assert.equal(confirmFired, false);
  assert.equal(out.switched, false);
  assert.equal(out.refused?.reason, "lease_held");
  assert.match(out.note, /lease held by dev-a/);
});

test("classifySwitch: host_offline under failover none is confirmable, standby refuses", () => {
  assert.deepEqual(
    classifySwitch({ ok: false, error: "host_offline", status: 503, failover: "none" } as SessionHostSwitch),
    { kind: "confirm", reason: "host_offline", holder: undefined }
  );
  assert.equal(
    classifySwitch({ ok: false, error: "host_offline", status: 503, failover: "standby" } as SessionHostSwitch).kind,
    "refused"
  );
  assert.equal(classifySwitch(okRes()).kind, "switched");
  assert.equal(classifySwitch(okRes({ unchanged: true })).unchanged, true);
  assert.equal(classifySwitch(null).kind, "refused");
});

test("confirmMessage + checkpointBranch carry the contract phrases", () => {
  assert.equal(checkpointBranch("ses_abc123"), "klanker/s-ses_abc123");
  const wip = confirmMessage("wip_unpushed", "s1", "vps");
  assert.match(wip, /unpushed wip/i);
  assert.match(wip, /switch.*anyway/i);
  assert.match(wip, /klanker\/s-s1/);
  const off = confirmMessage("host_offline", "s1", "vps");
  assert.match(off, /host offline/i);
  assert.match(off, /switch.*anyway/i);
});

// --- provider scope: never mix host A's providers into host B's chat ------

test("providerScope: self/unbound reads local, remote member reads its mount", () => {
  const h = wsHosts();
  assert.deepEqual(providerScope("", h), { kind: "local" });
  assert.deepEqual(providerScope("dev-a", h), { kind: "local" }); // self
  const remote = providerScope("dev-b", h);
  assert.equal(remote.kind, "remote");
  if (remote.kind === "remote") {
    assert.equal(remote.mountId, "dev-b");
    assert.equal(remote.online, true);
  }
  const offline = providerScope("dev-c", h);
  assert.equal(offline.kind, "remote");
  if (offline.kind === "remote") assert.equal(offline.online, false);
  // A bound host unknown to the payload still scopes remote (fail-closed).
  assert.equal(providerScope("dev-x", h).kind, "remote");
});

test("remoteMountId normalizes bare device ids and keeps dev- ids", () => {
  assert.equal(remoteMountId("abc123"), "dev-abc123");
  assert.equal(remoteMountId("dev-abc"), "dev-abc");
  assert.equal(remoteMountId("  x "), "dev-x");
});

test("listRemoteProviders GETs /v1/remote/dev-<id>/v1/providers and caches stale", async () => {
  const { calls, restore } = stubFetch(async (url) => {
    if (url === "/v1/remote/dev-b/v1/providers") {
      return jsonRes({ providers: [{ name: "acp.devin", kind: "acp-agent" }, { name: "lmstudio.local", models: ["qwen3"] }] });
    }
    return jsonRes({ error: "not found" }, 404);
  });
  try {
    const r = await api.listRemoteProviders("b");
    assert.deepEqual(calls.map((c) => `${c.init?.method || "GET"} ${c.url}`), ["GET /v1/remote/dev-b/v1/providers"]);
    assert.equal(r.stale, false);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].name, "acp.devin");
  } finally {
    restore();
  }
  // Offline: the cached manifest comes back marked stale.
  const { restore: restore2 } = stubFetch(async () => { throw new Error("offline"); });
  try {
    const r2 = await api.listRemoteProviders("b");
    assert.equal(r2.stale, true);
    assert.equal(r2.rows.length, 2);
    const never = await api.listRemoteProviders("never-seen");
    assert.deepEqual(never, { rows: [], stale: false });
  } finally {
    restore2();
  }
});

// --- SSE: presence badges + scoped refreshes ------------------------------

const ev = (kind: string, payload: Record<string, unknown>, workspace = ""): RelayEvent => ({
  id: 1,
  kind,
  workspace,
  ts: 1,
  payload,
});

test("device.connected/disconnected flips the member's online badge", () => {
  const on = presenceDelta(ev("device.connected", { device_id: "dev-c" }));
  assert.deepEqual(on, { deviceId: "dev-c", online: true });
  const off = presenceDelta(ev("device.disconnected", { device_id: "dev-c" }));
  assert.deepEqual(off, { deviceId: "dev-c", online: false });

  const h = wsHosts();
  assert.equal(h.hosts[2].online, false);
  const updated = applyPresence(h, "dev-c", true);
  assert.equal(updated.hosts[2].online, true);
  assert.equal(updated.hub_offline, false);
  // Last device dropping marks the hub offline.
  const downed = applyPresence(
    applyPresence(h, "dev-a", false),
    "dev-b", false
  );
  assert.equal(downed.hub_offline, true);
  // Untouched rows keep their identity (memo-friendly state update).
  const flipped = applyPresence(updated, "dev-a", false);
  assert.equal(flipped.hosts[2], updated.hosts[2]);
});

test("hostEventEffect scopes refresh to the event's workspace", () => {
  const conn = hostEventEffect(ev("device.connected", { device_id: "dev-b" }));
  assert.deepEqual(conn?.presence, { deviceId: "dev-b", online: true });
  assert.deepEqual(conn?.refreshHosts, []);

  const lease = hostEventEffect(ev("lease.changed", { action: "acquire", ws: "w1", session: "s1", holder: "dev-b" }, "w1"));
  assert.deepEqual(lease?.refreshHosts, ["w1"]);

  const ann = hostEventEffect(ev("ws.announced", { device_id: "dev-b", ws: "shared" }, "shared"));
  assert.deepEqual(ann?.refreshHosts, ["shared"]);
  const rev = hostEventEffect(ev("ws.revoked", { device_id: "dev-b", ws: "shared" }, "shared"));
  assert.deepEqual(rev?.refreshHosts, ["shared"]);

  const bound = hostEventEffect(ev("session.bound", { session: "s1", host: "dev-b" }, "w1"));
  assert.deepEqual(bound?.sessionBound, { ws: "w1", session: "s1", host: "dev-b" });
  assert.deepEqual(bound?.refreshHosts, ["w1"]);

  const devChange = hostEventEffect(ev("device.changed", { action: "revoke", id: "dev-c" }));
  assert.equal(devChange?.refreshAll, true);

  // workspace.changed (policy/default_host writes) must refresh hosts.
  const wc = hostEventEffect(ev("workspace.changed", { ws: "w1" }, "w1"));
  assert.deepEqual(wc?.refreshHosts, ["w1"]);

  // Kinds this surface ignores return null.
  assert.equal(hostEventEffect(ev("approval.changed", { action: "pending", id: "a1" }, "w1")), null);
  assert.equal(hostEventEffect(ev("store.changed", {})), null);
});

test("classifySwitch surfaces checkpoint.unpushed on a successful switch", () => {
  const ok = classifySwitch({ ok: true, session: "s1", host: "dev-b", checkpoint: { unpushed: true } });
  assert.equal(ok.kind, "switched");
  if (ok.kind === "switched") assert.equal(ok.unpushed, true);
  const clean = classifySwitch({ ok: true, session: "s1", host: "dev-b" });
  assert.equal(clean.kind, "switched");
  if (clean.kind === "switched") assert.equal(clean.unpushed, false);
});

test("hostLabelFor resolves member labels and falls back to the id", () => {
  const h = wsHosts();
  assert.equal(hostLabelFor(h, "dev-b"), "vps");
  assert.equal(hostLabelFor(h, "dev-x"), "dev-x");
});
