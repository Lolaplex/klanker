import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { mergeMessages } from "./chatSync.ts";
import { TurnStatusInline } from "./components/ChatConsole.tsx";
import { Header } from "./components/Header.tsx";
import { PowerComposer } from "./components/PowerComposer.tsx";
import { ProviderModelPicker } from "./components/ProviderModelPicker.tsx";
import { ProvidersPanel } from "./components/ProvidersPanel.tsx";
import { modelDisplayName, providerDisplayName } from "./providerDisplay.ts";
import { api } from "./services/api.ts";
import { readHiddenProviders, writeHiddenProviders } from "./services/providerCatalog.ts";
import { clearSWRCache } from "./services/swrCache.ts";
import type { ChatMessage, KlankerInstance, ProviderRow } from "./types/klanker.ts";

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

const msg = (role: ChatMessage["role"], content: string, timestamp: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: crypto.randomUUID(),
  role,
  content,
  timestamp,
  ...extra,
});

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    const out = handler(url, init);
    if (out instanceof Response) return out;
    return jsonRes(out ?? { ok: true });
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

function stubProviderFetch(rows: ProviderRow[], hidden: string[] = []) {
  return stubFetch((url) => {
    if (url.includes("/v1/providers/agents")) return { agents: [] };
    if (url.includes("/v1/providers/hidden")) return { ok: true };
    if (url.includes("/v1/providers")) return { providers: rows, hidden };
    return { ok: true };
  });
}

async function renderInDom(el: React.ReactElement) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    host,
    html: () => document.body.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const flush = async (ms = 35) => act(async () => new Promise((res) => setTimeout(res, ms)));

