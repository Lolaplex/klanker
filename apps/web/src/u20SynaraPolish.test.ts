import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { readFileSync } from "node:fs";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { MarkdownMessage } from "./components/MarkdownMessage.tsx";
import { ShortcutsModal, isEditableTarget } from "./components/ShortcutsModal.tsx";
import { WorkbenchRail } from "./components/workbench/WorkbenchRail.tsx";
import { TURN_EVENT_NAME } from "./turnStream.ts";
import type { KlankerInstance } from "./types/klanker.ts";

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

const baseChatProps = {
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

async function renderInDom(el: React.ReactElement) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    root,
    html: () => document.body.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const flush = async (ms = 40) => act(async () => new Promise((res) => setTimeout(res, ms)));

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? { ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

describe("U20 editorial prose typography", () => {
  it("renders assistant markdown as editorial sans while preserving monospace data surfaces", () => {
    const html = renderToStaticMarkup(React.createElement(MarkdownMessage, { text: "# Heading\n\nprose with `inline`\n\n```ts\nconst x = 1\n```" }));
    assert.ok(html.includes("font-sans"), "assistant prose misses font-sans");
    assert.ok(html.includes("text-[14px]"), "assistant prose misses 14px size");
    assert.ok(html.includes("leading-[1.65]"), "assistant prose misses editorial line height");
    assert.ok(html.includes("font-mono"), "code fence loses monospace");

    const css = readFileSync("src/index.css", "utf-8");
    const inlineCode = css.match(/\.klanker-md :not\(pre\) > code \{[\s\S]*?\n\}/)?.[0] || "";
    const table = css.match(/\.klanker-md table \{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(inlineCode.includes("font-family"), "inline code font is not pinned");
    assert.ok(inlineCode.includes("Geist Mono"), "inline code is not monospace");
    assert.ok(table.includes("font-family"), "table font is not pinned");
    assert.ok(table.includes("Geist Mono"), "tables are not monospace");
  });

  it("renders user prose in editorial sans and gives assistant content the full stream width", () => {
    const html = renderToStaticMarkup(React.createElement(ChatConsole, {
      ...baseChatProps,
      messages: [
        { id: "u1", role: "user", content: "plain user prose", timestamp: "2026-01-01T00:00:00Z" },
        { id: "a1", role: "klanker", content: "assistant prose", timestamp: "2026-01-01T00:00:01Z" },
      ],
    } as never));
    assert.ok(html.includes("plain user prose"), "user message missing");
    assert.ok(html.includes("font-sans text-[14px] leading-[1.65]"), "user prose misses editorial classes");

    const src = readFileSync("src/components/ChatConsole.tsx", "utf-8");
    assert.ok(src.includes('mine ? "max-w-[85%] items-end" : "w-full max-w-full items-start"'), "assistant width did not expand to the stream");
    assert.ok(src.includes("md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"), "hover action reveal missing");
    for (const label of ["Copy message", "Regenerate response", "Fork from here", "Speak message"]) {
      assert.ok(src.includes(label), `${label} action missing`);
    }
  });
});

describe("U20 inline tool timeline discipline", () => {
  it("places the timeline after the user prompt before its assistant reply, collapses history, and expands live", async () => {
    const messages = [
      { id: "u1", role: "user", content: "first question", timestamp: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "klanker", content: "first answer", timestamp: "2026-01-01T00:00:01Z" },
    ];
    const r = await renderInDom(React.createElement(ChatConsole, { ...baseChatProps, messages, isLoading: false } as never));
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(TURN_EVENT_NAME, {
          detail: { type: "tool_start", id: "t1", tool: "grep", args_preview: "needle" },
        }));
      });
      await flush(60);
      let html = r.html();
      const userAt = html.indexOf("first question");
      const timelineAt = html.indexOf("tool-timeline");
      const assistantAt = html.indexOf("first answer");
      assert.ok(userAt >= 0, "user prompt missing");
      assert.ok(timelineAt > userAt, `timeline must follow the user prompt (user ${userAt}, timeline ${timelineAt})`);
      assert.ok(timelineAt < assistantAt, `timeline must precede its assistant reply (timeline ${timelineAt}, assistant ${assistantAt})`);
      assert.ok(!html.includes("args: needle"), "historical timeline must be collapsed");

      await act(async () => rootRender(r.root, { ...baseChatProps, messages, isLoading: true }));
      await flush(30);
      html = r.html();
      assert.ok(html.includes("args: needle"), "live timeline must auto-expand");

      await act(async () => rootRender(r.root, { ...baseChatProps, messages, isLoading: false }));
      await flush(30);
      assert.ok(!r.html().includes("args: needle"), "completed timeline must collapse again");
    } finally {
      r.unmount();
    }
  });
});

