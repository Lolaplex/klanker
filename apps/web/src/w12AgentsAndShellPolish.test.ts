import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { filterVisibleProviders } from "./services/providerCatalog.ts";
import { clearSWRCache } from "./services/swrCache.ts";
import { ProvidersPanel } from "./components/ProvidersPanel.tsx";
import { ProviderModelPicker } from "./components/ProviderModelPicker.tsx";
import { PowerComposer } from "./components/PowerComposer.tsx";
import { Header } from "./components/Header.tsx";
import { KlankerList, type SessionRow } from "./components/KlankerList.tsx";
import { ContextMenuProvider } from "./components/ui/ContextMenu.tsx";
import type { KlankerInstance, ProviderRow } from "./types/klanker.ts";

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

const src = (path: string) => readFileSync(path, "utf8");
const flush = async (ms = 40) => act(async () => new Promise((res) => setTimeout(res, ms)));

async function renderInDom(el: React.ReactElement) {
  document.body.innerHTML = "";
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

function click(el: Element | null | undefined) {
  assert.ok(el, "click target missing");
  act(() => (el as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stubProviderFetch(rows: ProviderRow[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    calls.push({ url, init });
    if (url.includes("/v1/providers/agents")) return jsonRes({ agents: [{ id: "devin", label: "Devin CLI", command: "devin acp", installed: true, path: "C:/tools/devin" }] });
    if (url.endsWith("/v1/providers")) return jsonRes({ providers: rows, hidden: [] });
    if (url.includes("/probe")) return jsonRes({ status: "ok", models: rows.find((r) => url.includes(encodeURIComponent(r.name)))?.models || [], modes: ["smart", "ask"] });
    return jsonRes({ ok: true });
  };
  return { calls, restore: () => void ((globalThis as { fetch: unknown }).fetch = orig) };
}

beforeEach(() => {
  clearSWRCache();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.innerHTML = "";
});

describe("W12D catalog hard filtering", () => {
  it("always hides scripted/echo fixtures even with the stale localStorage flag", () => {
    window.localStorage.setItem("klanker.showTestProviders", "1");
    const rows: ProviderRow[] = [
      { name: "openrouter", kind: "openai_compat", source: "file" },
      { name: "scripted.tool", kind: "scripted.tool", source: "env" },
      { name: "scripted.alpha", kind: "scripted", source: "env" },
      { name: "echo", kind: "echo", source: "env" },
    ];
    assert.deepEqual(filterVisibleProviders(rows, true).map((r) => r.name), ["openrouter"]);
  });

  it("allows echo only as the zero-real-provider fallback and never scripted.tool", () => {
    const echoOnly = filterVisibleProviders([{ name: "echo", kind: "echo", source: "env" }], false).map((r) => r.name);
    assert.deepEqual(echoOnly, ["echo"]);
    const scriptedOnly = filterVisibleProviders([{ name: "scripted.tool", kind: "scripted.tool", source: "env" }], false);
    assert.deepEqual(scriptedOnly, []);
  });
});

describe("W12D provider settings separation", () => {
  it("renders one unified ACP Devin card with inline Probe/Edit/Disable and no fixture toggle", async () => {
    const rows: ProviderRow[] = [
      { name: "openrouter", kind: "openai_compat", source: "file", models: ["claude-sonnet-5.5"] },
      { name: "acp.devin", kind: "acp-agent", source: "file", command: "devin acp", models: ["adaptive", "swe-2-1-medium"] },
    ];
    const fx = stubProviderFetch(rows);
    const r = await renderInDom(React.createElement(ProvidersPanel, { instance: inst }));
    try {
      await flush(80);
      assert.ok(document.body.textContent?.includes("Model Providers"), "Model Providers section missing");
      assert.ok(document.body.textContent?.includes("Coding Agents · ACP"), "Coding Agents section missing");
      assert.equal(document.querySelectorAll('article[data-provider="acp.devin"]').length, 1, "configured Devin card duplicated");
      assert.equal(document.querySelector('[role="switch"][aria-label="show test providers"]'), null, "test fixtures toggle remains");
      const card = document.querySelector('article[data-provider="acp.devin"]') as HTMLElement;
      assert.ok(card, "unified Devin coding-agent card missing");
      assert.equal(card.dataset.codingAgent, "devin");
      for (const label of ["Probe", "Edit", "Disable"]) assert.ok(card.textContent?.includes(label), `Devin card missing ${label}`);
      assert.ok(card.textContent?.includes("2 models"), "probed model count missing");
      assert.ok(document.body.textContent?.includes("+ Custom ACP agent…"), "custom ACP form missing");
      click([...card.querySelectorAll("button")].find((b) => b.textContent?.includes("Edit")));
      await flush(5);
      assert.ok(card.querySelector('[data-testid="inline-provider-edit"]'), "inline ACP editor is not inside the same card");
      assert.ok(card.querySelector('input[aria-label="Spawn command"]'), "ACP command editor missing");
    } finally {
      r.unmount();
      fx.restore();
    }
  });
});

describe("W12D picker and composer ACP split", () => {
  const providers: ProviderRow[] = [
    { name: "openrouter.local", kind: "openai_compat", models: ["anthropic/claude-sonnet-5.5"] },
    { name: "acp.devin", kind: "acp-agent", command: "devin acp", models: ["adaptive", "swe-2-1-medium", "claude-opus-5-5-medium"] },
  ];

  it("separates MODELS from CODING AGENTS, exposes Devin models, and renders Bot + Devin · model", async () => {
    const chosen: unknown[] = [];
    const r = await renderInDom(React.createElement(ProviderModelPicker, {
      placement: "composer",
      providers,
      favorites: [],
      pick: { provider: "acp.devin", model: "swe-2-1-medium" },
      onPick: (p) => chosen.push(p),
      onStar: () => {},
      onRefresh: () => {},
      onOpenSettings: () => {},
    }));
    try {
      const trigger = document.querySelector('button[aria-label="Choose provider and model"]') as HTMLButtonElement;
      assert.ok(trigger.textContent?.includes("Devin · swe-2-1-medium"), "ACP trigger lacks Devin · model");
      assert.ok(trigger.querySelector("svg"), "trigger icon missing");
      const pickerSrc = src("src/components/ProviderModelPicker.tsx");
      assert.ok(pickerSrc.includes('<Bot className="h-3 w-3 shrink-0 text-ink-secondary" />'), "ACP trigger Bot icon missing");
      click(trigger);
      await flush(20);
      const text = document.body.textContent || "";
      assert.ok(text.includes("MODELS"), "MODELS section missing");
      assert.ok(text.includes("CODING AGENTS · ACP"), "ACP section missing");
      assert.ok(text.includes("3 models"), "agent model count badge missing");
      assert.ok(document.querySelector('[data-testid="acp-models-acp.devin"]'), "active Devin model list not expanded");
      const row = document.querySelector('button[title="acp.devin:adaptive"]') as HTMLButtonElement;
      assert.ok(row, "selectable Devin probed model row missing");
      click(row);
      assert.deepEqual(chosen[0], { provider: "acp.devin", model: "adaptive" });
    } finally {
      r.unmount();
    }
  });

  it("hides AUTO/FAST/AGENT under ACP and renders the clean ACP mode selector", async () => {
    const props = {
      instance: inst,
      input: "hello",
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
      providers: [{ ...providers[1], modes: ["smart", "ask", "plan"] }],
      pick: { provider: "acp.devin", model: "swe-2-1-medium" },
      acpMode: "smart",
      onPick: () => {},
      onStar: () => {},
    };
    const r = await renderInDom(React.createElement(PowerComposer, props as never));
    try {
      assert.equal(document.querySelector('[data-testid="turn-mode-selector"]'), null, "turn-mode radios leaked under ACP");
      assert.ok(document.querySelector('[data-testid="acp-mode-controls"]'), "ACP controls missing");
      assert.ok(document.querySelector('button[aria-label="ACP mode"]'), "monochrome ACP mode Select missing");
      assert.equal(document.querySelector("select"), null, "native ACP select remains");
    } finally {
      r.unmount();
    }
  });
});

describe("W12D fixed dialogs and shell cleanup", () => {
  it("passes fixedHeight through Settings and Workspace dialogs with a stable frame", () => {
    assert.ok(src("src/components/ui/Dialog.tsx").includes("fixedHeight?: boolean"), "Dialog fixedHeight prop missing");
    assert.ok(src("src/components/ui/Dialog.tsx").includes("h-[min(82vh,640px)] max-h-[90vh]"), "fixed height class missing");
    assert.ok(src("src/components/SettingsPanel.tsx").includes('title="SETTINGS" wide fixedHeight'), "SettingsPanel does not pass fixedHeight");
    assert.ok(src("src/components/WorkspaceModal.tsx").includes("wide fixedHeight"), "WorkspaceModal does not pass fixedHeight");
    assert.ok(src("src/components/SettingsPanel.tsx").includes("flex-1 min-h-0 overflow-y-auto"), "Settings tab scroll contract missing");
    assert.ok(src("src/components/WorkspaceModal.tsx").includes("flex-1 min-h-0 p-4 flex flex-col gap-3 overflow-y-auto"), "Workspace tab scroll contract missing");
  });

  it("keeps Header free of logo, expand-sidebar, and theme controls", async () => {
    const r = await renderInDom(React.createElement(Header, {
      activeInstance: inst,
      selWs: "alpha",
      onOpenSettings: () => {},
      onOpenWorkspace: () => {},
      onOpenNav: () => {},
      onOpenPalette: () => {},
      onToggleWorkbench: () => {},
    }));
    try {
      assert.equal(document.querySelector('button[aria-label="Expand sidebar"]'), null, "header expand button remains");
      assert.equal(document.querySelector('button[aria-label="Toggle dark / white theme"]'), null, "header theme toggle remains");
      assert.equal(document.body.textContent?.includes("klanker"), false, "duplicate desktop klanker brand remains");
    } finally {
      r.unmount();
    }
    const header = src("src/components/Header.tsx");
    assert.ok(!header.includes("KlankerMark"), "Header still imports/renders KlankerMark");
    assert.ok(!header.includes("useThemeMode"), "Header still owns theme state");
  });

  it("uses the expanded logo as collapse control and removes bottom rail duplicates", async () => {
    let toggles = 0;
    const listProps = {
      workspaces: [{ id: "alpha", label: "Alpha", kind: "local" }],
      wsHostsOf: () => undefined,
      personasOf: () => [{ id: "default", name: "Nova", role: "coder" }],
      sessionRowsOf: (): SessionRow[] => [],
      selWs: "alpha",
      selPersona: "default",
      openChatId: null,
      width: 260,
      collapsed: false,
      onResize: () => {},
      onToggleCollapse: () => { toggles += 1; },
      onExpandWs: () => {},
      onExpandPersona: () => {},
      onSelectChat: () => {},
      onNewChat: () => {},
      onDeleteChat: () => {},
      onNewWorkspace: () => {},
      onDeleteWorkspace: () => {},
      onWorkspaceSettings: () => {},
      onNewPersona: () => {},
      onDeletePersona: () => {},
    };
    const renderList = (extra: Record<string, unknown>) => renderInDom(React.createElement(ContextMenuProvider, null, React.createElement(KlankerList, { ...listProps, ...extra } as never)));
    const expanded = await renderList({ collapsed: false });
    try {
      const collapse = document.querySelector('button[aria-label="Collapse sidebar"]') as HTMLButtonElement;
      assert.ok(collapse?.textContent?.includes("KLANKER"), "expanded logo is not the collapse button");
      click(collapse);
      assert.equal(toggles, 1);
      assert.equal(document.querySelector('button[aria-label="Collapse sidebar"] svg.lucide-panel-left-close'), null, "separate close icon remains");
    } finally {
      expanded.unmount();
    }
    const collapsed = await renderList({ collapsed: true });
    try {
      const rail = document.querySelector('[data-testid="sidebar-icon-rail"]') as HTMLElement;
      assert.ok(rail.querySelector('button[aria-label="Expand sidebar"]'), "top rail expander missing");
      assert.equal(rail.querySelector('button[aria-label="Settings"]'), null, "bottom rail Settings duplicate remains");
      assert.equal([...rail.querySelectorAll('button[aria-label="Expand sidebar"]')].length, 1, "duplicate bottom rail expander remains");
      const wsContainer = [...rail.querySelectorAll("div")].find((d) => d.querySelector('button[aria-label="Workspace Alpha"]')) as HTMLElement;
      assert.ok(wsContainer?.className.includes("gap-2.5"), "workspace monograms lack gap-2.5");
      assert.ok(src("src/components/KlankerList.tsx").includes("my-2.5 h-px"), "rail divider my-2.5 missing");
    } finally {
      collapsed.unmount();
    }
  });
});
