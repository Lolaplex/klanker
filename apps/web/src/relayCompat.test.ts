import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_RELAY, cmpVersion, compatOf } from "./relayCompat.ts";

test("cmpVersion orders dotted versions numerically", () => {
  assert.equal(cmpVersion("0.1.1", "0.1.1"), 0);
  assert.equal(cmpVersion("0.1.10", "0.1.9"), 1);
  assert.equal(cmpVersion("0.1", "0.1.0"), 0);
  assert.equal(cmpVersion("1.0.0", "0.9.9"), 1);
  assert.equal(cmpVersion("0.2.0", "0.2.1"), -1);
});

test("stale local maps to upgrade path", () => {
  const c = compatOf("0.0.1", true);
  assert.equal(c?.kind, "stale-local");
});

test("stale remote maps to warning", () => {
  const c = compatOf("0.0.1", false);
  assert.equal(c?.kind, "stale-remote");
});

test("current version is clean", () => {
  assert.equal(compatOf(MIN_RELAY, true), null);
  assert.equal(compatOf("9.9.9", false), null);
});

test("missing version is unknown, not a blocker", () => {
  assert.equal(compatOf(null, true)?.kind, "unknown");
  assert.equal(compatOf(undefined, false)?.kind, "unknown");
});
