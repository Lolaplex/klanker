import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPairHash, resolveInviteUrl } from "./pairLink.ts";
import {
  buildPolicyPatch,
  deviceBadge,
  deviceLeases,
  deviceWsPills,
  linkBadge,
  mergeDeviceRows,
  wsInviteView,
  type RepoEditRow,
} from "./wsShare.ts";
import { encodeQrMatrix } from "./qr.ts";
import type { HubDevice, HubLease, HubLink, WorkspaceHosts } from "./types/klanker.ts";

// --- AuthGate redeem gate (klanker#151): marked fragments must NOT
// auto-redeem — the single-use token would be burned on the wrong surface.

test("classifyPairHash: bare #pair link auto-redeems, marked links ask first", () => {
  assert.deepEqual(classifyPairHash(""), { kind: "none" });
  assert.deepEqual(classifyPairHash("#settings"), { kind: "none" });
  assert.deepEqual(classifyPairHash("#pair="), { kind: "none" });

  // Bare web-session link — the only auto-redeem case.
  assert.deepEqual(classifyPairHash("#pair=tok123"), { kind: "auto", token: "tok123" });
  assert.deepEqual(classifyPairHash("#foo=1&pair=tok123"), { kind: "auto", token: "tok123" });
  assert.deepEqual(classifyPairHash("#pair=tok123&kind=web"), { kind: "auto", token: "tok123" });

  // ws-marked — both `#ws=&pair=` and the double-hash form: confirm, never burn.
  const a = classifyPairHash("#ws=alpha&pair=tok");
  assert.equal(a.kind, "confirm");
  const b = classifyPairHash("#ws=alpha#pair=tok");
  assert.equal(b.kind, "confirm");
  if (a.kind === "confirm") {
    assert.equal(a.token, "tok");
    assert.equal(a.ws, "alpha");
    assert.equal(a.mode, "ws");
  }
  if (b.kind === "confirm") {
    assert.equal(b.token, "tok");
    assert.equal(b.ws, "alpha");
  }

  // kind=/mode= markers for device-side pairing also gate.
  for (const frag of ["#kind=ws&pair=t", "#kind=remote&pair=t", "#mode=ws&pair=t", "#pair=t&kind=remote"]) {
    const got = classifyPairHash(frag);
    assert.equal(got.kind, "confirm", frag);
  }
});

// --- invite link resolution: absolute link + loopback warning flag.

test("resolveInviteUrl resolves relative pair_url against the relay base and flags loopback", () => {
  const rel = resolveInviteUrl("/#pair=tok", "http://127.0.0.1:8787");
  assert.equal(rel.url, "http://127.0.0.1:8787/#pair=tok");
  assert.equal(rel.loopback, true);

  const lan = resolveInviteUrl("/#pair=tok", "http://192.168.1.20:8787");
  assert.equal(lan.url, "http://192.168.1.20:8787/#pair=tok");
  assert.equal(lan.loopback, false);

  const abs = resolveInviteUrl("https://hub.example/#pair=tok", "http://127.0.0.1:8787");
  assert.equal(abs.url, "https://hub.example/#pair=tok");
  assert.equal(abs.loopback, false);
});

// --- mode="ws" invite renders QR + XXXX-XXXX code.

test("wsInviteView produces a dashed code + QR-encodable link for a mode=ws invite", () => {
  const view = wsInviteView(
    { code: "ABCD-EFGH", token: "tok", pair_url: "/#pair=tok" },
    "http://127.0.0.1:8787"
  );
  assert.equal(view.code, "ABCD-EFGH");
  assert.equal(view.link, "http://127.0.0.1:8787/#pair=tok");
  assert.equal(view.loopback, true);
  assert.equal(view.qrText, view.link);
  // QR payload actually encodes (what the card renders).
  const mat = encodeQrMatrix(view.qrText);
  assert.ok(mat.length >= 21);
});

// --- Share sheet policy patch: strict, fail-closed, no host-local paths.

const repo = (slug: string, path = ""): RepoEditRow => ({
  slug,
  url: "git@h:me/r.git",
  checkout_mode: "worktree",
  path,
});

