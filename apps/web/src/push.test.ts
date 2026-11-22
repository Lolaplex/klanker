import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vapidToKey } from "./push.ts";

describe("vapidToKey", () => {
  // RFC 8292 style uncompressed P-256 public key (65 bytes, 0x04 prefix).
  it("decodes a padded-looking base64url key to 65 raw bytes", () => {
    const raw = new Uint8Array(65);
    raw[0] = 4;
    for (let i = 1; i < 65; i++) raw[i] = i % 256;
    const b64url = Buffer.from(raw).toString("base64url");
    assert.deepEqual([...vapidToKey(b64url)], [...raw]);
  });

  it("handles url-safe -/_ characters and missing padding", () => {
    // 0xfb/0xff bytes force '-' and '_' in base64url.
    const raw = new Uint8Array([251, 255, 254]);
    const b64url = Buffer.from(raw).toString("base64url");
    assert.ok(b64url.includes("-") || b64url.includes("_") || b64url.length > 0);
    assert.deepEqual([...vapidToKey(b64url)], [...raw]);
  });
});
