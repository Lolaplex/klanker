import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { ProviderModelPicker } from "./components/ProviderModelPicker.tsx";
import { PairMintedBlock } from "./components/PairModal.tsx";
import { WsInviteCard } from "./components/WsInviteCard.tsx";
import { api } from "./services/api.ts";
import { asSteerEvent, TURN_EVENT_NAME } from "./turnStream.ts";
import type { KlankerInstance, PairCreateResult, WsInvite } from "./types/klanker.ts";

const src = (path: string) => readFileSync(path, "utf-8");

async function renderInDom(el: React.ReactElement): Promise<{ unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

async function settle(ms = 30): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("W6 steer SSE confirmation", () => {
  it("narrows only well-formed typed steer frames", () => {
    assert.ok(asSteerEvent({ type: "steer", text: "left", session: "ses_1" }));
    assert.equal(asSteerEvent({ type: "steer", text: " ", session: "ses_1" }), null);
    assert.equal(asSteerEvent({ type: "delta", text: "left", session: "ses_1" }), null);
  });

  it("renders the matching live steer frame as a monochrome confirmation line", async () => {
    const { restore } = stubFetch(async () => jsonRes({ events: [] }));
    const r = await renderInDom(React.createElement(ChatConsole, {
      instance: inst,
      speakerName: "Nova",
      messages: [],
      input: "",
      onInput: () => {},
      onSendMessage: () => {},
      onStop: () => {},
      isLoading: true,
      sendHold: false,
      sessionLabel: "ses_1",
      workspace: "alpha",
      persona: "default",
      pending: null,
      deciding: false,
      decideError: null,
      onDecide: () => {},
    }));
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(TURN_EVENT_NAME, {
          detail: { type: "steer", text: "wrong session", session: "ses_other" },
        }));
      });
      await settle();
      assert.equal(document.querySelector('[data-testid="steer-events"]'), null);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(TURN_EVENT_NAME, {
          detail: { type: "steer", text: "steer left", session: "ses_1" },
        }));
      });
      await settle();
      const box = document.querySelector('[data-testid="steer-events"]');
      assert.ok(box, "steer confirmation missing");
      assert.ok(box.textContent?.includes("steer left"));
      assert.ok(box.innerHTML.includes("border-subtle"), "monochrome subtle border missing");
    } finally {
      r.unmount();
      restore();
    }
  });
});

describe("W6 saveKlanker canonical remote dedupe", () => {
  it("adopts the server-returned canonical id and normalized remote fields", async () => {
    localStorage.clear();
    const { calls, restore } = stubFetch(async (url, init) => {
      if (url === "/v1/remotes" && !init?.method) {
        return jsonRes({
          ok: true,
          remotes: [
            { id: "vps", base_url: "https://vps.example:8787", label: "VPS canonical", via: "relay", has_secret: true },
          ],
        });
      }
      if (url === "/v1/remotes" && init?.method === "POST") {
        return jsonRes({
          ok: true,
          remote: { id: "vps", base_url: "https://vps.example:8787", label: "VPS canonical", via: "relay", has_secret: true },
        });
      }
      return jsonRes({ error: "unexpected" }, 500);
    });
    try {
      const draft = {
        id: "vps-copy",
        name: "VPS copy",
        slug: "vps-copy",
        role: "",
        provider: "",
        model: "",
        workspace: "",
        lock_workspace: false,
        port: 0,
        system_prompt: "",
        kind: "remote",
        endpoint: { base_url: "https://vps.example:8787/" },
        secret: "tok",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      } as KlankerInstance;
      const saved = await api.saveKlanker(draft);
      assert.equal(saved.id, "vps");
      assert.equal(saved.slug, "vps");
      assert.equal(saved.name, "VPS canonical");
      assert.equal(saved.endpoint?.base_url, "https://vps.example:8787");
      assert.equal(saved.via, "relay");
      assert.equal(saved.has_secret, true);
      assert.equal(saved.secret, "tok");
      assert.deepEqual(calls.map((c) => `${c.init?.method || "GET"} ${c.url}`), ["GET /v1/remotes", "POST /v1/remotes"]);
      const postBody = JSON.parse(String(calls[1].init?.body));
      assert.equal(postBody.id, "vps-copy", "client must still send its pre-dedupe candidate id");
      assert.equal(localStorage.getItem("klanker.instances"), null, "successful relay save must not fall back to localStorage");
    } finally {
      restore();
    }
  });
});

