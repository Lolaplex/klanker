import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Dialog } from "./components/ui/Dialog.tsx";
import { Select } from "./components/ui/Select.tsx";
import { Popover } from "./components/ui/Popover.tsx";
import { Switch } from "./components/ui/Switch.tsx";
import { Tabs } from "./components/ui/Tabs.tsx";
import { ChatConsole } from "./components/ChatConsole.tsx";
import type { KlankerInstance } from "./types/klanker.ts";

// jsdom render helper — base-ui portals never render in static SSR,
// so open Dialog/Popover panels need a real (headless) DOM.
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

describe("ui/Select wrapper", () => {
  it("renders trigger with the selected label and no native select", () => {
    const html = renderToStaticMarkup(
      React.createElement(Select, {
        value: "ask",
        onChange: () => {},
        ariaLabel: "approval mode",
        options: [
          { value: "", label: "inherit" },
          { value: "ask", label: "ask" },
        ],
      })
    );
    assert.ok(!html.includes("<select"), "native select leaked");
    assert.ok(html.includes("ask"), "selected label missing");
    assert.ok(html.includes('aria-label="approval mode"'), "aria label missing");
  });
});

describe("ui/Dialog wrapper", () => {
  it("renders title bar and close button when open", async () => {
    const r = await renderInDom(
      React.createElement(
        Dialog,
        { open: true, onClose: () => {}, title: "workspace · alpha" },
        React.createElement("div", null, "body")
      )
    );
    try {
      const html = r.html();
      assert.ok(html.includes("workspace · alpha"), "title missing");
      assert.ok(html.includes("body"), "children missing");
      assert.ok(html.includes("aria-label=\"Close\""), "close button missing");
      assert.ok(html.includes('role="dialog"'), "dialog role missing");
    } finally {
      r.unmount();
    }
  });

  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Dialog,
        { open: false, onClose: () => {}, title: "hidden" },
        React.createElement("div", null, "body")
      )
    );
    assert.ok(!html.includes("hidden"), "closed dialog must not render");
  });
});

describe("ui/Popover wrapper", () => {
  it("renders trigger; panel stays closed by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(Popover, {
        open: false,
        onOpenChange: () => {},
        trigger: React.createElement("button", { type: "button" }, "open it"),
        children: React.createElement("div", null, "panel-body"),
      })
    );
    assert.ok(html.includes("open it"), "trigger missing");
    assert.ok(!html.includes("panel-body"), "closed popover must not render panel");
  });

  it("renders the panel when open", async () => {
    const r = await renderInDom(
      React.createElement(Popover, {
        open: true,
        onOpenChange: () => {},
        trigger: React.createElement("button", { type: "button" }, "open it"),
        children: React.createElement("div", null, "panel-body"),
      })
    );
    try {
      assert.ok(r.html().includes("panel-body"), "open popover must render panel");
    } finally {
      r.unmount();
    }
  });
});

describe("ui/Switch wrapper", () => {
  it("renders role=switch with aria-checked", () => {
    const html = renderToStaticMarkup(
      React.createElement(Switch, { checked: true, onCheckedChange: () => {}, ariaLabel: "toggle x" })
    );
    assert.ok(html.includes('role="switch"'), "switch role missing");
    assert.ok(html.includes('aria-checked="true"'), "aria-checked missing");
  });
});

describe("ui/Tabs wrapper", () => {
  it("renders tablist with the selected tab marked", () => {
    const html = renderToStaticMarkup(
      React.createElement(Tabs, {
        value: "sharing",
        onValueChange: () => {},
        ariaLabel: "workspace sections",
        tabs: [
          { value: "general", label: "General" },
          { value: "sharing", label: "Sharing" },
        ],
      })
    );
    assert.ok(html.includes('role="tablist"'), "tablist role missing");
    assert.ok(html.includes('role="tab"'), "tab role missing");
    assert.ok(html.includes('aria-selected="true"'), "selected tab missing aria-selected");
  });
});

describe("ChatConsole export menu", () => {
  const inst = {
    id: "local",
    kind: "local",
    name: "klanker",
    workspace: "",
    endpoint: { base_url: "http://127.0.0.1:8787" },
  } as unknown as KlankerInstance;

  it("renders an export button, never a native select", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatConsole, {
        instance: inst,
        title: "alpha · default",
        speakerName: "nova",
        messages: [{ role: "klanker", text: "hi" }],
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
      } as never)
    );
    assert.ok(!html.includes("<select"), "native select leaked into ChatConsole");
    assert.ok(html.includes("export"), "export trigger missing");
  });
});
