import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kbDebugEnabled } from "./kbDebug.ts";

describe("kbDebugEnabled", () => {
  it("is on only for the exact ?kbdebug=1 opt-in", () => {
    assert.equal(kbDebugEnabled("?kbdebug=1"), true);
    assert.equal(kbDebugEnabled("?a=1&kbdebug=1&b=2"), true);
    assert.equal(kbDebugEnabled(""), false);
    assert.equal(kbDebugEnabled("?kbdebug=0"), false);
    assert.equal(kbDebugEnabled("?kbdebug=true"), false);
    assert.equal(kbDebugEnabled("?KBDebug=1"), false);
  });
});