describe("W6 unified offline provider picker", () => {
  it("opens read-only cached rows offline and blocks model/star mutations", async () => {
    let picked = false;
    let starred = false;
    const r = await renderInDom(React.createElement(ProviderModelPicker, {
      providers: [{ name: "lmstudio", kind: "openai_compat", model: "qwen", models: ["qwen"] }],
      favorites: [],
      pick: { provider: "lmstudio", model: "qwen" },
      stale: true,
      disabled: true,
      onPick: () => { picked = true; },
      onStar: () => { starred = true; },
    }));
    try {
      const trigger = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("lmstudio:qwen")) as HTMLButtonElement;
      assert.ok(trigger, "picker trigger missing");
      assert.equal(trigger.disabled, false, "offline trigger must remain openable");
      await act(async () => trigger.click());
      await settle();
      const html = document.body.innerHTML;
      assert.ok(html.includes("Host offline — showing cached models"), "offline cached banner missing");
      assert.ok(html.includes("Read-only until the host reconnects."), "read-only copy missing");
      const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("qwen") && b !== trigger) as HTMLButtonElement;
      assert.ok(row, "cached model row missing");
      assert.equal(row.disabled, true, "offline model row must be disabled");
      await act(async () => row.click());
      assert.equal(picked, false, "offline model mutation leaked");
      const star = [...document.querySelectorAll("button")].find((b) => b.title.includes("starring is read-only")) as HTMLButtonElement;
      assert.ok(star, "read-only star control missing");
      assert.equal(star.disabled, true);
      await act(async () => star.click());
      assert.equal(starred, false, "offline star mutation leaked");
    } finally {
      r.unmount();
    }
  });

  it("restores mutation-enabled rows when the host scope is online again", async () => {
    let picked = false;
    const r = await renderInDom(React.createElement(ProviderModelPicker, {
      providers: [{ name: "lmstudio", kind: "openai_compat", model: "qwen", models: ["qwen"] }],
      favorites: [],
      pick: { provider: "", model: "" },
      stale: false,
      disabled: false,
      onPick: () => { picked = true; },
      onStar: () => {},
    }));
    try {
      const trigger = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("auto")) as HTMLButtonElement;
      await act(async () => trigger.click());
      await settle();
      const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("qwen")) as HTMLButtonElement;
      assert.ok(row, "online model row missing");
      assert.equal(row.disabled, false);
      await act(async () => row.click());
      assert.equal(picked, true, "online model selection did not fire");
    } finally {
      r.unmount();
    }
  });

  it("disables the picker-owned provider refresh while the remote host is offline", () => {
    const picker = src("src/components/ProviderModelPicker.tsx");
    const app = src("src/App.tsx");
    assert.ok(picker.includes("disabled={disabled}") && picker.includes('aria-label="Refresh providers"'), "picker refresh disable binding missing");
    assert.ok(app.includes("disabled={providersDisabled}"), "offline providersDisabled binding missing");
  });
});

