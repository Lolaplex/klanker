import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { WsInboxTab } from "./components/WsInboxTab.tsx";
import { dialogs, currentDialog, resolveDialog, pendingDialogCount } from "./services/dialogs.ts";
import type { KlankerInstance } from "./types/klanker.ts";

// U15 oracle (klanker#169): live streamStatus inside the streaming bubble,
// provider metadata preservation, /retry regenerate, dialogs FIFO queue,
// wake handoff wiring.

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

const baseProps = {
  instance: inst,
  title: "alpha · default",
  speakerName: "nova",
  input: "",
  onInput: () => {},
  onSendMessage: () => {},
  onStop: () => {},
  sendHold: false,
  pending: null,
  deciding: false,
  decideError: null,
  onDecide: () => {},
};

describe("streamStatus inside the streaming bubble", () => {
  it("renders streamStatus even when the streaming bubble is empty (streamingBubble gate)", async () => {
    const messages = [
      { id: "u1", role: "user", content: "question", timestamp: 1 },
      { id: "a1", role: "klanker", content: "", timestamp: 2 },
    ];
    const r = await renderInDom(
      React.createElement(ChatConsole, {
        ...baseProps,
        messages,
        isLoading: true,
        streamStatus: "searching the repo…",
      } as never)
    );
    try {
      const html = r.html();
      assert.ok(html.includes("searching the repo…"), "empty streaming bubble must surface the live status");
      assert.ok(!html.includes("thinking..."), "status replaces the static thinking placeholder");
    } finally {
      r.unmount();
    }
  });

  it("renders streamStatus as a live line while streaming non-empty markdown", async () => {
    const messages = [
      { id: "u1", role: "user", content: "question", timestamp: 1 },
      { id: "a1", role: "klanker", content: "partial answer text", timestamp: 2 },
    ];
    const r = await renderInDom(
      React.createElement(ChatConsole, {
        ...baseProps,
        messages,
        isLoading: true,
        streamStatus: "running tool: grep",
      } as never)
    );
    try {
      const html = r.html();
      assert.ok(html.includes("partial answer text"), "content must render");
      assert.ok(html.includes("running tool: grep"), "live activity line missing under streaming content");
    } finally {
      r.unmount();
    }
  });

  it("does not render the status line on a finished answer", async () => {
    const messages = [
      { id: "u1", role: "user", content: "question", timestamp: 1 },
      { id: "a1", role: "klanker", content: "final answer", timestamp: 2 },
    ];
    const r = await renderInDom(
      React.createElement(ChatConsole, {
        ...baseProps,
        messages,
        isLoading: false,
        streamStatus: null,
      } as never)
    );
    try {
      assert.ok(!r.html().includes("running tool"), "no activity line when idle");
    } finally {
      r.unmount();
    }
  });
});

describe("listProviders metadata preservation", () => {
  it("preserves url, url_env, key_env, key_configured, auth_methods, auth_required", async () => {
    const wire = {
      providers: [
        {
          name: "acp.devin",
          kind: "acp",
          model: "default",
          url: "https://api.devin.ai",
          url_env: "DEVIN_URL",
          key_env: "DEVIN_API_KEY",
          key_configured: true,
          auth_methods: ["bearer", "login"],
          auth_required: true,
        },
      ],
    };
    const stub = stubFetch((url) => (url.includes("/v1/providers") ? jsonRes(wire) : null));
    try {
      const { api } = await import("./services/api.ts");
      const { rows } = await api.listProviders(inst);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.url, "https://api.devin.ai");
      assert.equal(row.url_env, "DEVIN_URL");
      assert.equal(row.key_env, "DEVIN_API_KEY");
      assert.equal(row.key_configured, true);
      assert.deepEqual(row.auth_methods, ["bearer", "login"]);
      assert.equal(row.auth_required, true);
    } finally {
      stub.restore();
      localStorage.clear();
    }
  });

  it("listRemoteProviders preserves the same metadata", async () => {
    const wire = {
      providers: [
        { name: "lmstudio.local", kind: "openai", key_env: "LM_KEY", key_configured: false, auth_required: false },
      ],
    };
    const stub = stubFetch((url) => (url.includes("/v1/providers") ? jsonRes(wire) : null));
    try {
      const { api } = await import("./services/api.ts");
      const { rows } = await api.listRemoteProviders("dev-abc");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].key_env, "LM_KEY");
      assert.equal(rows[0].key_configured, false);
    } finally {
      stub.restore();
      localStorage.clear();
    }
  });
});

