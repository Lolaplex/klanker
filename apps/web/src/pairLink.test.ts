import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guessScheme, isLoopbackOrigin, normCode, parseBareCode, parsePairInput } from "./pairLink.ts";

describe("parsePairInput", () => {
  it("parses an absolute pair link", () => {
    assert.deepEqual(parsePairInput("https://relay.example:8443/#pair=tok_123"), {
      origin: "https://relay.example:8443",
      credential: "tok_123",
    });
  });

  it("parses pair= inside a busier fragment", () => {
    assert.deepEqual(parsePairInput("http://192.168.1.5:8787/#x=1&pair=abc%2Bdef"), {
      origin: "http://192.168.1.5:8787",
      credential: "abc+def",
    });
  });

  it("parses code@host and guesses http on private hosts", () => {
    assert.deepEqual(parsePairInput("ABCD-EFGH@192.168.1.5:8787"), {
      origin: "http://192.168.1.5:8787",
      credential: "ABCD-EFGH",
    });
  });

  it("parses code@host without dash and https on public hosts", () => {
    assert.deepEqual(parsePairInput("abcdefgh @ relay.example.com"), {
      origin: "https://relay.example.com",
      credential: "ABCD-EFGH",
    });
  });

  it("keeps an explicit scheme on code@host", () => {
    assert.deepEqual(parsePairInput("ABCD-EFGH@https://relay.example.com"), {
      origin: "https://relay.example.com",
      credential: "ABCD-EFGH",
    });
  });

  it("parses ws-invite fragments — both `&` and double-hash `#` separators", () => {
    // #ws=a&pair=t and #ws=a#pair=t must both yield the credential — the
    // second form shipped from the minted ws invite and used to fall
    // through to null (silent connect failure).
    assert.deepEqual(parsePairInput("https://relay.example/#ws=alpha&pair=tok_a"), {
      origin: "https://relay.example",
      credential: "tok_a",
    });
    assert.deepEqual(parsePairInput("https://relay.example/#ws=alpha#pair=tok_b"), {
      origin: "https://relay.example",
      credential: "tok_b",
    });
  });

  it("rejects junk, bare codes and urls without a pair credential", () => {
    assert.equal(parsePairInput("hello"), null);
    assert.equal(parsePairInput("ABCD-EFGH"), null);
    assert.equal(parsePairInput("https://relay.example"), null);
    assert.equal(parsePairInput("https://relay.example/#foo=1"), null);
  });
});

describe("parseBareCode / normCode", () => {
  it("accepts a bare code and normalizes to dashed form", () => {
    assert.equal(parseBareCode("abcdefgh"), "ABCD-EFGH");
    assert.equal(parseBareCode("ABCD-EFGH"), "ABCD-EFGH");
    assert.equal(parseBareCode("no code here"), null);
  });
  it("normCode keeps foreign strings untouched", () => {
    assert.equal(normCode("tok_123"), "tok_123");
  });
});

describe("guessScheme / isLoopbackOrigin", () => {
  it("http for private hosts, https for public", () => {
    assert.equal(guessScheme("localhost:8787"), "http");
    assert.equal(guessScheme("192.168.1.5"), "http");
    assert.equal(guessScheme("10.0.0.4"), "http");
    assert.equal(guessScheme("relay.example.com"), "https");
    assert.equal(guessScheme("box.tailnet.ts.net"), "http");
  });
  it("flags loopback origins", () => {
    assert.equal(isLoopbackOrigin("http://localhost:8787"), true);
    assert.equal(isLoopbackOrigin("http://127.0.0.1:8787"), true);
    assert.equal(isLoopbackOrigin("https://relay.example.com"), false);
  });
});
