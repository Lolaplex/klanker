import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WsInboxTab, statusPill } from "./components/WsInboxTab.tsx";
import { Header } from "./components/Header.tsx";
import type { KlankerInstance } from "./types/klanker.ts";

// U11 oracle (klanker#166): WsInbox.recent rendering, lease badges,
// handoff creation dispatch, topbar unread badge.

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

function stubFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    const r = handler(url, init);
    if (r) return r;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const FEED = {
  ok: true,
  workspace: "alpha",
  personas: { nova: { open: 1, running: 1, done: 0, failed: 0, unread: 1, total: 2 } },
  recent: [
    { at: "2026-02-20T10:00:00", task: "t1", title: "review the diff", status: "open", from: "user", to: "nova" },
    { at: "2026-02-20T09:00:00", task: "t2", title: "scan the repo", status: "running", from: "nova", to: "nova" },
  ],
};

const TASKS = {
  ok: true,
  tasks: [
    { id: "t1", title: "review the diff", status: "open", owner: "nova", reply_summary: "looks good, two nits" },
    { id: "t2", title: "scan the repo", status: "running", owner: "nova" },
  ],
};

function feedHandler(leases: unknown[] = []) {
  return (url: string) => {
    if (url.includes("/v1/workspaces/alpha/inbox")) return jsonRes(FEED);
    if (url.includes("/personas/nova/inbox")) return jsonRes(TASKS);
    if (url.includes("/v1/hub/leases")) return jsonRes({ ok: true, leases });
    return null;
  };
}

describe("WsInboxTab feed rendering", () => {
  it("renders recent items with status pills, route and reply_summary", async () => {
    const stub = stubFetch(feedHandler());
    const r = await renderInDom(
      React.createElement(WsInboxTab, {
        instance: inst,
        workspace: "alpha",
        personas: [{ id: "nova", name: "Nova" }],
      })
    );
    // settle the load chain
    await act(async () => {
      await new Promise((res) => setTimeout(res, 100));
    });
    try {
      const html = r.html();
      assert.ok(html.includes("review the diff"), "row title missing");
      assert.ok(html.includes("scan the repo"), "second row missing");
      assert.ok(html.includes(">open<") || html.includes("open</span>"), "open pill missing");
      assert.ok(html.includes("running"), "running pill missing");
      assert.ok(html.includes("Nova"), "persona display name missing");
      assert.ok(html.includes("looks good, two nits"), "reply_summary enrichment missing");
      assert.ok(html.includes("1 open handoff"), "open count header missing");
    } finally {
      r.unmount();
      stub.restore();
    }
  });

  it("shows the lease badge on running rows when the ws holds a lease", async () => {
    const stub = stubFetch(feedHandler([{ ws: "alpha", session: "s1", holder: "dev-fx", run_id: "r1", fence: 1, expires_in: 90 }]));
    const r = await renderInDom(
      React.createElement(WsInboxTab, {
        instance: inst,
        workspace: "alpha",
        personas: [{ id: "nova", name: "Nova" }],
      })
    );
    await act(async () => {
      await new Promise((res) => setTimeout(res, 100));
    });
    try {
      assert.ok(r.html().includes("lease"), "lease badge missing");
    } finally {
      r.unmount();
      stub.restore();
    }
  });

  it("no lease badge without active leases", async () => {
    const stub = stubFetch(feedHandler([]));
    const r = await renderInDom(
      React.createElement(WsInboxTab, {
        instance: inst,
        workspace: "alpha",
        personas: [{ id: "nova", name: "Nova" }],
      })
    );
    await act(async () => {
      await new Promise((res) => setTimeout(res, 100));
    });
    try {
      assert.ok(!r.html().includes(">lease<"), "lease badge must not render without leases");
    } finally {
      r.unmount();
      stub.restore();
    }
  });
});

describe("WsInboxTab handoff creation", () => {
  it("POSTs title+note to the persona inbox endpoint", async () => {
    const stub = stubFetch(feedHandler());
    const r = await renderInDom(
      React.createElement(WsInboxTab, {
        instance: inst,
        workspace: "alpha",
        personas: [{ id: "nova", name: "Nova" }],
      })
    );
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    try {
      // open composer
      const toggle = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("new handoff")
      ) as HTMLButtonElement;
      assert.ok(toggle, "composer toggle missing");
      await act(async () => {
        toggle.click();
      });
      // fill title
      const input = document.querySelector('input[aria-label="handoff title"]') as HTMLInputElement;
      assert.ok(input, "title input missing");
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "check the logs");
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      // submit
      const send = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("send handoff")
      ) as HTMLButtonElement;
      assert.ok(send, "send button missing");
      await act(async () => {
        send.click();
        await new Promise((res) => setTimeout(res, 50));
      });
      const post = stub.calls.find(
        (c) => c.url.includes("/v1/workspaces/alpha/personas/nova/inbox") && c.init?.body
      );
      assert.ok(post, "no inbox POST captured");
      const body = JSON.parse(String(post.init?.body || "{}"));
      assert.equal(body.title, "check the logs");
      assert.ok("note" in body, "note field must ride the wire");
    } finally {
      r.unmount();
      stub.restore();
    }
  });
});

describe("statusPill mapping", () => {
  it("maps known statuses and falls back safely", () => {
    assert.equal(statusPill("running").text, "running");
    assert.equal(statusPill("done").text, "done");
    assert.equal(statusPill("failed").text, "failed");
    assert.equal(statusPill("").text, "open");
    assert.equal(statusPill("weird").text, "weird");
  });
});

describe("Header workspace unread badge", () => {
  const renderHeader = (unread: number) =>
    renderToStaticMarkup(
      React.createElement(Header, {
        activeInstance: inst,
        selWs: "alpha",
        onOpenSettings: () => {},
        onOpenWorkspace: () => {},
        onOpenNav: () => {},
        workspaceUnread: unread,
      } as never)
    );

  it("renders the count badge when open handoffs exist", () => {
    const html = renderHeader(3);
    assert.ok(html.includes("3 open handoffs"), "badge aria label missing");
  });

  it("renders no badge at zero", () => {
    const html = renderHeader(0);
    assert.ok(!html.includes("open handoff"), "badge must hide at zero");
  });
});
