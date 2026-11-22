import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeQrMatrix, qrToSvgMarkup } from "./qr.ts";
import {
  extractPairTokenFromHash,
  parseSseChunk,
  parseStoreListResponse,
} from "./relayEvents.ts";

test("parseStoreListResponse handles 501 unsupported, 200 items, and HTTP errors", () => {
  const unsupported = parseStoreListResponse(501, '{"error":"agents-store not installed"}');
  assert.deepEqual(unsupported, { supported: false, items: [] });

  const ok = parseStoreListResponse(
    200,
    JSON.stringify({ ok: true, items: [{ id: "ent-1", kinds: ["task"], attrs: { title: "Ship" } }] })
  );
  assert.equal(ok.supported, true);
  assert.equal(ok.items.length, 1);
  assert.equal(ok.items[0].id, "ent-1");

  assert.throws(() => parseStoreListResponse(500, '{"error":"boom"}'), /500: boom/);
});

test("encodeQrMatrix and qrToSvgMarkup are deterministic and CSP-clean", () => {
  const url = "http://127.0.0.1:8787/#pair=single_use_tok_0123456789abcdef";
  const m1 = encodeQrMatrix(url);
  const m2 = encodeQrMatrix(url);
  assert.deepEqual(m1, m2);
  assert.ok(m1.length >= 21);
  assert.ok(m1.every((row) => row.length === m1.length));
  // 7x7 top-left finder outer border + center dot
  for (let i = 0; i < 7; i++) {
    assert.equal(m1[0][i], true);
    assert.equal(m1[6][i], true);
    assert.equal(m1[i][0], true);
    assert.equal(m1[i][6], true);
  }
  assert.equal(m1[3][3], true);

  const svg = qrToSvgMarkup(url);
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.includes("<rect ") && svg.includes("<path "));
  assert.equal(/<script/i.test(svg), false);
  assert.equal(/\bon\w+=/i.test(svg), false);
  assert.equal(/https?:\/\//i.test(svg.replace("http://www.w3.org/2000/svg", "")), false);
});

test("parseSseChunk parses typed events, skips heartbeats, and survives bad JSON", () => {
  const raw = [
    ": ping",
    "",
    "id: 1\nevent: workspace.changed\ndata: {\"id\":1,\"kind\":\"workspace.changed\",\"workspace\":\"alpha\",\"ts\":123,\"payload\":{\"action\":\"create\"}}",
    "",
    "id: 2\nevent: broken\ndata: {not json",
    "",
    "id: 3\nevent: store.changed\ndata: {\"id\":3,\"kind\":\"store.changed\",\"workspace\":\"alpha\",\"ts\":124,\"payload\":{\"entity\":\"ent-1\"}}",
  ].join("\n\n");

  const events = parseSseChunk(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "workspace.changed");
  assert.equal(events[0].workspace, "alpha");
  assert.equal(events[1].kind, "store.changed");
  assert.equal(events[1].payload.entity, "ent-1");
});

test("extractPairTokenFromHash extracts token and ignores unrelated hashes", () => {
  assert.equal(extractPairTokenFromHash("#pair=abc_123"), "abc_123");
  assert.equal(extractPairTokenFromHash("#foo=1&pair=tok%2B1"), "tok+1");
  assert.equal(extractPairTokenFromHash(""), null);
  assert.equal(extractPairTokenFromHash("#settings"), null);
});
