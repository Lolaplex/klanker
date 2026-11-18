import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  codeFenceText,
  focusWithoutScroll,
  safeUrl,
  shouldSubmitOnEnter,
  visibleImageSrc,
} from "./chatUi.ts";

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

describe("focusWithoutScroll", () => {
  it("lifts off-screen on mobile before focus(preventScroll) and restores after two frames", () => {
    const origWindow = globalThis.window;
    const origRaf = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    (globalThis as Record<string, unknown>).window = { innerWidth: 390 };
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    };
    try {
      const calls: Array<{ transform: string; preventScroll?: boolean }> = [];
      const el = {
        style: { transform: "scale(1)", transition: "opacity 1s" },
        focus(opts?: FocusOptions) {
          calls.push({ transform: this.style.transform, preventScroll: opts?.preventScroll });
        },
      } as unknown as HTMLElement;

      focusWithoutScroll(el);
      assert.deepEqual(calls, [{ transform: "translateY(-99999px)", preventScroll: true }]);
      assert.equal(el.style.transform, "translateY(-99999px)");
      assert.equal(frames.length, 1);

      frames.shift()!(16);
      assert.equal(el.style.transform, "translateY(-99999px)");
      assert.equal(frames.length, 1);

      frames.shift()!(32);
      assert.equal(el.style.transform, "scale(1)");
      assert.equal(el.style.transition, "opacity 1s");
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      (globalThis as Record<string, unknown>).requestAnimationFrame = origRaf;
    }
  });

  it("focuses directly with preventScroll on desktop widths", () => {
    const origWindow = globalThis.window;
    (globalThis as Record<string, unknown>).window = {
      innerWidth: 1280,
      matchMedia: () => ({ matches: false }),
    };
    try {
      let optsSeen: FocusOptions | undefined;
      const el = {
        style: { transform: "", transition: "" },
        focus(opts?: FocusOptions) {
          optsSeen = opts;
        },
      } as unknown as HTMLElement;

      focusWithoutScroll(el);
      assert.equal(el.style.transform, "");
      assert.deepEqual(optsSeen, { preventScroll: true });
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
    }
  });

  it("lifts off-screen on wide coarse-pointer screens (landscape iPhone)", () => {
    const origWindow = globalThis.window;
    const origRaf = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    (globalThis as Record<string, unknown>).window = {
      innerWidth: 844,
      matchMedia: () => ({ matches: true }),
    };
    (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    };
    try {
      const el = {
        style: { transform: "", transition: "" },
        focus() {},
      } as unknown as HTMLElement;

      focusWithoutScroll(el);
      assert.equal(el.style.transform, "translateY(-99999px)");
      frames.shift()!(16);
      frames.shift()!(32);
      assert.equal(el.style.transform, "");
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      (globalThis as Record<string, unknown>).requestAnimationFrame = origRaf;
    }
  });
});