function rootRender(root: ReturnType<typeof createRoot>, props: Record<string, unknown>) {
  root.render(React.createElement(ChatConsole, props as never));
}

describe("U20 keyboard shortcuts sheet", () => {
  it("detects editable targets so ? never steals input typing", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const plain = document.createElement("div");
    assert.equal(isEditableTarget(input), true);
    assert.equal(isEditableTarget(textarea), true);
    assert.equal(isEditableTarget(select), true);
    assert.equal(isEditableTarget(editable), true);
    assert.equal(isEditableTarget(plain), false);
    assert.equal(isEditableTarget(null), false);
  });

  it("renders the grouped monochrome shortcut rows and App wires ? plus the palette action", async () => {
    const r = await renderInDom(React.createElement(ShortcutsModal, { open: true, onClose: () => {} }));
    try {
      await flush(30);
      const text = document.body.textContent || "";
      for (const needle of ["Navigation", "Command palette", "Toggle sidebar", "Toggle workbench", "Keyboard shortcuts", "Chat", "New chat", "Send / Steer live turn", "New line", "Slash commands", "Workspace mentions", "Stop streaming turn", "Desktop", "Quick-Ask overlay"]) {
        assert.ok(text.includes(needle), `${needle} missing from shortcuts sheet`);
      }
      assert.ok(document.body.innerHTML.includes("<kbd"), "kbd rows missing");
    } finally {
      r.unmount();
    }

    const app = readFileSync("src/App.tsx", "utf-8");
    assert.ok(app.includes('e.key === "?"'), "? key trigger missing");
    assert.ok(app.includes("isEditableTarget(e.target)"), "editable-target guard missing");
    assert.ok(app.includes('label: "Keyboard shortcuts"'), "palette shortcut action missing");
    assert.ok(app.includes("setShortcutsOpen(true)"), "palette action does not open the sheet");
    assert.ok(app.includes("<ShortcutsModal"), "shortcuts sheet not mounted");
  });
});

describe("U20 workbench git fallback and session label", () => {
  it("uses workspace git without a session and shortens raw session ids in the rail header", async () => {
    const fx = stubFetch(() => ({
      ok: true,
      is_git: true,
      branch: "main",
      repo: "",
      worktree: "",
      dirty_files: [{ status: "M", path: "app.py" }],
      wip_unpushed: false,
      diff: "diff --git a/app.py b/app.py\n",
      diff_truncated: false,
    }));
    const r = await renderInDom(React.createElement(WorkbenchRail, { instance: inst, workspace: "alpha", session: "", onClose: () => {}, notify: () => {} }));
    try {
      await flush(70);
      assert.ok(fx.calls.some((c) => c.url.includes("/v1/klanker/git?workspace=alpha")), "workspace git endpoint not called");
      assert.ok(!fx.calls.some((c) => c.url.includes("/v1/klanker/sessions/")), "session git endpoint called without a session");
      assert.ok(r.html().includes("main"), "workspace branch missing");
      assert.ok(r.html().includes("app.py"), "workspace dirty file missing");
    } finally {
      r.unmount();
    }

    const longSession = "ses_01M8FJ3C1T27WTWK3VC238H2KC";
    const r2 = await renderInDom(React.createElement(WorkbenchRail, { instance: inst, workspace: "alpha", session: longSession, onClose: () => {}, notify: () => {} }));
    try {
      await flush(30);
      assert.ok(r2.html().includes("ses_01M8…"), "short session id missing");
      assert.ok(r2.html().includes(`title="${longSession}"`), "full session id tooltip missing");
      assert.ok(!r2.html().includes(`alpha · ${longSession}`), "raw session ULID still displayed");
    } finally {
      r2.unmount();
      fx.restore();
    }
  });
});