test("buildPolicyPatch emits a valid synced payload and never carries repo paths", () => {
  const res = buildPolicyPatch({
    sync_policy: "synced",
    sync_hosts: ["dev-b", "dev-a", "dev-b"],
    default_host: "dev-a",
    failover: "standby",
    repos: [repo("org/app", "C:\\local\\checkout"), repo("lib", "")],
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.patch.sync_policy, "synced");
  assert.deepEqual(res.patch.sync_hosts, ["dev-a", "dev-b"]); // dedup + sort
  assert.equal(res.patch.default_host, "dev-a");
  assert.deepEqual(res.patch.execution, { failover: "standby" });
  assert.deepEqual(res.patch.repos, [
    { slug: "org/app", url: "git@h:me/r.git", checkout_mode: "worktree" },
    { slug: "lib", url: "git@h:me/r.git", checkout_mode: "worktree" },
  ]);
  // The host-local checkout path must never reach the synced patch.
  const wire = JSON.stringify(res.patch);
  assert.equal(wire.includes("C:\\\\local"), false);
  assert.equal(wire.includes('"path"'), false);
});

test("buildPolicyPatch synced->local freezes the member set (fail-closed)", () => {
  const res = buildPolicyPatch({
    sync_policy: "local",
    sync_hosts: [],
    default_host: "",
    failover: "none",
    repos: [],
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.patch.sync_policy, "local");
  assert.deepEqual(res.patch.sync_hosts, []);
  assert.equal(res.patch.default_host, "");
});

test("buildPolicyPatch rejects invalid slugs and unknown policy/failover values", () => {
  for (const draft of [
    { sync_policy: "bogus", sync_hosts: [], default_host: "", failover: "none", repos: [] },
    { sync_policy: "synced", sync_hosts: ["bad id!"], default_host: "", failover: "none", repos: [] },
    { sync_policy: "synced", sync_hosts: [], default_host: "", failover: "auto", repos: [] },
    { sync_policy: "synced", sync_hosts: [], default_host: "", failover: "none", repos: [repo("bad/../slug")] },
    { sync_policy: "synced", sync_hosts: [], default_host: "", failover: "none", repos: [repo("x"), repo("x")] },
  ]) {
    assert.equal(buildPolicyPatch(draft).ok, false, JSON.stringify(draft));
  }
  // Blank repo rows are dropped, not sent malformed.
  const res = buildPolicyPatch({
    sync_policy: "local",
    sync_hosts: [],
    default_host: "",
    failover: "none",
    repos: [{ slug: "", url: "", checkout_mode: "worktree", path: "" }],
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.patch.repos, []);
});

// --- member checklist merge: online/offline badges + roles.

test("mergeDeviceRows marks ws members, self and owner; unpaired members stay listed", () => {
  const wsHosts: WorkspaceHosts = {
    workspace: "w1",
    sync_policy: "synced",
    owner: "dev-a",
    default_host: "dev-a",
    hub_offline: false,
    hosts: [
      { device_id: "dev-a", label: "laptop", role: "owner", self: true, online: true, via: "channel", last_seen: 1, status: "online", leases: [] },
      { device_id: "dev-gone", label: "gone", role: "member", self: false, online: false, via: "channel", last_seen: 0, status: "offline", leases: [] },
    ],
  };
  const devices: HubDevice[] = [
    { id: "dev-a", label: "laptop", host_id: "h1", role: "host", created_at: 1, last_seen: 2, has_token: true, connected: true },
    { id: "dev-new", label: "new phone", host_id: "h2", role: "ws_member", created_at: 1, last_seen: 0, has_token: true, connected: false },
  ];
  const rows = mergeDeviceRows(wsHosts, devices);
  const byId = new Map(rows.map((r) => [r.device_id, r]));
  assert.equal(byId.get("dev-a")?.member, true);
  assert.equal(byId.get("dev-a")?.self, true);
  assert.equal(byId.get("dev-a")?.role, "owner");
  assert.equal(byId.get("dev-a")?.online, true);
  // A member missing from /v1/hub/devices still shows (offline).
  assert.equal(byId.get("dev-gone")?.member, true);
  assert.equal(byId.get("dev-gone")?.online, false);
  // A paired non-member appears unchecked.
  assert.equal(byId.get("dev-new")?.member, false);
  assert.equal(byId.get("dev-new")?.role, "ws_member");
});

// --- devices panel badges / ws pills / lease rows.

test("link/device badges and shared-workspace pills derive from hub payloads", () => {
  const link = (connected: boolean): HubLink => ({
    hub_id: "h1",
    hub_url: "https://hub:8787",
    device_id: "dev-me",
    label: "hub",
    connected_at: 1,
    connected,
  });
  assert.equal(linkBadge(link(true)), "connected");
  assert.equal(linkBadge(link(false)), "disconnected");

  const dev: HubDevice = {
    id: "dev-1",
    label: "phone",
    host_id: "h9",
    role: "ws_member",
    created_at: 1,
    last_seen: 2,
    has_token: true,
    connected: true,
    workspaces: ["alpha"],
  };
  assert.equal(deviceBadge(dev), "online");
  assert.equal(deviceBadge({ ...dev, connected: false }), "offline");

  const leases: HubLease[] = [
    { ws: "alpha", session: "s1", holder: "dev-1", run_id: "r1", fence: 1, expires_in: 30 },
    { ws: "beta", session: "s2", holder: "dev-2", run_id: "r2", fence: 1, expires_in: 30 },
  ];
  assert.deepEqual(deviceWsPills(dev, leases), ["alpha"]);
  assert.deepEqual(deviceWsPills({ ...dev, workspaces: undefined, allowlist: ["shared"] }, leases), ["alpha", "shared"]);
  assert.equal(deviceLeases(dev, leases).length, 1);
  assert.equal(deviceLeases(dev, leases)[0].session, "s1");
});
