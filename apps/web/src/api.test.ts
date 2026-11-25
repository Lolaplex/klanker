import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./services/api.ts";
import type { KlankerInstance } from "./types/klanker.ts";

// Node host: no __TAURI__ → caps.keyring=false → every hub method takes
// the same-origin fetch path, so a fetch stub covers the whole surface.

const lsStore = new Map<string, string>();
const lsStub = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, String(v)),
  removeItem: (k: string) => void lsStore.delete(k),
  clear: () => lsStore.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: lsStub, configurable: true });

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface Call {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

function reset() {
  lsStore.clear();
  lsStore.set("klanker.instances_migrated", "1"); // skip legacy LS import path
}

test("fetchHubLinks/devices/leases GET the local relay and parse rows", async () => {
  const { calls, restore } = stubFetch(async (url) => {
    if (url === "/v1/hub/links") {
      return jsonRes({
        ok: true,
        links: [{ hub_id: "h1", hub_url: "https://hub:8787", device_id: "dev-a", label: "hub", connected_at: 1, connected: true }],
      });
    }
    if (url === "/v1/hub/devices") {
      return jsonRes({
        ok: true,
        devices: [{ id: "dev-a", label: "laptop", host_id: "host_x", role: "member", created_at: 1, last_seen: 2, has_token: true, connected: true }],
      });
    }
    if (url === "/v1/hub/leases") {
      return jsonRes({
        ok: true,
        leases: [{ ws: "w1", session: "s1", holder: "dev-a", run_id: "r1", fence: 3, expires_in: 12.5 }],
      });
    }
    return jsonRes({ error: "not found" }, 404);
  });
  try {
    const links = await api.fetchHubLinks();
    assert.equal(links.length, 1);
    assert.equal(links[0].hub_id, "h1");
    assert.equal(links[0].connected, true);

    const devices = await api.fetchHubDevices();
    assert.equal(devices[0].id, "dev-a");
    assert.equal(devices[0].host_id, "host_x");

    const leases = await api.fetchHubLeases();
    assert.equal(leases[0].holder, "dev-a");
    assert.equal(leases[0].fence, 3);

    assert.deepEqual(
      calls.map((c) => `${c.init?.method || "GET"} ${c.url}`),
      ["GET /v1/hub/links", "GET /v1/hub/devices", "GET /v1/hub/leases"]
    );
  } finally {
    restore();
  }
});

test("connectHub POSTs the invite to /v1/hub/connect", async () => {
  const { calls, restore } = stubFetch(async (url, init) => {
    assert.equal(url, "/v1/hub/connect");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.url, "https://hub:8787/#pair=tok123");
    assert.equal(body.label, "my hub");
    return jsonRes({ ok: true, hub_id: "h9", device_id: "dev-me", connected: true });
  });
  try {
    const r = await api.connectHub({ url: "https://hub:8787/#pair=tok123", label: "my hub" });
    assert.equal(r.ok, true);
    assert.equal(r.hub_id, "h9");
    assert.equal(r.connected, true);
    assert.equal(calls[0].init?.method, "POST");
  } finally {
    restore();
  }
});

test("disconnectHub and revokeHubDevice issue the right DELETEs", async () => {
  const { calls, restore } = stubFetch(async () => jsonRes({ ok: true }));
  try {
    await api.disconnectHub("hub-1");
    await api.revokeHubDevice("dev-abc");
    assert.deepEqual(
      calls.map((c) => `${c.init?.method} ${c.url}`),
      ["DELETE /v1/hub/links/hub-1", "DELETE /v1/hub/devices/dev-abc"]
    );
  } finally {
    restore();
  }
});

test("createWsInvite POSTs ws + ttl_sec and returns the pair payload", async () => {
  const { restore } = stubFetch(async (url, init) => {
    assert.equal(url, "/v1/ws/invite");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.ws, "work");
    assert.equal(body.ttl_sec, 120);
    return jsonRes({ ok: true, mode: "ws", code: "ABCD-EFGH", token: "tok", pair_url: "http://h/#pair=tok", expires_in: 120, expires_at: 999, host_id: "host_h", ws: "work" });
  });
  try {
    const inv = await api.createWsInvite("work", 120);
    assert.equal(inv.code, "ABCD-EFGH");
    assert.equal(inv.pair_url, "http://h/#pair=tok");
    assert.equal(inv.ws, "work");
  } finally {
    restore();
  }
});

