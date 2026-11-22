import { test } from "node:test";
import assert from "node:assert/strict";

// Node --test has no DOM: stub the globals api.ts touches at call time.
(globalThis as any).window = { location: { hostname: "localhost" } };
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
(globalThis as any).document = { hidden: false, hasFocus: () => true };

const { api, localInstance, desktopLocalInstance, localRelayBaseUrl, setLocalServePort, ensureLocalServePort } =
  await import("./services/api.ts");

test("localRelayBaseUrl reflects the live serve port", () => {
  assert.equal(localRelayBaseUrl(9090), "http://127.0.0.1:9090");
  setLocalServePort(9500);
  assert.equal(localRelayBaseUrl(), "http://127.0.0.1:9500");
  setLocalServePort(0); // ignored — never blanks the port
  assert.equal(localRelayBaseUrl(), "http://127.0.0.1:9500");
  setLocalServePort(8787);
});

test("desktopLocalInstance follows the live port", () => {
  setLocalServePort(9601);
  const inst = desktopLocalInstance();
  assert.equal(inst.kind, "local");
  assert.equal(inst.endpoint?.base_url, "http://127.0.0.1:9601");
  setLocalServePort(8787);
});

test("same-origin localInstance is kind local", () => {
  assert.equal(localInstance().kind, "local");
});

// --- host_id pinning + silent repoint (foreign serve must not be adopted) ---

function withStores<T>(
  store: Record<string, string>,
  fetchImpl: (url: string, init?: unknown) => Promise<unknown>,
  fn: () => Promise<T>
): Promise<T> {
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  };
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = fetchImpl;
  return fn().finally(() => {
    (globalThis as any).fetch = origFetch;
  });
}

function healthResponders(map: Record<number, unknown>) {
  return async (url: string): Promise<unknown> => {
    const m = url.match(/127\.0\.0\.1:(\d+)/);
    const port = m ? Number(m[1]) : 0;
    const spec = map[port] as { host_id?: string } | undefined;
    if (!spec) throw new Error("conn refused");
    return { ok: true, json: async () => spec };
  };
}

test("repoints off a foreign-host serve to the pinned host", async () => {
  const store: Record<string, string> = {
    "klanker.host_id": "host_real",
    "klanker.serve_ports": "[55327]",
  };
  const fetchImpl = healthResponders({
    8787: { host_id: "host_phantom" },
    55327: { host_id: "host_real" },
  });
  await withStores(store, fetchImpl, async () => {
    setLocalServePort(8787);
    const port = await ensureLocalServePort();
    assert.equal(port, 55327);
    assert.equal(localRelayBaseUrl(), "http://127.0.0.1:55327");
    setLocalServePort(8787);
  });
});

test("returns null when no candidate serves the pinned host", async () => {
  const store: Record<string, string> = { "klanker.host_id": "host_real" };
  const fetchImpl = healthResponders({ 8787: { host_id: "host_phantom" } });
  await withStores(store, fetchImpl, async () => {
    setLocalServePort(8787);
    assert.equal(await ensureLocalServePort(), null);
    setLocalServePort(8787);
  });
});

test("keeps the port when the pinned host answers", async () => {
  const store: Record<string, string> = { "klanker.host_id": "host_real" };
  const fetchImpl = healthResponders({ 8787: { host_id: "host_real" } });
  await withStores(store, fetchImpl, async () => {
    setLocalServePort(8787);
    assert.equal(await ensureLocalServePort(), 8787);
    setLocalServePort(8787);
  });
});

const remoteInst = {
  id: "r1",
  kind: "remote",
  workspace: "C:\\some\\workdir", // a path, never a ws id — must not leak
  endpoint: { base_url: "http://h:1" },
} as any;

function captureFetch(): { urls: string[] } {
  const urls: string[] = [];
  (globalThis as any).fetch = async (u: string) => {
    urls.push(u);
    return { ok: true, text: async () => '{"approvals":[],"lines":[]}' };
  };
  return { urls };
}

test("pendingApproval appends workspace only when explicit", async () => {
  const { urls } = captureFetch();
  await api.pendingApproval(remoteInst, "ws2");
  assert.equal(urls[0], "http://h:1/v1/approvals?workspace=ws2");
  await api.pendingApproval(remoteInst);
  assert.equal(urls[1], "http://h:1/v1/approvals");
});

test("readRecentTraces scopes by workspace id, never inst.workspace", async () => {
  const { urls } = captureFetch();
  await api.readRecentTraces(remoteInst, "ws2", 7);
  assert.equal(urls[0], "http://h:1/v1/traces?limit=7&workspace=ws2");
  await api.readRecentTraces(remoteInst, "", 7);
  assert.equal(urls[1], "http://h:1/v1/traces?limit=7");
});
