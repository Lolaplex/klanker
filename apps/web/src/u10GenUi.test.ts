import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { MarkdownMessage } from "./components/MarkdownMessage.tsx";
import { dispatchOpenUiAction } from "./components/genui/actionDispatcher.ts";
import { safeHttpUrl, unsafeOpenUiReason } from "./components/genui/safety.ts";

async function renderInDom(el: React.ReactElement): Promise<{ html: () => string; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(el);
  });
  return {
    html: () => document.body.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("U10 GenUI safety gates", () => {
  it("accepts only absolute http/https action URLs", () => {
    assert.equal(safeHttpUrl("https://example.com/x"), "https://example.com/x");
    assert.equal(safeHttpUrl("http://example.com"), "http://example.com/");
    assert.equal(safeHttpUrl("javascript:alert(1)"), null);
    assert.equal(safeHttpUrl("java\tscript:alert(1)"), null);
    assert.equal(safeHttpUrl("data:text/html,evil"), null);
    assert.equal(safeHttpUrl("ftp://example.com/x"), null);
    assert.equal(safeHttpUrl("/relative"), null);
  });

  it("refuses executable schemes and active embeds in OpenUI source", () => {
    assert.ok(unsafeOpenUiReason('root = Card([TextContent("x javascript:alert(1)")])'));
    assert.ok(unsafeOpenUiReason('root = Card([TextContent("<script>alert(1)</script>")])'));
    assert.equal(unsafeOpenUiReason('root = Card([TextContent("safe")])'), null);
  });
});

describe("U10 two-way action dispatcher", () => {
  it("continue_conversation submits a structured form prompt with session/workspace payload", () => {
    const sent: string[] = [];
    const result = dispatchOpenUiAction(
      {
        type: "continue_conversation",
        humanFriendlyMessage: "Save preferences",
        formName: "prefs",
        formState: { theme: "dark", notifications: true },
        params: {},
      },
      { session: "ses_1", workspace: "ws", persona: "coder", sendPrompt: (t) => sent.push(t) }
    );
    assert.equal(result.kind, "prompt");
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes("Save preferences"));
    assert.ok(sent[0].includes("theme: dark"));
    assert.ok(sent[0].includes("notifications: true"));
    if (result.kind === "prompt") {
      assert.equal(result.payload.session, "ses_1");
      assert.equal(result.payload.workspace, "ws");
    }
  });

  it("open_url executes only safe http(s) and unknown/custom actions never execute", () => {
    const opened: string[] = [];
    const ok = dispatchOpenUiAction(
      { type: "open_url", params: { url: "https://example.com" } },
      { sendPrompt: () => {}, openUrl: (u) => opened.push(u) }
    );
    assert.deepEqual(ok, { kind: "url", url: "https://example.com/" });
    assert.deepEqual(opened, ["https://example.com/"]);
    const bad = dispatchOpenUiAction(
      { type: "open_url", params: { url: "javascript:alert(1)" } },
      { sendPrompt: () => {}, openUrl: (u) => opened.push(u) }
    );
    assert.equal(bad.kind, "rejected");
    assert.equal(opened.length, 1);
    const arbitrary = dispatchOpenUiAction(
      { type: "eval", params: { code: "alert(1)" } },
      { sendPrompt: () => {} }
    );
    assert.equal(arbitrary.kind, "rejected");
  });

  it("open_detail emits klanker:open-detail instead of editing App.tsx", () => {
    const seen: unknown[] = [];
    const listener = (ev: Event) => seen.push((ev as CustomEvent).detail);
    window.addEventListener("klanker:open-detail", listener);
    try {
      const result = dispatchOpenUiAction(
        { type: "open_detail", params: { path: "src/app.ts" } },
        { session: "ses_9", workspace: "ws", sendPrompt: () => {} }
      );
      assert.equal(result.kind, "detail");
      assert.equal((seen[0] as { session?: string }).session, "ses_9");
      assert.equal((seen[0] as { params?: { path?: string } }).params?.path, "src/app.ts");
    } finally {
      window.removeEventListener("klanker:open-detail", listener);
    }
  });
});

describe("U10 markdown lazy OpenUI island", () => {
  it("MarkdownMessage lazy-loads ./genui/OpenUiBlock and keeps react-lang out of the static module", () => {
    const src = readFileSync("src/components/MarkdownMessage.tsx", "utf-8");
    assert.ok(src.includes('React.lazy(() => import("./genui/OpenUiBlock"))'));
    assert.ok(!src.includes('@openuidev/react-lang"'));
    assert.ok(!src.includes("@openuidev/react-lang';"));
  });

  it("renders a simple valid OpenUI card inline", async () => {
    const source = 'Before\n\n```openui\nroot = Card([txt])\ntxt = TextContent("Hello GenUI")\n```\n\nAfter';
    const r = await renderInDom(
      React.createElement(MarkdownMessage, {
        text: source,
        genui: { streaming: false, actionContext: { sendPrompt: () => {} } },
      })
    );
    try {
      await act(async () => {
        await new Promise((res) => setTimeout(res, 250));
      });
      assert.ok(r.html().includes("Hello GenUI"), r.html());
      assert.ok(r.html().includes("Before"));
      assert.ok(r.html().includes("After"));
    } finally {
      r.unmount();
    }
  });

  it("unsafe OpenUI falls back to raw code instead of rendering actions", async () => {
    const source = '```openui\nroot = Card([txt])\ntxt = TextContent("javascript:alert(1)")\n```';
    const r = await renderInDom(
      React.createElement(MarkdownMessage, {
        text: source,
        genui: { streaming: false, actionContext: { sendPrompt: () => {} } },
      })
    );
    try {
      await act(async () => {
        await new Promise((res) => setTimeout(res, 100));
      });
      assert.ok(r.html().includes("raw fallback") || r.html().includes("unsafe URL scheme"), r.html());
    } finally {
      r.unmount();
    }
  });
});
