import assert from "node:assert/strict";
import test from "node:test";

import { mergeBuckets, normBucket } from "./chatBuckets.ts";
import type { ChatBucket } from "./chatBuckets.ts";

// normBucket: two drafts with DIFFERENT chat ids are different unsent
// chats — folding B's composer text into A's row silently loses it.
test("normBucket keeps distinct drafts, dedupes same-id rows", () => {
  const b: ChatBucket = {
    openId: "d1",
    items: [
      { id: "d1", session: "", draft: true, messages: [], input: "alpha" },
      { id: "d1", session: "", draft: true, messages: [] },
      { id: "d2", session: "", draft: true, messages: [], input: "beta" },
      { id: "c1", session: "ses_1", messages: [] },
    ],
  };
  const n = normBucket(b);
  const drafts = n.items.filter((i) => i.draft);
  assert.equal(drafts.length, 2);
  assert.equal(drafts.find((d) => d.id === "d1")?.input, "alpha");
  assert.equal(drafts.find((d) => d.id === "d2")?.input, "beta");
  assert.equal(n.openId, "d1");
});

// mergeBuckets: the two-instance case that used to lose the loser's draft.
test("mergeBuckets preserves drafts from both buckets", () => {
  const a: ChatBucket = {
    openId: "c1",
    items: [
      { id: "c1", session: "ses_1", messages: [{ id: "m1", role: "user", content: "hi", timestamp: "t" }] },
      { id: "d1", session: "", draft: true, messages: [], input: "from-a" },
    ],
  };
  const b: ChatBucket = {
    openId: "d2",
    items: [{ id: "d2", session: "", draft: true, messages: [], input: "from-b" }],
  };
  const m = mergeBuckets(a, b);
  const inputs = m.items.filter((i) => i.draft).map((d) => d.input).sort();
  assert.deepEqual(inputs, ["from-a", "from-b"]);
  assert.equal(m.items.find((i) => i.session === "ses_1")?.messages.length, 1);
});