describe("/retry regenerate contract", () => {
  it("regenerate dispatches /retry as a command — never the user text as a new bubble", async () => {
    const calls: Array<{ m: string; opts?: { command?: boolean; reuseAssistant?: boolean } }> = [];
    const messages = [
      { id: "u1", role: "user", content: "original question", timestamp: 1 },
      { id: "a1", role: "klanker", content: "answer", timestamp: 2 },
    ];
    const r = await renderInDom(
      React.createElement(ChatConsole, {
        ...baseProps,
        messages,
        isLoading: false,
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
      assert.equal(calls.length, 1);
      assert.equal(calls[0].m, "/retry");
      assert.equal(calls[0].opts?.command, true);
      assert.equal(calls[0].opts?.reuseAssistant, true);
      assert.notEqual(calls[0].m, "original question", "must never resend the user text");
    } finally {
      r.unmount();
    }
  });
});

describe("dialogs FIFO queue", () => {
  it("two overlapping confirm() calls both show sequentially and both resolve", async () => {
    const results: boolean[] = [];
    const p1 = dialogs.confirm("first question").then((v) => results.push(v));
    const p2 = dialogs.confirm("second question").then((v) => results.push(v));
    // Both queued; the first is current.
    assert.equal(pendingDialogCount(), 2);
    assert.equal(currentDialog()?.req.kind, "confirm");
    assert.equal((currentDialog()?.req as { message: string }).message, "first question");
    resolveDialog(true);
    // After resolving the first, the second surfaces.
    assert.equal((currentDialog()?.req as { message: string }).message, "second question");
    resolveDialog(false);
    await Promise.all([p1, p2]);
    assert.deepEqual(results, [true, false], "both promises must resolve in order");
    assert.equal(pendingDialogCount(), 0);
  });

  it("confirm and prompt interleave without hanging", async () => {
    const out: (boolean | string | null)[] = [];
    const p1 = dialogs.confirm("c1").then((v) => out.push(v));
    const p2 = dialogs.prompt("p1").then((v) => out.push(v));
    const p3 = dialogs.confirm("c2").then((v) => out.push(v));
    assert.equal(pendingDialogCount(), 3);
    resolveDialog(true);
    resolveDialog("typed answer");
    resolveDialog(false);
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(out, [true, "typed answer", false]);
  });
});

describe("WsInboxTab wake handoff", () => {
  it("POSTs handoff with wake=1 and the selected peer", async () => {
    const feed = {
      ok: true,
      workspace: "alpha",
      personas: { nova: { open: 1, running: 0, done: 0, failed: 0, unread: 1, total: 1 } },
      recent: [{ at: "2026-02-20T10:00:00", task: "t1", title: "review the diff", status: "open", from: "user", to: "nova" }],
    };
    const stub = stubFetch((url) => {
      if (url.includes("/v1/workspaces/alpha/inbox")) return jsonRes(feed);
      if (url.includes("/personas/nova/inbox") && !url.includes("handoff"))
        return jsonRes({ ok: true, tasks: [{ id: "t1", title: "review the diff", status: "open", owner: "nova" }] });
      if (url.includes("/v1/hub/leases")) return jsonRes({ ok: true, leases: [] });
      if (url.includes("handoff")) return jsonRes({ ok: true });
      return null;
    });
    try {
      const r = await renderInDom(
        React.createElement(WsInboxTab, {
          instance: inst,
          workspace: "alpha",
          personas: [
            { id: "nova", name: "Nova" },
            { id: "rex", name: "Rex" },
          ],
        } as never)
      );
      // Let the load effects settle.
      await act(async () => {
        await new Promise((res) => setTimeout(res, 30));
      });
      try {
        const wakeBtn = document.querySelector('button[aria-label^="Handoff task"]') as HTMLButtonElement;
        assert.ok(wakeBtn, "handoff & wake button missing on the row");
        await act(async () => {
          wakeBtn.click();
        });
        const sendBtn = document.querySelector('button[aria-label="Send handoff and wake the peer"]') as HTMLButtonElement;
        assert.ok(sendBtn, "wake submit missing");
        await act(async () => {
          sendBtn.click();
          await new Promise((res) => setTimeout(res, 30));
        });
        const handoffCalls = stub.calls.filter((c) => c.url.includes("handoff"));
        assert.equal(handoffCalls.length, 1, "exactly one handoff POST");
        assert.ok(handoffCalls[0].url.includes("wake=1"), `missing wake=1: ${handoffCalls[0].url}`);
        assert.ok(handoffCalls[0].url.includes("/personas/nova/inbox/t1/handoff"), `wrong path: ${handoffCalls[0].url}`);
        const body = JSON.parse((handoffCalls[0].init?.body as string) || "{}");
        assert.equal(body.to, "rex", "the other peer must be the default target");
      } finally {
        r.unmount();
      }
    } finally {
      stub.restore();
    }
  });
});