function click(el: Element | null | undefined) {
  assert.ok(el, "click target missing");
  act(() => {
    (el as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  clearSWRCache();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.innerHTML = "";
});

describe("W11 Bug 1 chat merge and detached turns", () => {
  it("keeps a repeated short local message whose timestamp is newer than the last server event", () => {
    const server = [
      msg("user", "Hi", "2026-01-01T00:00:00.000Z"),
      msg("klanker", "Hello", "2026-01-01T00:00:01.000Z"),
    ];
    const local = [
      ...server,
      msg("user", "Hi", "2026-01-01T00:00:02.000Z"),
    ];
    const merged = mergeMessages(local, server);
    assert.equal(merged.filter((m) => m.role === "user" && m.content === "Hi").length, 2);
  });

  it("writes a loud detached-stream error and lets a later server reply replace it", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    assert.ok(app.includes('outcome === "detached"'));
    assert.ok(app.includes("await api.sessionEvents(inst0, selWs, selPersona, session)"));
    assert.ok(app.includes("Turn failed: stream disconnected before a reply arrived. Check the relay or retry."));
    assert.ok(app.indexOf('outcome === "detached"') < app.indexOf("Turn failed: stream disconnected before a reply arrived. Check the relay or retry."));

    const serverWithoutReply = [msg("user", "hi", "2026-01-01T00:00:00.000Z")];
    const errorBubble = msg("klanker", "Turn failed: stream disconnected before a reply arrived. Check the relay or retry.", "2026-01-01T00:00:01.000Z", { error: true });
    assert.equal(mergeMessages([errorBubble], serverWithoutReply).some((m) => m.error), true);

    const serverWithReply = [
      ...serverWithoutReply,
      msg("klanker", "late answer", "2026-01-01T00:00:02.000Z"),
    ];
    const merged = mergeMessages([errorBubble], serverWithReply);
    assert.equal(merged.some((m) => m.error), false);
    assert.equal(merged.at(-1)?.content, "late answer");
  });
});

describe("W11 Bug 2 turn status", () => {
  it("defaults to Thinking and never renders Connecting or the scanning bar", () => {
    const html = renderToStaticMarkup(React.createElement(TurnStatusInline));
    assert.ok(html.includes("Thinking…"));
    assert.ok(!html.includes("Connecting…"));
    assert.ok(!html.includes("turn-status-scan"));
    const statusHtml = renderToStaticMarkup(React.createElement(TurnStatusInline, { status: "running tool…" }));
    assert.ok(statusHtml.includes("running tool…"));
  });
});

describe("W11 provider display names", () => {
  it("maps well-known slugs and strips local/default/acp noise", () => {
    assert.equal(providerDisplayName("openrouter.local"), "OpenRouter");
    assert.equal(providerDisplayName("openai.default"), "OpenAI");
    assert.equal(providerDisplayName("anthropic"), "Anthropic");
    assert.equal(providerDisplayName("lmstudio.local"), "LM Studio");
    assert.equal(providerDisplayName("ollama.local"), "Ollama");
    assert.equal(providerDisplayName("acp.devin"), "Devin");
    assert.equal(providerDisplayName("acp.claude"), "Claude Code");
    assert.equal(providerDisplayName("custom.gateway.local"), "custom.gateway");
    assert.equal(providerDisplayName({ name: "custom", label: "My Provider", kind: "openai_compat" }), "My Provider");
  });

  it("splits vendor prefixes for display while preserving vendor metadata", () => {
    assert.deepEqual(modelDisplayName("anthropic/claude-sonnet-5.5", "openrouter.local"), { primary: "claude-sonnet-5.5", vendor: "anthropic" });
    assert.deepEqual(modelDisplayName("z-ai/glm-5.3-flash", "openrouter.local"), { primary: "glm-5.3-flash", vendor: "z-ai" });
    assert.deepEqual(modelDisplayName("swe-2-1-medium"), { primary: "swe-2-1-medium" });
    assert.equal(modelDisplayName("", "openai.default").primary, "OpenAI");
  });
});

describe("W11 ProvidersPanel bug fixes", () => {
  const editableRow: ProviderRow = {
    name: "openrouter.local",
    kind: "openai_compat",
    source: "file",
    url: "https://openrouter.ai/api/v1",
    key_env: "OPENROUTER_API_KEY",
    key_configured: true,
    model: "anthropic/claude-sonnet-5.5",
    models: ["anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4.1-flash-1017"],
  };

  it("opens the editor inside the provider card, cancels, and saves without losing models", async () => {
    const fx = stubProviderFetch([editableRow]);
    const r = await renderInDom(React.createElement(ProvidersPanel, { instance: inst }));
    try {
      await flush(60);
      const article = document.querySelector('article[data-provider="openrouter.local"]');
      assert.ok(article, "provider card missing");
      assert.ok(article.textContent?.includes("OpenRouter"), "clean display title missing");
      assert.ok(article.textContent?.includes("openrouter.local"), "raw slug metadata missing");
      const editButton = [...article.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit");
      click(editButton);
      await flush(5);
      const editor = article.querySelector('[data-testid="inline-provider-edit"]');
      assert.ok(editor, "inline editor missing inside card");
      assert.equal(editor?.closest("article"), article);
      assert.equal((editor?.querySelector('textarea[aria-label="Models list"]') as HTMLTextAreaElement).value, editableRow.models?.join("\n"));
      click([...editor.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel"));
      await flush(5);
      assert.equal(article.querySelector('[data-testid="inline-provider-edit"]'), null, "cancel did not close editor");

      click([...article.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit"));
      await flush(5);
      const reopened = article.querySelector('[data-testid="inline-provider-edit"]');
      assert.ok(reopened, "editor did not reopen");
      click([...reopened.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save"));
      await flush(60);
      const write = fx.calls.find((c) => c.url.includes("/v1/providers") && !c.url.includes("/v1/providers/") && c.init?.method === "POST");
      assert.ok(write, "provider write missing");
      const body = JSON.parse(String(write.init?.body));
      assert.equal(body.name, "openrouter.local");
      assert.equal(body.url, editableRow.url);
      assert.equal(body.model, editableRow.model);
      assert.deepEqual(body.models, editableRow.models);
      assert.equal(article.querySelector('[data-testid="inline-provider-edit"]'), null, "save did not close editor");
    } finally {
      r.unmount();
      fx.restore();
    }
  });

  it("renders Update key for configured rows and Set API key only for missing keys", async () => {
    const rows: ProviderRow[] = [
      { ...editableRow, key_configured: true },
      { name: "openai.default", kind: "openai_compat", source: "env", key_env: "OPENAI_API_KEY", key_configured: false },
    ];
    const fx = stubProviderFetch(rows);
    const r = await renderInDom(React.createElement(ProvidersPanel, { instance: inst }));
    try {
      await flush(60);
      const configured = document.querySelector('article[data-provider="openrouter.local"]');
      const missing = document.querySelector('article[data-provider="openai.default"]');
      assert.ok(configured?.textContent?.includes("Update key"), "configured row lacks Update key");
      assert.ok(!configured.textContent?.includes("Set API key"), "configured row still says Set API key");
      assert.ok(configured.textContent?.includes("CONFIGURED"), "CONFIGURED pill missing");
      assert.ok(missing?.textContent?.includes("Set API key"), "missing key row lacks Set API key");
      assert.ok(!missing.textContent?.includes("Update key"), "missing key row says Update key");
      assert.ok(missing.textContent?.includes("missing key"), "missing key badge missing");
    } finally {
      r.unmount();
      fx.restore();
    }
  });

  it("keeps the test-fixtures toggle mounted after turning it on so it can turn off again", async () => {
    const rows: ProviderRow[] = [
      { name: "openrouter", kind: "openai_compat", source: "file" },
      { name: "echo", kind: "echo", source: "env" },
    ];
    const fx = stubProviderFetch(rows);
    const r = await renderInDom(React.createElement(ProvidersPanel, { instance: inst }));
    try {
      await flush(60);
      const toggle = () => document.querySelector('[role="switch"][aria-label="show test providers"]');
      assert.ok(toggle(), "initial test fixture toggle missing");
      assert.equal(document.body.textContent?.includes("echo"), false);
      click(toggle());
      await flush(10);
      assert.ok(toggle(), "toggle vanished after turning on");
      assert.ok(document.body.textContent?.includes("echo"), "test fixture row did not appear");
      click(toggle());
      await flush(10);
      assert.ok(toggle(), "toggle missing after turning off");
      assert.equal(document.body.textContent?.includes("echo"), false);
    } finally {
      r.unmount();
      fx.restore();
    }
  });

  it("hides a built-in env provider and restores defaults", async () => {
    const rows: ProviderRow[] = [
      { name: "openai.default", kind: "openai_compat", source: "env", key_env: "OPENAI_API_KEY", key_configured: true },
    ];
    const fx = stubProviderFetch(rows);
    const r = await renderInDom(React.createElement(ProvidersPanel, { instance: inst }));
    try {
      await flush(60);
      const card = () => document.querySelector('article[data-provider="openai.default"]');
      assert.ok(card(), "built-in card missing");
      assert.ok(card()?.textContent?.includes("Hide"), "Hide button missing");
      assert.ok(!card()?.textContent?.includes("Delete"), "disabled delete path remains for env provider");
      click([...card()!.querySelectorAll("button")].find((b) => b.textContent?.includes("Hide")));
      await flush(20);
      assert.deepEqual(readHiddenProviders(), ["openai.default"]);
      assert.equal(card(), null, "hidden built-in still visible");
      const restore = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Restore defaults (1)"));
      assert.ok(restore, "Restore defaults button missing");
      click(restore);
      await flush(20);
      assert.deepEqual(readHiddenProviders(), []);
      assert.ok(card(), "built-in did not reappear after restore");
      const hiddenPosts = fx.calls.filter((c) => c.url.includes("/v1/providers/hidden") && c.init?.method === "POST");
      assert.equal(hiddenPosts.length, 2);
      assert.deepEqual(JSON.parse(String(hiddenPosts[0].init?.body)), { name: "openai.default", hidden: true });
      assert.deepEqual(JSON.parse(String(hiddenPosts[1].init?.body)), { restore: true });
    } finally {
      r.unmount();
      fx.restore();
    }
  });

  it("surfaces ACP probe feedback and the local relay restart hint", () => {
    const panel = readFileSync("src/components/ProvidersPanel.tsx", "utf8");
    assert.ok(panel.includes("Restart local relay to refresh CLI detection"));
    assert.ok(panel.includes("probe: {probeText(agentProbe)}"));
    const settings = readFileSync("src/components/SettingsPanel.tsx", "utf8");
    assert.ok(settings.includes("Restart local relay"));
    assert.ok(settings.includes("api.serveRestart(draft.hub_mode)"));
  });
});

describe("W11 hidden provider api fallback", () => {
  it("posts hidden state, mirrors it locally, merges list hidden arrays, and restores", async () => {
    writeHiddenProviders([]);
    const fx = stubFetch((url) => {
      if (url.includes("/v1/providers/hidden")) return { ok: true };
      if (url.endsWith("/v1/providers")) return { providers: [], hidden: ["openai.default"] };
      return { ok: true };
    });
    try {
      await api.setProviderHidden(inst, "openai.default", true);
      assert.deepEqual(readHiddenProviders(), ["openai.default"]);
      const listed = await api.listProviders(inst);
      assert.deepEqual(listed.hidden, ["openai.default"]);
      await api.restoreHiddenProviders(inst);
      assert.deepEqual(readHiddenProviders(), []);
      const hiddenCalls = fx.calls.filter((c) => c.url.includes("/v1/providers/hidden"));
      assert.equal(hiddenCalls.length, 2);
    } finally {
      fx.restore();
    }
  });

  it("falls back to localStorage when the relay predates the hidden endpoint", async () => {
    const fx = stubFetch(() => new Response("not found", { status: 404 }));
    try {
      await api.setProviderHidden(inst, "openai.default", true);
      assert.deepEqual(readHiddenProviders(), ["openai.default"]);
      await api.restoreHiddenProviders(inst);
      assert.deepEqual(readHiddenProviders(), []);
    } finally {
      fx.restore();
    }
  });
});

describe("W11 mainstream provider picker", () => {
  it("renders model first with a short provider badge, group toggle, search and manage footer", async () => {
    let openedSettings = false;
    const providers: ProviderRow[] = [{
      name: "openrouter.local",
      kind: "openai_compat",
      models: ["anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4.1-flash-1017"],
    }];
    const r = await renderInDom(React.createElement(ProviderModelPicker, {
      placement: "composer",
      providers,
      favorites: [],
      pick: { provider: "openrouter.local", model: "anthropic/claude-sonnet-5.5" },
      onPick: () => {},
      onStar: () => {},
      onRefresh: () => {},
      onOpenSettings: () => { openedSettings = true; },
    }));
    try {
      const trigger = document.querySelector('button[aria-label="Choose provider and model"]');
      assert.ok(trigger?.textContent?.includes("claude-sonnet-5.5"), "compact trigger lacks short model");
      assert.ok(!trigger.textContent?.includes("openrouter.local"), "trigger wastes space on raw provider slug");
      click(trigger);
      await flush(15);
      assert.ok(document.querySelector('input[placeholder="Search models or type provider:model…"]'), "search input missing");
      const row = document.querySelector('[role="dialog"] button[title="openrouter.local:anthropic/claude-sonnet-5.5"]');
      assert.ok(row, "flat model row missing");
      assert.ok(row.textContent?.includes("claude-sonnet-5.5"), "primary model missing");
      assert.ok(row.textContent?.includes("OpenRouter"), "short provider badge missing");
      assert.ok(!row.textContent?.includes("openrouter.local"), "raw provider slug leaked into row text");
      assert.ok(row.querySelector("span.font-mono"), "model primary is not the monospace first field");
      assert.ok(document.querySelector('button[aria-label="Group by provider"]'), "group toggle missing");
      click(document.querySelector('button[aria-label="Group by provider"]'));
      await flush(10);
      assert.ok(document.body.textContent?.includes("OpenRouter"), "group header missing clean provider name");
      const manage = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("+ Manage providers"));
      assert.ok(manage, "manage providers footer missing");
      click(manage);
      await flush(5);
      assert.equal(openedSettings, true);
    } finally {
      r.unmount();
    }
  });
});

describe("W11 mainstream composer", () => {
  const composerProps = () => ({
    instance: inst,
    input: "",
    onInput: () => {},
    onSubmit: () => {},
    onKeyDown: () => {},
    onPaste: () => {},
    onPickFiles: () => {},
    onDrop: () => {},
    onSteer: async () => {},
    files: [],
    setFiles: () => {},
    textareaRef: React.createRef<HTMLTextAreaElement>(),
    fileRef: React.createRef<HTMLInputElement>(),
    isLoading: false,
    sendHold: false,
    displaySpeaker: "Nova",
    session: "ses_1",
    workspace: "alpha",
    persona: "default",
  });

  it("removes noisy helper text and read-aloud, renders picker, and circular stop while loading empty", async () => {
    let stopped = 0;
    const r = await renderInDom(React.createElement(PowerComposer, {
      ...composerProps(),
      isLoading: true,
      onStop: () => { stopped += 1; },
      providers: [{ name: "openrouter.local", kind: "openai_compat", models: ["anthropic/claude-sonnet-5.5"] }],
      pick: { provider: "openrouter.local", model: "anthropic/claude-sonnet-5.5" },
      onPick: () => {},
      onStar: () => {},
    } as never));
    try {
      const html = r.html();
      assert.ok(!html.includes("enter send · / commands"), "composer helper text remains");
      assert.ok(!html.includes("enter steer · shift+enter newline"), "steer helper text remains");
      assert.ok(!html.includes("Read latest reply"), "composer read-aloud remains");
      assert.ok(document.querySelector('button[aria-label="Choose provider and model"]'), "composer provider picker missing");
      const stop = document.querySelector('button[aria-label="Stop current turn"]') as HTMLButtonElement;
      assert.ok(stop, "circular stop button missing");
      assert.ok(stop.className.includes("rounded-full"), "stop button is not circular");
      click(stop);
      assert.equal(stopped, 1);
    } finally {
      r.unmount();
    }
  });

  it("renders quiet disabled send when empty and active circular send with a draft", async () => {
    const empty = await renderInDom(React.createElement(PowerComposer, composerProps() as never));
    try {
      const send = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
      assert.ok(send.disabled, "empty send should be disabled");
      assert.ok(send.className.includes("rounded-full") && send.className.includes("bg-hover/70"), "empty send is not the quiet circle");
    } finally {
      empty.unmount();
    }
    const filled = await renderInDom(React.createElement(PowerComposer, { ...composerProps(), input: "hello" } as never));
    try {
      const send = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
      assert.equal(send.disabled, false);
      assert.ok(send.className.includes("rounded-full") && send.className.includes("bg-accent"), "active send is not the accent circle");
    } finally {
      filled.unmount();
    }
  });
});

describe("W11 header command trigger", () => {
  it("uses one Search icon plus a platform shortcut label, never duplicate command glyphs", async () => {
    const r = await renderInDom(React.createElement(Header, {
      activeInstance: null,
      selWs: "",
      onOpenSettings: () => {},
      onOpenWorkspace: () => {},
      onOpenNav: () => {},
      onOpenPalette: () => {},
      onToggleWorkbench: () => {},
    }));
    try {
      const button = document.querySelector('button[aria-label="Open command palette"]');
      assert.ok(button, "command palette trigger missing");
      assert.ok(button.querySelector("svg.lucide-search"), "Search icon missing");
      assert.ok(!button.querySelector("svg.lucide-command"), "duplicate Command icon remains");
      assert.ok(!button.textContent?.includes("⌘⌘"), "duplicate command glyphs rendered");
    } finally {
      r.unmount();
    }
    const src = readFileSync("src/components/Header.tsx", "utf8");
    assert.ok(!src.includes("<Command"), "Header still imports/renders Command icon");
  });
});
