import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeFenceText, safeUrl, shouldSubmitOnEnter, visibleImageSrc } from "./chatUi.ts";

describe("shouldSubmitOnEnter", () => {
  const base = { key: "Enter", shiftKey: false, composing: false, coarsePointer: false };

  it("sends on Enter for a fine pointer", () => {
    assert.equal(shouldSubmitOnEnter(base), true);
  });

  it("inserts a newline on Enter for a coarse pointer", () => {
    assert.equal(shouldSubmitOnEnter({ ...base, coarsePointer: true }), false);
  });

  it("keeps Shift+Enter as a newline on desktop", () => {
    assert.equal(shouldSubmitOnEnter({ ...base, shiftKey: true }), false);
  });

  it("does not send while an IME composition is confirming", () => {
    assert.equal(shouldSubmitOnEnter({ ...base, composing: true }), false);
  });

  it("ignores other keys", () => {
    assert.equal(shouldSubmitOnEnter({ ...base, key: "a" }), false);
  });
});

describe("safeUrl", () => {
  it("allows http, https, mailto, and same-document relative URLs", () => {
    assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
    assert.equal(safeUrl("http://example.com"), "http://example.com");
    assert.equal(safeUrl("mailto:person@example.com"), "mailto:person@example.com");
    assert.equal(safeUrl("/docs"), "/docs");
    assert.equal(safeUrl("#part"), "#part");
    assert.equal(safeUrl("./notes"), "./notes");
  });

  it("drops scriptable and protocol-relative URLs", () => {
    assert.equal(safeUrl("javascript:alert(1)"), "");
    assert.equal(safeUrl("JavaScript:alert(1)"), "");
    assert.equal(safeUrl("data:text/html,hi"), "");
    assert.equal(safeUrl("vbscript:msg"), "");
    assert.equal(safeUrl("//evil.example/a"), "");
    assert.equal(safeUrl("  javascript:alert(1)"), "");
    assert.equal(safeUrl("https://exa\nmple.com"), "");
    assert.equal(safeUrl(""), "");
    assert.equal(safeUrl(null), "");
  });
});

describe("visibleImageSrc", () => {
  it("keeps http(s) images only", () => {
    assert.equal(visibleImageSrc("https://cdn.example/a.png"), "https://cdn.example/a.png");
    assert.equal(visibleImageSrc("http://cdn.example/a.png"), "http://cdn.example/a.png");
    assert.equal(visibleImageSrc("javascript:alert(1)"), "");
    assert.equal(visibleImageSrc("/local.png"), "");
    assert.equal(visibleImageSrc("mailto:person@example.com"), "");
  });
});

describe("codeFenceText", () => {
  it("strips one trailing newline and keeps the rest", () => {
    assert.equal(codeFenceText("const a = 1\n"), "const a = 1");
    assert.equal(codeFenceText("line\n\n"), "line\n");
    assert.equal(codeFenceText("  spaced  "), "  spaced  ");
  });
});
