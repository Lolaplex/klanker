import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { Header } from "./components/Header.tsx";
import { KlankerList, type SessionRow } from "./components/KlankerList.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { clipTitle } from "./chatBuckets.ts";
import { forkSession } from "./services/workbenchApi.ts";
import type { KlankerInstance } from "./types/klanker.ts";

// U17 oracle (klanker#171): single 44px shell header, searchable/resizable/
// collapsible sidebar, Cmd/Ctrl+K palette, toast notifications, centered
// readable chat transcript and workspace-aware onboarding empty state.

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

async function renderInDom(el: React.ReactElement): Promise<{ html: () => string; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    html: () => document.body.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const listProps = {
  workspaces: [{ id: "alpha", label: "Alpha", kind: "local" }],
  wsHostsOf: () => undefined,
  personasOf: () => [{ id: "default", name: "Nova", role: "coder" }],
  sessionRowsOf: (): SessionRow[] => [
    { chatId: "c1", session: "ses_one", label: "fix the shell navigation", pending: false, host: "storm", branch: "feat/ui-u17", repo: "Lolaplex/klanker", wip_unpushed: true },
    { chatId: "c2", session: "ses_two", label: "write release notes", pending: false },
  ],
  selWs: "alpha",
  selPersona: "default",
  openChatId: "c1",
  width: 260,
  collapsed: false,
  onResize: () => {},
  onToggleCollapse: () => {},
  onExpandWs: () => {},
  onExpandPersona: () => {},
  onSelectChat: () => {},
  onNewChat: () => {},
  onDeleteChat: () => {},
  onRenameChat: () => {},
  onForkChat: () => {},
  onNewWorkspace: () => {},
  onDeleteWorkspace: () => {},
  onWorkspaceSettings: () => {},
  onNewPersona: () => {},
  onDeletePersona: () => {},
} as const;

describe("unified 44px shell header", () => {
  it("renders exactly one h-11 header row with breadcrumb, palette and workbench commands", async () => {
    const r = await renderInDom(
      React.createElement(Header, {
        activeInstance: inst,
        selWs: "alpha",
        workspaceLabel: "Alpha",
        selPersona: "default",
        personaLabel: "Nova",
        chatTitle: "fix the shell navigation",
        onOpenSettings: () => {},
        onOpenWorkspace: () => {},
        onOpenNav: () => {},
        onOpenPalette: () => {},
        onToggleWorkbench: () => {},
        controls: React.createElement("button", { type: "button" }, "provider"),
      })
    );
    try {
      const html = r.html();
      assert.ok(html.includes('class="h-11 shrink-0'), "header must be exactly 44px (h-11)");
      assert.ok(html.includes("Alpha"), "workspace breadcrumb missing");
      assert.ok(html.includes("Nova"), "persona breadcrumb missing");
      assert.ok(html.includes("fix the shell navigation"), "chat breadcrumb missing");
      assert.ok(html.includes("Open command palette"), "palette trigger missing");
      assert.ok(html.includes("Toggle workbench"), "workbench trigger missing");
      assert.ok(html.includes("provider"), "host/provider controls slot missing");
    } finally {
      r.unmount();
    }
  });

  it("ChatConsole no longer renders the duplicate top toolbar", () => {
    const src = readFileSync("src/components/ChatConsole.tsx", "utf-8");
    assert.ok(!src.includes("Console Top Toolbar"), "duplicate chat toolbar remains");
    assert.ok(!src.includes("HostPicker"), "HostPicker must live in the unified header");
    assert.ok(!src.includes("ProviderModelPicker"), "ProviderModelPicker must live in the unified header");
  });
});

describe("sidebar navigation", () => {
  it("renders search, resize handle, rich git metadata, rename and fork controls", async () => {
    const r = await renderInDom(React.createElement(KlankerList, listProps));
    try {
      const html = r.html();
      assert.ok(html.includes("Filter workspaces and chats"), "sidebar search missing");
      assert.ok(html.includes("Resize sidebar"), "resize handle missing");
      assert.ok(html.includes("feat/ui-u17"), "branch metadata missing");
      assert.ok(html.includes("klanker"), "repo metadata missing");
      assert.ok(html.includes("wip"), "unpushed WIP badge missing");
      assert.ok(html.includes("Rename chat"), "inline rename control missing");
      assert.ok(html.includes("Fork chat"), "fork control missing");
    } finally {
      r.unmount();
    }
  });

  it("filters sessions by title and collapses to the 52px icon rail when requested", async () => {
    const r = await renderInDom(React.createElement(KlankerList, listProps));
    try {
      const input = document.querySelector('input[aria-label="Filter sidebar"]') as HTMLInputElement;
      assert.ok(input, "filter input missing");
      await act(async () => {
        setInputValue(input, "release");
      });
      await new Promise((res) => setTimeout(res, 20));
      const html = r.html();
      assert.ok(html.includes("write release notes"), "matching session filtered out");
      assert.ok(!html.includes("fix the shell navigation"), "non-matching session still visible");
    } finally {
      r.unmount();
    }
    const collapsed = await renderInDom(React.createElement(KlankerList, { ...listProps, collapsed: true }));
    try {
      assert.ok(collapsed.html().includes("sidebar-collapsed"), "collapsed marker missing");
      assert.ok(collapsed.html().includes("sidebar-icon-rail"), "collapsed icon rail missing");
      assert.ok(collapsed.html().includes("md:w-[52px]"), "52px rail width missing");
    } finally {
      collapsed.unmount();
    }
  });
});

describe("command palette and shortcuts", () => {
  it("filters commands and invokes the active item with Enter", async () => {
    let ran = "";
    const items = [
      { id: "new", label: "New chat", section: "chat", run: () => { ran = "new"; } },
      { id: "theme", label: "Toggle dark / white theme", section: "shell", run: () => { ran = "theme"; } },
    ];
    const r = await renderInDom(React.createElement(CommandPalette, { open: true, onClose: () => {}, items }));
    try {
      const input = document.querySelector('input[aria-label="Command search"]') as HTMLInputElement;
      assert.ok(input, "palette input missing");
      await act(async () => {
        setInputValue(input, "theme");
      });
      await new Promise((res) => setTimeout(res, 20));
      assert.ok(!r.html().includes("New chat"), "filter did not hide unrelated command");
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      assert.equal(ran, "theme");
    } finally {
      r.unmount();
    }
  });

  it("App binds the required global shortcut keys", () => {
    const src = readFileSync("src/App.tsx", "utf-8");
    for (const key of ['key === "k"', 'key === "b"', 'key === "j"', 'key === "n"', 'key === "."', 'key === "/"']) {
      assert.ok(src.includes(key), `missing shortcut ${key}`);
    }
    assert.ok(src.includes("CommandPalette"), "palette not mounted");
    assert.ok(src.includes("ToastStack"), "toast stack not mounted");
  });
});

describe("chat readability, onboarding and shell hygiene", () => {
  it("centers the transcript in a max-w-3xl container and accepts an emptyState node", async () => {
    const r = await renderInDom(
      React.createElement(ChatConsole, {
        instance: inst,
        speakerName: "Nova",
        messages: [],
        input: "",
        onInput: () => {},
        onSendMessage: () => {},
        onStop: () => {},
        sendHold: false,
        pending: null,
        deciding: false,
        decideError: null,
        onDecide: () => {},
        emptyState: React.createElement("div", null, "workspace onboarding"),
      } as never)
    );
    try {
      const html = r.html();
      assert.ok(html.includes("max-w-3xl"), "centered readable transcript container missing");
      assert.ok(html.includes("workspace onboarding"), "emptyState node not rendered");
      assert.ok(!html.includes("Klanker is standby"), "fallback empty state rendered over onboarding");
    } finally {
      r.unmount();
    }
  });

  it("uses plain monochrome follow-up buttons in onboarding", () => {
    const src = readFileSync("src/components/OnboardingEmpty.tsx", "utf-8");
    assert.ok(!/@openuidev\//.test(src), "@openuidev import remains in onboarding");
    assert.ok(!src.includes("FollowUpBlock") && !src.includes("FollowUpItem"), "OpenUI follow-up primitives remain");
    assert.ok(src.includes('type="button"'), "follow-up prompts must render as plain buttons");
    assert.ok(src.includes("border-subtle") && src.includes("bg-surface"), "monochrome button styling missing");
    assert.ok(!/bg-\[#[01][0-9a-fA-F]{5}\]/.test(src), "hardcoded surface hex in onboarding");
  });

  it("does not harshly clip sidebar titles at 22 chars", () => {
    const long = "x".repeat(30);
    assert.equal(clipTitle(long), long);
    assert.equal(clipTitle("x".repeat(81)).length, 81);
  });

  it("replaces the inline wsNote banner with the toast stack", () => {
    const src = readFileSync("src/App.tsx", "utf-8");
    assert.ok(!src.includes("{wsNote && ("), "inline wsNote banner remains");
    assert.ok(src.includes("pushToast(wsNote"), "ws errors are not routed into toasts");
    assert.ok(!readFileSync("src/components/ToastStack.tsx", "utf-8").match(/bg-\[#[01][0-9a-fA-F]{5}\]/), "toast hardcoded surface hex");
  });
});

describe("U14 fork wire", () => {
  it("posts the exact fork contract with workspace query and source_session body", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, session: "ses_fork_1", source_session: "ses_a", workspace: "alpha" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const out = await forkSession(inst, "alpha", "ses_a");
      assert.equal(out.session, "ses_fork_1");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith("/v1/klanker/sessions/fork?workspace=alpha"), calls[0].url);
      assert.equal(calls[0].init?.method, "POST");
      assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { workspace: "alpha", source_session: "ses_a" });
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });
});
