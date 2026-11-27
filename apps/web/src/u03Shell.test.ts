import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Header } from "./components/Header.tsx";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { KlankerList } from "./components/KlankerList.tsx";
import type { KlankerInstance } from "./types/klanker.ts";

// U03 shell cleanup oracle (klanker#158): friendly labels over raw ids,
// no duplicate breadcrumb, no broken clear-console control, no jargon.

const inst: KlankerInstance = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

// jsdom-less shell: components touch window/localStorage at render time.
Object.defineProperty(globalThis, "window", {
  value: { location: { hostname: "localhost", host: "localhost:8787" }, matchMedia: undefined },
  configurable: true,
});

describe("Header workspace label", () => {
  const renderHeader = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      React.createElement(Header, {
        activeInstance: inst,
        selWs: "alpha",
        onOpenSettings: () => {},
        onOpenManage: () => {},
        onOpenNav: () => {},
        ...props,
      } as never)
    );

  it("renders workspace.label over the raw workspace id", () => {
    const html = renderHeader({ workspaceLabel: "Research" });
    assert.ok(html.includes("Research"), `label missing: ${html.slice(0, 400)}`);
    // The raw id must not be the headline — only the fallback without a label is.
    const without = renderHeader({});
    assert.ok(without.includes("alpha"), "raw id fallback missing");
    const idx = html.indexOf("Research");
    const rawIdx = html.indexOf(">alpha<");
    assert.ok(rawIdx === -1 || rawIdx > idx, "raw id must not headline over the label");
  });
});

describe("ChatConsole cleanup", () => {
  const renderConsole = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      React.createElement(ChatConsole, {
        instance: inst,
        title: "alpha · default",
        speakerName: "nova",
        messages: [],
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
        ...over,
      } as never)
    );

  it("has no clear-console control anywhere", () => {
    const html = renderConsole();
    assert.ok(!html.includes("Clear console"), "clear console aria label still present");
    assert.ok(!html.includes("Clear Console"), "clear console title still present");
  });

  it("never prints the streaming-tokens jargon", () => {
    const html = renderConsole({
      isLoading: true,
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: 1 }],
    });
    assert.ok(!html.includes("Streaming tokens"), "jargon still present");
    assert.ok(html.includes("Working..."), `Working fallback missing`);
  });

  it("composer placeholder addresses the speaker, not the instance", () => {
    const html = renderConsole();
    assert.ok(html.includes("Message nova..."), `placeholder wrong: ${html.match(/placeholder="[^"]*"/)?.[0]}`);
  });

  it("keeps breadcrumb/host/provider controls out of the transcript surface", () => {
    const html = renderConsole();
    // U17 moved these controls into the single app header; the console must
    // never recreate a second horizontal toolbar.
    assert.ok(!html.includes("Console Top Toolbar"), "duplicate console toolbar still rendered");
    const leftBreadcrumb = html.includes("tracking-wider uppercase truncate");
    assert.ok(!leftBreadcrumb, "duplicate uppercase breadcrumb headline still rendered");
  });
});

describe("KlankerList compact badges", () => {
  const noop = () => {};
  const renderList = (wsHostsOf: (ws: string) => never) =>
    renderToStaticMarkup(
      React.createElement(KlankerList, {
        workspaces: [{ id: "alpha", label: "Alpha", sync_policy: "synced", sync_hosts: ["a", "b"] } as never],
        wsHostsOf,
        personasOf: () => [],
        sessionRowsOf: () => [],
        selWs: "",
        selPersona: "",
        openChatId: null,
        onExpandWs: noop,
        onExpandPersona: noop,
        onSelectChat: noop,
        onNewChat: noop,
        onDeleteChat: noop,
        onNewWorkspace: noop,
        onDeleteWorkspace: noop,
        onWorkspaceSettings: noop,
        onNewPersona: noop,
        onDeletePersona: noop,
      } as never)
    );

  it("renders no multi-word SYNCED N HOSTS pill text in the row", () => {
    const hosts = {
      workspace: "alpha",
      sync_policy: "synced",
      owner: "a",
      default_host: "a",
      hub_offline: false,
      hosts: [
        { device_id: "a", label: "x", role: "owner", self: true, online: true, via: "", last_seen: 1, status: "", leases: [] },
        { device_id: "b", label: "y", role: "member", self: false, online: true, via: "", last_seen: 1, status: "", leases: [] },
      ],
    };
    const html = renderList(() => hosts as never);
    assert.ok(!/synced 2 hosts/i.test(html.replace(/synced · 2 hosts/, "")), "multi-word pill visible in markup");
    // Compact count digit next to the cloud icon; words live in title only.
    assert.ok(html.includes("synced · 2 hosts"), "tooltip missing");
    assert.ok(!html.includes(">SYNCED<") && !html.includes(">synced<"), "uppercase pill text rendered");
  });

  it("resizable sidebar css-var width and overlay row actions reserve no flex width", () => {
    const html = renderList(() => undefined as never);
    assert.ok(html.includes("md:w-[var(--sidebar-width)]"), "sidebar css-var width missing");
    assert.ok(!html.includes("md:w-52"), "old narrow width still present");
    assert.ok(html.includes("md:min-w-[200px]") && html.includes("md:max-w-[420px]"), "U19 width bounds missing");
    assert.ok(html.includes("md:group-hover:flex"), "overlay hover actions missing");
    // The old in-flow hover buttons (opacity-based, width-stealing) are gone.
    assert.ok(!html.includes("md:group-hover:opacity-100"), "in-flow opacity actions still present");
  });
});
