import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { injectSteer } from "./services/streamExtrasApi.ts";
import type { KlankerInstance } from "./types/klanker.ts";

const src = (path: string) => readFileSync(path, "utf-8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(path) && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

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

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  user_id: "4242",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

describe("U19 border hierarchy and monochrome chrome", () => {
  it("pins the universal Tailwind preflight border override and refined tokens", () => {
    const css = src("src/index.css");
    assert.ok(css.includes("*, ::before, ::after"), "universal preflight selector missing");
    assert.ok(css.includes("border-color: var(--border-subtle);"), "preflight border token missing");
    assert.ok(css.includes("--border-subtle-rgb: 28 28 28;"), "dark subtle channel mismatch");
    assert.ok(css.includes("--border-strong-rgb: 46 46 46;"), "dark strong channel mismatch");
    assert.ok(css.includes("--border-subtle-rgb: 229 229 229;"), "light subtle channel mismatch");
    assert.ok(css.includes("--border-strong-rgb: 200 200 200;"), "light strong channel mismatch");
  });

  it("moves structural shell chrome to subtle hairlines with strong reserved for interaction", () => {
    const header = src("src/components/Header.tsx");
    const list = src("src/components/KlankerList.tsx");
    const composer = src("src/components/PowerComposer.tsx");
    const rail = src("src/components/workbench/WorkbenchRail.tsx");
    assert.ok(header.includes("border-b border-subtle"), "header divider still heavy");
    assert.ok(header.includes("border border-subtle bg-transparent"), "header controls still boxed");
    assert.ok(list.includes("border-r border-subtle") && list.includes("border-b border-subtle"), "sidebar structural hairlines missing");
    assert.ok(list.includes("h-8 w-full") && list.includes("bg-elevated") && list.includes("hover:border-strong"), "+ new chat restraint missing");
    assert.ok(composer.includes("max-w-3xl") && composer.includes("border-t border-subtle"), "composer centering/top hairline missing");
    const picker = src("src/components/ProviderModelPicker.tsx");
    assert.ok(picker.includes('aria-label="Refresh providers"') && picker.includes("RefreshCw"), "provider refresh picker icon missing");
    assert.ok(!composer.includes('aria-label="Refresh providers"'), "duplicate composer refresh icon remains");
    assert.ok(composer.includes("enter send · / commands · @ mention"), "idle composer hint missing");
    assert.ok(composer.includes("enter steer · shift+enter newline"), "loading composer hint missing");
    assert.ok(rail.includes("border-l border-subtle") && rail.includes("h-11"), "rail hairline/height alignment missing");
    assert.ok(src("src/components/OnboardingEmpty.tsx").includes("hidden md:flex"), "mobile shortcut hint still visible");
    assert.ok(src("src/components/CommandPalette.tsx").includes("py-1 pb-2"), "palette bottom breathing room missing");
  });
});

describe("U19 workbench clipping and resize persistence", () => {
  it("uses six concise left-aligned non-clipping tab labels", () => {
    const rail = src("src/components/workbench/WorkbenchRail.tsx");
    for (const label of ["Changes", "Files", "Traces", "Terminal", "Memory", "Detail"]) {
      assert.ok(rail.includes(`label: "${label}"`), `${label} tab missing`);
    }
    for (const banned of ["TRACES & USAGE", "BG TERMINAL", "DATA & MEMORY"]) {
      assert.ok(!rail.includes(banned), `${banned} verbose label remains`);
    }
    const tabs = src("src/components/ui/Tabs.tsx");
    assert.ok(tabs.includes("justify-start"), "tabs are not left aligned");
    assert.ok(tabs.includes("overflow-x-auto"), "tab overflow fallback missing");
    assert.ok(tabs.includes("px-2.5 py-2 text-[11px] shrink-0"), "compact non-shrinking tab classes missing");
    const railTabClass = rail.split("tabClassName=", 2)[1]?.split("/>", 1)[0] || "";
    assert.ok(!railTabClass.includes("uppercase"), "workbench tabs must render concise mixed-case labels");
  });

  it("bounds and persists sidebar plus workbench widths in the required keys", () => {
    const app = src("src/App.tsx");
    const list = src("src/components/KlankerList.tsx");
    const rail = src("src/components/workbench/WorkbenchRail.tsx");
    assert.ok(app.includes('localStorage.getItem("klanker.sidebar.width")'), "sidebar width restore missing");
    assert.ok(app.includes('localStorage.setItem("klanker.sidebar.width"'), "sidebar width persistence missing");
    assert.ok(app.includes('localStorage.getItem("klanker.workbench.width")'), "workbench width restore missing");
    assert.ok(app.includes('localStorage.setItem("klanker.workbench.width"'), "workbench width persistence missing");
    assert.ok(list.includes("Math.max(200, Math.min(420"), "sidebar 200–420 clamp missing");
    assert.ok(list.includes('aria-label="Resize sidebar"') && list.includes("hover:bg-strong"), "sidebar drag handle missing");
    assert.ok(list.includes("md:w-[var(--sidebar-width)]"), "sidebar width is not applied on desktop");
    assert.ok(rail.includes("Math.max(320, Math.min(640"), "workbench 320–640 clamp missing");
    assert.ok(rail.includes('aria-label="Resize workbench"') && rail.includes("hover:bg-strong"), "workbench drag handle missing");
    assert.ok(rail.includes("md:w-[var(--workbench-width)]"), "workbench width is not applied on desktop");
    assert.ok(rail.includes("md:relative"), "desktop rail must position its resize handle against itself");
  });
});

describe("U19 Enter-to-steer and exact /v1/inject wire", () => {
  it("posts the web session contract and surfaces a 409 refusal loudly", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let status = 200;
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const body = status === 409 ? { error: "no active run for session", session: "ses_1", active: false } : { ok: true, steered: true, active: true };
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    try {
      await injectSteer(inst, { session: "ses_1", text: "steer left", workspace: "alpha" });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith("/v1/inject"), calls[0].url);
      assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
        session_id: "ses_1",
        session: "ses_1",
        text: "steer left",
        workspace: "alpha",
      });
      status = 409;
      await assert.rejects(
        () => injectSteer({ ...inst, user_id: "web-user" } as KlankerInstance, { session: "ses_1", text: "x", workspace: "alpha" }),
        /steer refused — 409: no active run for session/
      );
      assert.equal(calls.length, 2, "non-numeric web user ids must not be refused client-side");
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });

  it("Enter while loading invokes steer, clears input on success, and never starts a second turn", async () => {
    const calls: string[] = [];
    let cleared = false;
    let sent = false;
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/inject")) {
        calls.push(String(init?.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const r = await renderInDom(React.createElement(ChatConsole, {
      instance: inst,
      speakerName: "Nova",
      messages: [],
      input: "steer left",
      onInput: (v: string) => { if (v === "") cleared = true; },
      onSendMessage: () => { sent = true; },
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
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(textarea, "composer textarea missing");
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await act(async () => new Promise((res) => setTimeout(res, 30)));
      assert.equal(calls.length, 1, "Enter did not reach /v1/inject");
      assert.deepEqual(JSON.parse(calls[0]), { session_id: "ses_1", session: "ses_1", text: "steer left", workspace: "alpha" });
      assert.ok(cleared, "input was not cleared after successful steer");
      assert.equal(sent, false, "a duplicate normal turn was started");
    } finally {
      r.unmount();
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });
});

describe("U19 event wiring and ACP mode persistence", () => {
  it("every klanker CustomEvent has a real listener or typed internal path", () => {
    const names = new Set<string>();
    for (const file of walk("src")) {
      const text = readFileSync(file, "utf-8");
      for (const match of text.matchAll(/CustomEvent(?:<[^>]+>)?\(["'](klanker:[^"']+)["']/g)) names.add(match[1]);
      for (const match of text.matchAll(/new Event\(["'](klanker:[^"']+)["']\)/g)) names.add(match[1]);
    }
    const app = src("src/App.tsx");
    const consoleSrc = src("src/components/ChatConsole.tsx");
    for (const name of names) {
      if (name === "klanker:turn-event") assert.ok(consoleSrc.includes("TURN_EVENT_NAME"), "turn stream listener missing");
      else if (name === "klanker:focus-composer") assert.ok(consoleSrc.includes('"klanker:focus-composer"'), "composer focus listener missing");
      else assert.ok(app.includes(`"${name}"`), `${name} dispatched without an App listener`);
    }
    for (const required of ["klanker:open-detail", "klanker:fork-session", "klanker:clear-chat", "klanker:providers-refreshed", "klanker:acp-mode"]) {
      assert.ok(app.includes(`"${required}"`), `${required} not wired in App`);
    }
  });

  it("persists the selected ACP mode per chat/host and passes it forward on turns", () => {
    const app = src("src/App.tsx");
    const composer = src("src/components/PowerComposer.tsx");
    const api = src("src/services/api.ts");
    assert.ok(app.includes("klanker.acp-mode."), "ACP mode storage key missing");
    assert.ok(app.includes("setAcpModes"), "ACP mode state missing");
    assert.ok(app.includes("mode: selectedAcpMode || undefined"), "ACP mode is not passed in the turn payload");
    assert.ok(composer.includes("value={acpMode || modes[0]"), "ACP mode select is not controlled");
    assert.ok(api.includes("mode?: string"), "streamChat wire type lacks mode");
  });
});