describe("W6 loopback pair-link metadata", () => {
  const basePair: PairCreateResult = {
    mode: "remote",
    code: "ABCD-1234",
    token: "tok",
    pair_url: "http://100.64.1.2:8787/#kind=remote&pair=tok",
    expires_in: 60,
    expires_at: 999,
    host_id: "host",
  };
  const renderPair = (pair: PairCreateResult, loopback: boolean) => renderToStaticMarkup(
    React.createElement(PairMintedBlock, {
      pair,
      linkUrl: pair.pair_url,
      linkLoopback: loopback,
      secondsLeft: 42,
      totalTtl: 60,
      mode: "remote",
    })
  );

  it("shows the monochrome substitution note instead of a warning", () => {
    const html = renderPair({ ...basePair, loopback_substituted: true, loopback_warning: false }, false);
    assert.ok(html.includes("Reachable network address selected automatically"));
    assert.ok(!html.includes("loopback-warning"), "warning rendered despite successful substitution");
    assert.ok(!html.includes("amber-"), "warning chrome must stay monochrome");
  });

  it("honors explicit loopback_warning true and false over URL fallback", () => {
    const warned = renderPair({ ...basePair, loopback_warning: true }, false);
    assert.ok(warned.includes('data-testid="loopback-warning"'), "explicit warning missing");
    const quiet = renderPair({
      ...basePair,
      pair_url: "http://127.0.0.1:8787/#kind=remote&pair=tok",
      loopback_warning: false,
    }, true);
    assert.ok(!quiet.includes("loopback-warning"), "explicit false must suppress URL fallback");
  });

  it("keeps loopback URL fallback for older relays without the fields", () => {
    const legacy = renderPair({
      ...basePair,
      pair_url: "http://127.0.0.1:8787/#kind=remote&pair=tok",
    }, true);
    assert.ok(legacy.includes('data-testid="loopback-warning"'), "legacy loopback fallback missing");
  });

  it("WsInviteCard renders substitution metadata from the minted invite", async () => {
    const orig = api.createWsInvite;
    const invite: WsInvite = {
      code: "ABCD-EFGH",
      token: "tok",
      pair_url: "http://100.64.1.2:8787/#kind=ws&ws=alpha&pair=tok",
      expires_in: 60,
      expires_at: 999,
      host_id: "host",
      ws: "alpha",
      advertised_url: "http://100.64.1.2:8787",
      loopback_substituted: true,
      loopback_warning: false,
    };
    (api as { createWsInvite: typeof api.createWsInvite }).createWsInvite = async () => invite;
    const r = await renderInDom(React.createElement(WsInviteCard, { ws: "alpha" }));
    try {
      await settle(40);
      const html = document.body.innerHTML;
      assert.ok(html.includes("Reachable network address selected automatically"), "ws substitution note missing");
      assert.ok(!html.includes("only this device can reach it"), "ws loopback warning rendered despite substitution");
    } finally {
      r.unmount();
      (api as { createWsInvite: typeof api.createWsInvite }).createWsInvite = orig;
    }
  });

  it("both pair surfaces implement the explicit-field-or-legacy-fallback gate", () => {
    for (const file of ["src/components/PairModal.tsx", "src/components/WsInviteCard.tsx"]) {
      const text = src(file);
      assert.ok(text.includes("loopback_warning === true"), `${file} lost explicit warning handling`);
      assert.ok(text.includes("loopback_warning === undefined"), `${file} lost legacy fallback handling`);
      assert.ok(text.includes("loopback_substituted === true"), `${file} lost substitution handling`);
    }
  });
});

describe("W6 quick-ask open-session bridge", () => {
  it("App listens for klanker:open-session, refreshes the tree, selects the chat, and focuses composer", () => {
    const app = src("src/App.tsx");
    assert.ok(app.includes('["klanker:open-session", openSession]'), "open-session listener missing");
    assert.ok(app.includes("tree.refreshWorkspaces()"), "workspace refresh missing");
    assert.ok(app.includes("tree.refreshPersonas(ws)"), "persona refresh missing");
    assert.ok(app.includes("tree.refreshSessions(ws, persona)"), "session refresh missing");
    assert.ok(app.includes("selectChat(ws, persona, session, true)"), "focused session selection missing");
    assert.ok(app.includes('new Event("klanker:focus-composer")'), "composer focus dispatch missing");
  });
});