test("patchWorkspacePolicy PATCHes only the policy keys", async () => {
  const { restore } = stubFetch(async (url, init) => {
    assert.equal(url, "/v1/workspaces/shared-ws");
    assert.equal(init?.method, "PATCH");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { sync_policy: "shared", sync_hosts: ["dev-a", "dev-b"], default_host: "dev-a" });
    return jsonRes({ ok: true, workspace: { id: "shared-ws", label: "Shared" } });
  });
  try {
    const row = await api.patchWorkspacePolicy("shared-ws", {
      sync_policy: "shared",
      sync_hosts: ["dev-a", "dev-b"],
      default_host: "dev-a",
    });
    assert.equal(row?.id, "shared-ws");
    assert.equal(row?.label, "Shared");
  } finally {
    restore();
  }
});

test("repo paths GET and PUT the workspace host-path map", async () => {
  const { calls, restore } = stubFetch(async (url, init) => {
    assert.equal(url, "/v1/workspaces/w1/repo-paths");
    if (init?.method === "PUT") {
      assert.deepEqual(JSON.parse(String(init.body)), {
        paths: { klanker: "C:/code/klanker" },
      });
      return jsonRes({ ok: true });
    }
    return jsonRes({ ok: true, paths: { klanker: "C:/code/klanker", ignored: 7 } });
  });
  try {
    const paths = await api.fetchRepoPaths("w1");
    assert.deepEqual(paths, { klanker: "C:/code/klanker" });
    await api.putRepoPaths("w1", { klanker: "C:/code/klanker" });
    assert.deepEqual(
      calls.map((c) => `${c.init?.method || "GET"} ${c.url}`),
      ["GET /v1/workspaces/w1/repo-paths", "PUT /v1/workspaces/w1/repo-paths"]
    );
  } finally {
    restore();
  }
});

test("fetchWorkspaceHosts returns the member/presence payload", async () => {
  const { restore } = stubFetch(async (url) => {
    assert.equal(url, "/v1/workspaces/w1/hosts");
    return jsonRes({
      ok: true,
      workspace: "w1",
      sync_policy: "shared",
      owner: "dev-a",
      default_host: "dev-a",
      hub_offline: false,
      hosts: [
        { device_id: "dev-a", label: "laptop", role: "owner", self: true, online: true, via: "channel", last_seen: 5, status: "online", leases: [] },
        { device_id: "dev-b", label: "vps", role: "member", self: false, online: false, via: "channel", last_seen: 0, status: "offline", leases: [{ session: "s1", run_id: "r1", fence: 1, expires_in: 8 }] },
      ],
    });
  });
  try {
    const r = await api.fetchWorkspaceHosts("w1");
    assert.equal(r.sync_policy, "shared");
    assert.equal(r.hub_offline, false);
    assert.equal(r.hosts.length, 2);
    assert.equal(r.hosts[0].role, "owner");
    assert.equal(r.hosts[1].leases[0].session, "s1");
  } finally {
    restore();
  }
});

test("switchSessionHost POSTs host+force and returns 409 conflicts parsed", async () => {
  let respondConflict = false;
  const { calls, restore } = stubFetch(async (url, init) => {
    assert.equal(url, "/v1/workspaces/w1/sessions/s1/host");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.host, "dev-b");
    if (respondConflict) {
      return jsonRes({ ok: false, error: "lease_held", holder: "dev-a", status: 409 }, 409);
    }
    return jsonRes({ ok: true, session: "s1", host: "dev-b", checkpoint: { pushed: true } });
  });
  try {
    const ok = await api.switchSessionHost("w1", "s1", "dev-b");
    assert.equal(ok.ok, true);
    assert.equal(ok.host, "dev-b");

    respondConflict = true;
    const conflict = await api.switchSessionHost("w1", "s1", "dev-b", true);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "lease_held");
    assert.equal(conflict.holder, "dev-a");
    assert.equal(calls.every((c) => c.init?.method === "POST"), true);
  } finally {
    restore();
  }
});

