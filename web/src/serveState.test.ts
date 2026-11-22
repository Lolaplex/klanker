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
