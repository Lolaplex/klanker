import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDeltaQueue, diffChatBuckets } from "./chatPersist.ts";

describe("createDeltaQueue", () => {
  it("merges every pushed piece into one scheduled flush per frame", () => {
    const cbs: (() => void)[] = [];
    const flushed: string[] = [];
    const q = createDeltaQueue((t) => flushed.push(t), (cb) => cbs.push(cb));

    q.push("a");
    q.push("b");
    q.push("c");
    assert.equal(cbs.length, 1);
    assert.deepEqual(flushed, []);

    cbs.shift()!();
    assert.deepEqual(flushed, ["abc"]);

    q.push("d");
    assert.equal(cbs.length, 1);
    cbs.shift()!();
    assert.deepEqual(flushed, ["abc", "d"]);
  });

  it("drains synchronously on flush and is a no-op when empty", () => {
    const cbs: (() => void)[] = [];
    const flushed: string[] = [];
    const q = createDeltaQueue((t) => flushed.push(t), (cb) => cbs.push(cb));

    q.flush();
    assert.deepEqual(flushed, []);

    q.push("x");
    q.push("y");
    q.flush();
    assert.deepEqual(flushed, ["xy"]);
    // The already-scheduled frame callback must not re-flush stale text.
    cbs.shift()!();
    assert.deepEqual(flushed, ["xy"]);
  });
});

describe("diffChatBuckets", () => {
  it("reports identity-changed keys and removed keys only", () => {
    const a = { items: [1] };
    const b = { items: [2] };
    const saved = { k1: a, k2: b };
    const next = { k1: a, k2: { items: [2] }, k3: b };
    assert.deepEqual(diffChatBuckets(saved, next), { write: ["k2", "k3"], remove: [] });
    assert.deepEqual(diffChatBuckets(next, saved), { write: ["k2"], remove: ["k3"] });
  });
});