test("listKlankers keeps via=channel + device_id and never POSTs /v1/remotes", async () => {
  reset();
  const { calls, restore } = stubFetch(async (url, init) => {
    if (url === "/v1/remotes" && !init?.method) {
      return jsonRes({
        remotes: [
          { id: "dev-abc", base_url: "", label: "peer box", via: "channel", device_id: "abc", has_secret: false },
          { id: "vps", base_url: "https://vps.example:8787", label: "VPS", has_secret: true },
        ],
      });
    }
    return jsonRes({ error: "unexpected" }, 500);
  });
  try {
    const list = await api.listKlankers();
    const channel = list.find((i) => i.id === "dev-abc") as KlankerInstance;
    assert.equal(channel.via, "channel");
    assert.equal(channel.device_id, "abc");
    assert.equal(channel.name, "peer box");
    const relay = list.find((i) => i.id === "vps") as KlankerInstance;
    assert.equal(relay.via, "relay");
    assert.equal(relay.device_id, undefined);
    // No auto-migration: the poll issues only the single GET.
    assert.deepEqual(calls.map((c) => `${c.init?.method || "GET"} ${c.url}`), ["GET /v1/remotes"]);
  } finally {
    restore();
  }
});

test("deleteKlanker routes dev- ids to /v1/hub/devices, others to /v1/remotes", async () => {
  reset();
  const remotes = {
    remotes: [
      { id: "dev-abc", base_url: "", label: "peer", via: "channel", device_id: "abc", has_secret: false },
      { id: "vps", base_url: "https://vps.example", label: "VPS", has_secret: false },
    ],
  };
  const { calls, restore } = stubFetch(async (url, init) => {
    if (url === "/v1/remotes" && !init?.method) return jsonRes(remotes);
    return jsonRes({ ok: true });
  });
  try {
    await api.deleteKlanker("dev-abc");
    await api.deleteKlanker("vps");
    const deletes = calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url);
    assert.deepEqual(deletes, ["/v1/hub/devices/abc", "/v1/remotes/vps"]);
    // The channel row was never touched on /v1/remotes.
    assert.equal(calls.some((c) => c.url === "/v1/remotes/dev-abc"), false);
  } finally {
    restore();
  }
});

test("saveSettings/loadSettings round-trips hub_mode with default false", async () => {
  reset();
  await api.saveSettings({ workspace: "w", autostart: true, hub_mode: true });
  const loaded = await api.loadSettings();
  assert.equal(loaded.hub_mode, true);
  assert.equal(loaded.autostart, true);

  // A pre-hub_mode stored blob loads with the false default.
  lsStore.set("klanker.settings", JSON.stringify({ workspace: "x", autostart: false }));
  const old = await api.loadSettings();
  assert.equal(old.hub_mode, false);
});

const remoteInst = (base_url: string): KlankerInstance => ({
  id: "r",
  name: "r",
  slug: "r",
  role: "remote",
  provider: "",
  model: "",
  workspace: "",
  lock_workspace: false,
  port: 0,
  system_prompt: "",
  kind: "remote",
  endpoint: { base_url },
  created_at: "",
  updated_at: "",
});

test("pendingApproval matches the open chat's session/device, never a foreign ask", async () => {
  const inst = remoteInst("http://r");
  const { restore } = stubFetch(async (url) => {
    if (url === "http://r/v1/approvals?workspace=w1") {
      return jsonRes({
        ok: true,
        approvals: [
          { id: "a-foreign", tool: "run", summary: "other session's ask", session: "ses_other", device: "dev-b" },
          { id: "a-mine", tool: "run", summary: "mine", session: "ses_1", device: "dev-b" },
        ],
      });
    }
    return jsonRes({ error: "not found" }, 404);
  });
  try {
    // Session+device filter picks the matching row, not the first.
    const mine = await api.pendingApproval(inst, "w1", { session: "ses_1", device: "dev-b" });
    assert.equal(mine?.id, "a-mine");
    // A different session on a different device → null (never decide it here).
    assert.equal(await api.pendingApproval(inst, "w1", { session: "ses_9", device: "dev-c" }), null);
    // Session-only filter still matches.
    assert.equal((await api.pendingApproval(inst, "w1", { session: "ses_1" }))?.id, "a-mine");
    // No filters → first row (unfiltered legacy behavior).
    assert.equal((await api.pendingApproval(inst, "w1"))?.id, "a-foreign");
  } finally {
    restore();
  }
});
