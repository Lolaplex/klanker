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

const { api, localInstance, desktopLocalInstance, localRelayBaseUrl, setLocalServePort } =
  await import("./services/api.ts");
const { DEFAULT_SETTINGS } = await import("./openrouterModels.ts");

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

test("default provider is inherit, not echo", () => {
  assert.equal(DEFAULT_SETTINGS.provider, "inherit");
});

test("same-origin localInstance is kind local", () => {
  assert.equal(localInstance().kind, "local");
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
