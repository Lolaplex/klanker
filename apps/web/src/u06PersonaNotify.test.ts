import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

// ui/Dialog portals never render in static SSR markup (klanker#170 U16).
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
import { api, notifyWhenUnfocused } from "./services/api.ts";
import { PersonaEditorModal } from "./components/PersonaEditorModal.tsx";
import type { KlankerInstance } from "./types/klanker.ts";

// U06 oracle (klanker#161): persona save dispatches the expected wire
// fields; notification helper fires only while unfocused and never throws
// in a plain web context.

const inst: KlankerInstance = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

describe("api.savePersona", () => {
  it("POSTs id + name + role + system_append to the workspace personas endpoint", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("/personas") && !url.includes("?")) {
        // POST create/upsert
        return jsonRes({ ok: true, persona: { id: "nova" } }, 201);
      }
      // GET /v1/personas?workspace=… read-back shows the persisted fields
      return jsonRes({ ok: true, personas: [{ id: "nova", name: "Nova", role: "reviewer", system_append: "be terse" }] });
    });
    try {
      await api.savePersona(inst, "alpha", "nova", { name: "Nova", role: "reviewer", system_append: "be terse" });
      const post = stub.calls.find((c) => c.init?.method === "POST" || (c.init?.body && typeof c.init.body === "string"));
      assert.ok(post, "no POST call captured");
      assert.ok(post.url.includes("/v1/workspaces/alpha/personas"), `wrong url: ${post.url}`);
      const body = JSON.parse(String(post.init?.body || "{}"));
      assert.equal(body.id, "nova");
      assert.equal(body.name, "Nova");
      assert.equal(body.role, "reviewer");
      assert.equal(body.system_append, "be terse", "wire field must be system_append");
      assert.ok(!("system_prompt" in body), "system_prompt is not a wire field");
    } finally {
      stub.restore();
    }
  });

  it("throws loudly when the relay does not persist the update", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("/workspaces/alpha/personas")) return jsonRes({ ok: true, persona: { id: "nova" } }, 201);
      // read-back still shows the OLD manifest — the silent no-op case
      return jsonRes({ ok: true, personas: [{ id: "nova", name: "nova", role: "old-role" }] });
    });
    try {
      await assert.rejects(
        api.savePersona(inst, "alpha", "nova", { name: "Nova", role: "reviewer", system_append: "x" }),
        /did not persist/,
        "stale read-back must surface as a loud error, never fake success"
      );
    } finally {
      stub.restore();
    }
  });

  it("throws loudly when name/role match but system_append is dropped on read-back", async () => {
    const stub = stubFetch((url) => {
      if (url.includes("/workspaces/alpha/personas")) return jsonRes({ ok: true, persona: { id: "nova" } }, 201);
      return jsonRes({ ok: true, personas: [{ id: "nova", name: "Nova", role: "reviewer", system_append: "old" }] });
    });
    try {
      await assert.rejects(
        api.savePersona(inst, "alpha", "nova", { name: "Nova", role: "reviewer", system_append: "new prompt" }),
        /did not persist/,
        "dropped system_append must surface as a loud error"
      );
    } finally {
      stub.restore();
    }
  });
});

describe("notifyWhenUnfocused gate", () => {
  // undefined restores the jsdom document — leaking a deleted document
  // breaks every DOM-rendered test later in this file (klanker#170 U16).
  const origDocument = globalThis.document;
  const setDoc = (doc: unknown) => {
    Object.defineProperty(globalThis, "document", {
      value: doc === undefined ? origDocument : doc,
      configurable: true,
    });
  };

  it("delivers when the window is hidden", async () => {
    setDoc({ hidden: true, hasFocus: () => false });
    const seen: string[] = [];
    await notifyWhenUnfocused("t", "b", async (t, b) => void seen.push(`${t}:${b}`));
    assert.deepEqual(seen, ["t:b"]);
    setDoc(undefined);
  });

  it("delivers when visible but unfocused", async () => {
    setDoc({ hidden: false, hasFocus: () => false });
    const seen: string[] = [];
    await notifyWhenUnfocused("t", "b", async (t, b) => void seen.push(`${t}:${b}`));
    assert.deepEqual(seen, ["t:b"]);
    setDoc(undefined);
  });

  it("stays silent while the window is focused", async () => {
    setDoc({ hidden: false, hasFocus: () => true });
    const seen: string[] = [];
    await notifyWhenUnfocused("t", "b", async (t, b) => void seen.push(`${t}:${b}`));
    assert.deepEqual(seen, [], "focused window must never be spammed");
    setDoc(undefined);
  });

  it("never throws in a bare web/node context (no document, no Notification, no tauri)", async () => {
    delete (globalThis as { document?: unknown }).document;
    // default deliver = notify — exercises the real web-context path
    await notifyWhenUnfocused("t", "b");
    // hidden state without document also counts as focused: no delivery
    const seen: string[] = [];
    await notifyWhenUnfocused("t", "b", async (t, b) => void seen.push(`${t}:${b}`));
    assert.deepEqual(seen, []);
    setDoc(undefined);
  });

  it("swallows a failing deliver without throwing", async () => {
    setDoc({ hidden: true, hasFocus: () => false });
    await notifyWhenUnfocused("t", "b", async () => {
      throw new Error("os notification backend broken");
    });
    setDoc(undefined);
  });
});

describe("PersonaEditorModal structure", () => {
  it("renders name, role and system prompt fields", async () => {
    const r = await renderInDom(
      React.createElement(PersonaEditorModal, {
        instance: inst,
        workspace: "alpha",
        persona: "nova",
        onSaved: () => {},
        onClose: () => {},
      } as never)
    );
    try {
      // Let the manifest-load effect settle (fetch rejects in tests — the
      // form fields render regardless).
      await act(async () => {
        await new Promise((res) => setTimeout(res, 20));
      });
      const html = r.html();
      assert.ok(html.includes("persona name"), "name field missing");
      assert.ok(html.includes("persona role"), "role field missing");
      assert.ok(html.includes("persona system prompt"), "system prompt field missing");
    } finally {
      r.unmount();
    }
  });
});
