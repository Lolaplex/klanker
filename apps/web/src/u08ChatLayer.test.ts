import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { splitThinking } from "./thinkingParse.ts";
import { ThinkingAccordion } from "./components/ThinkingAccordion.tsx";
import { MarkdownMessage } from "./components/MarkdownMessage.tsx";
import { ChatConsole } from "./components/ChatConsole.tsx";
import type { KlankerInstance } from "./types/klanker.ts";

// U08 oracle (klanker#163): think extraction, thinking accordion,
// regenerate control, mermaid lazy shell, math/prism pipeline.

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

describe("splitThinking extraction", () => {
  it("extracts a closed think block and keeps the answer body", () => {
    const r = splitThinking("<think>chain of thought</think>The answer.");
    assert.equal(r.thinking, "chain of thought");
    assert.equal(r.body, "The answer.");
    assert.equal(r.thinkingOpen, false);
  });

  it("treats an unclosed trailing think as streaming-open", () => {
    const r = splitThinking("<think>still reasoning");
    assert.equal(r.thinking, "still reasoning");
    assert.equal(r.body, "");
    assert.equal(r.thinkingOpen, true);
  });

  it("passes plain text through untouched", () => {
    const r = splitThinking("just an answer");
    assert.equal(r.thinking, null);
    assert.equal(r.body, "just an answer");
  });

  it("handles multiple think blocks", () => {
    const r = splitThinking("<think>a</think>mid<think>b</think>end");
    assert.equal(r.thinking, "a\nb");
    assert.equal(r.body, "mid\nend".replace("\n", ""), "body concatenates non-think parts");
  });

  it("strips empty think blocks to null", () => {
    const r = splitThinking("<think>   </think>answer");
    assert.equal(r.thinking, null);
    assert.equal(r.body, "answer");
  });
});

describe("ThinkingAccordion", () => {
  it("renders collapsed by default with elapsed time and toggles open", async () => {
    const r = await renderInDom(React.createElement(ThinkingAccordion, { thinking: "deep thought", streaming: false }));
    try {
      const html = r.html();
      assert.ok(html.includes("thinking"), "header missing");
      assert.ok(!html.includes("deep thought"), "collapsed panel must hide content");
      const btn = document.querySelector('button[aria-label="Toggle thinking"]') as HTMLButtonElement;
      assert.ok(btn, "toggle button missing");
      await act(async () => {
        btn.click();
      });
      assert.ok(r.html().includes("deep thought"), "open panel must show content");
    } finally {
      r.unmount();
    }
  });
});

describe("MarkdownMessage rich pipeline", () => {
  it("renders mermaid fences as a lazy diagram shell, never raw svg/html", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownMessage, { text: "```mermaid\ngraph TD\n  A-->B\n```" })
    );
    assert.ok(html.includes("mermaid"), "mermaid badge missing");
    assert.ok(!html.includes("A--&gt;B") || html.includes("rendering diagram"), "diagram source must not render as text");
    assert.equal(/<script\b/i.test(html), false);
  });

  it("keeps language badge and copy control on plain code fences", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownMessage, { text: "```python\nprint(1)\n```" })
    );
    assert.ok(html.includes("python"), "language badge missing");
    assert.ok(html.includes("Copy code"), "copy control missing");
  });

  it("renders math through katex", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownMessage, { text: "energy $E=mc^2$" })
    );
    assert.ok(html.includes("katex"), "katex output missing");
  });
});

describe("ChatConsole regenerate + composer", () => {
  const inst = {
    id: "local",
    kind: "local",
    name: "klanker",
    workspace: "",
    endpoint: { base_url: "http://127.0.0.1:8787" },
  } as unknown as KlankerInstance;

  const baseProps = {
    instance: inst,
    title: "alpha · default",
    speakerName: "nova",
    input: "",
    onInput: () => {},
    onSendMessage: () => {},
    onStop: () => {},
    isLoading: false,
    sendHold: false,
    pending: null,
    deciding: false,
    decideError: null,
    onDecide: () => {},
  };

  const msgs = [
    { id: "u1", role: "user", content: "first question", timestamp: 1 },
    { id: "a1", role: "klanker", content: "first answer", timestamp: 2 },
    { id: "u2", role: "user", content: "second question", timestamp: 3 },
    { id: "a2", role: "klanker", content: "second answer", timestamp: 4 },
  ];

  it("shows Regenerate only on the latest assistant bubble", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatConsole, { ...baseProps, messages: msgs } as never)
    );
    const count = (html.match(/Regenerate response/g) || []).length;
    assert.equal(count, 1, `expected exactly 1 regenerate control, got ${count}`);
  });

  it("no regenerate control while a turn is loading", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatConsole, { ...baseProps, messages: msgs, isLoading: true } as never)
    );
    assert.equal((html.match(/Regenerate response/g) || []).length, 0);
  });

  it("think blocks in assistant messages render the accordion, not raw tags", async () => {
    const withThink = [
      { id: "u1", role: "user", content: "q", timestamp: 1 },
      { id: "a1", role: "klanker", content: "<think>secret chain</think>visible answer", timestamp: 2 },
    ];
    const r = await renderInDom(
      React.createElement(ChatConsole, { ...baseProps, messages: withThink } as never)
    );
    try {
      const html = r.html();
      assert.ok(html.includes("thinking"), "accordion header missing");
      assert.ok(!html.includes("&lt;think&gt;") && !html.includes("<think>"), "raw think tag leaked");
      assert.ok(!html.includes("secret chain"), "collapsed accordion must hide reasoning");
      assert.ok(html.includes("visible answer"), "answer body missing");
    } finally {
      r.unmount();
    }
  });

  it("regenerate click dispatches the /retry trace command (klanker#169 U15)", async () => {
    const calls: Array<{ m: string; opts?: { command?: boolean; reuseAssistant?: boolean } }> = [];
    const r = await renderInDom(
      React.createElement(ChatConsole, {
        ...baseProps,
        messages: msgs,
        onSendMessage: (m: string, _a?: unknown, opts?: { command?: boolean; reuseAssistant?: boolean }) =>
          calls.push({ m, opts }),
      } as never)
    );
    try {
      const btn = document.querySelector('button[aria-label="Regenerate response"]') as HTMLButtonElement;
      assert.ok(btn, "regenerate button missing");
      await act(async () => {
        btn.click();
      });
      assert.deepEqual(
        calls,
        [{ m: "/retry", opts: { command: true, reuseAssistant: true } }],
        "regenerate must rewind server-side via /retry, never resend the user text"
      );
    } finally {
      r.unmount();
    }
  });
});
