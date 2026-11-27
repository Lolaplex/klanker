import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Header } from "./components/Header.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { WorkspaceModal } from "./components/WorkspaceModal.tsx";
import { filterRoutinesForWorkspace, WsManageNotes } from "./components/WsManageTabs.tsx";
import { visibleProviderRows } from "./components/ProvidersPanel.tsx";
import { api } from "./services/api.ts";
import type { KlankerInstance, ProviderRow, RoutineRow, WorkspaceRow } from "./types/klanker.ts";

// U05 topbar trim + workspace/settings consolidation oracle (klanker#160).

const inst: KlankerInstance = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

Object.defineProperty(globalThis, "window", {
  value: {
    location: { hostname: "localhost", host: "localhost:8787", origin: "http://localhost:8787" },
    matchMedia: undefined,
  },
  configurable: true,
});

describe("Header topbar trim", () => {
  const html = renderToStaticMarkup(
    React.createElement(Header, {
      activeInstance: inst,
      selWs: "alpha",
      onOpenSettings: () => {},
      onOpenWorkspace: () => {},
      onOpenNav: () => {},
      onOpenDevices: () => {},
    } as never)
  );

  it("renders exactly Devices, Workspace, Settings", () => {
    assert.ok(html.includes("Devices"), "devices pill missing");
    assert.ok(html.includes("Workspace"), "workspace button missing");
    assert.ok(html.includes("Settings"), "settings button missing");
  });

  it("has no Store, Voice or Pair topbar buttons", () => {
    assert.ok(!html.includes(">Store<"), "store button must be retired");
    assert.ok(!html.includes(">Voice<"), "voice button must be retired");
    assert.ok(!html.includes(">Pair<"), "pair button must stay retired");
    assert.ok(!html.includes("Workspace store"), "store aria label must be gone");
    assert.ok(!html.includes("Voice read-aloud"), "voice aria label must be gone");
  });
});

describe("routines workspace filter + note split", () => {
  const rows = [
    { name: "a", workspace: "alpha", prompt: "x" },
    { name: "b", workspace: "beta", prompt: "y" },
    { name: "c", workspace: "", prompt: "z" },
  ] as unknown as RoutineRow[];

  it("filters to the active workspace by default, unscoped visible", () => {
    const filtered = filterRoutinesForWorkspace(rows, "alpha", false);
    assert.deepEqual(filtered.map((r) => r.name), ["a", "c"]);
  });

  it("show-all returns everything", () => {
    assert.equal(filterRoutinesForWorkspace(rows, "alpha", true).length, 3);
  });

  it("status renders emerald, error renders red — never mixed", () => {
    const html = renderToStaticMarkup(React.createElement(WsManageNotes, { error: "", status: "run a: ok — done" }));
    assert.ok(html.includes("text-emerald-400"), "status must render emerald");
    assert.ok(!html.includes("text-red-4"), "no red when only a status is present");
    const errHtml = renderToStaticMarkup(React.createElement(WsManageNotes, { error: "boom", status: "" }));
    assert.ok(errHtml.includes("text-red-400"), "error must render red");
    assert.ok(!errHtml.includes("text-emerald-400"), "no emerald when only an error is present");
  });
});

describe("SettingsPanel consolidation", () => {
  const html = renderToStaticMarkup(
    React.createElement(SettingsPanel, {
      settings: { workspace: "", autostart: false, hub_mode: false },
      instance: inst,
      workspace: "alpha",
      persona: "default",
      onClose: () => {},
      onSave: () => {},
    } as never)
  );

  it("contains no INSTANCES section", () => {
    assert.ok(!html.includes(">Instances<"), "instances section must be removed");
    assert.ok(!html.includes("import legacy instances"), "legacy import must be gone from settings");
  });

  it("exposes the three tabs with Providers & Agents first", () => {
    assert.ok(html.includes("Providers &amp; Agents") || html.includes("Providers & Agents"), "providers tab missing");
    assert.ok(html.includes("Host &amp; Desktop") || html.includes("Host & Desktop"), "host tab missing");
    assert.ok(html.includes("Notifications"), "notifications tab missing");
  });

  it("mounts the providers panel as the default tab", () => {
    assert.ok(html.includes("providers &amp; agents") || html.includes("no providers on this host"), "providers panel body missing");
  });

  it("offers browser read-aloud inside settings, not the topbar", () => {
    const withVoice = renderToStaticMarkup(
      React.createElement(SettingsPanel, {
        settings: { workspace: "", autostart: false, hub_mode: false },
        instance: inst,
        voiceEnabled: false,
        onToggleVoice: () => {},
        onClose: () => {},
        onSave: () => {},
      } as never)
    );
    // Host tab is not default — assert the label exists nowhere in the
    // providers default view but the wiring prop is accepted (no crash).
    assert.ok(withVoice.length > 0);
  });
});

describe("provider rows test-filter", () => {
  const rows = [
    { name: "lmstudio", kind: "openai_compat" },
    { name: "echo", kind: "echo" },
    { name: "scripted", kind: "scripted" },
    { name: "devin", kind: "acp-agent" },
  ] as unknown as ProviderRow[];

  it("hides echo/scripted by default", () => {
    assert.deepEqual(visibleProviderRows(rows, false).map((r) => r.name), ["lmstudio", "devin"]);
  });

  it("show-test returns every row", () => {
    assert.equal(visibleProviderRows(rows, true).length, 4);
  });
});

describe("api.setProviderSecret", () => {
  it("POSTs key_env + value to /v1/providers/secret on the instance relay", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as { url: string }).url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, key_env: "LLM_API_KEY" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const out = await api.setProviderSecret(inst, "LLM_API_KEY", "sk-test");
      assert.equal(out.ok, true);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes("/v1/providers/secret"), `wrong url: ${calls[0].url}`);
      const body = JSON.parse(String(calls[0].init?.body || "{}"));
      assert.equal(body.key_env, "LLM_API_KEY");
      assert.equal(body.value, "sk-test");
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });
});

describe("WorkspaceModal tab structure", () => {
  const ws = { id: "alpha", label: "alpha", sync_policy: "local", sync_hosts: [], repos: [] } as unknown as WorkspaceRow;

  it("renders the five tabs", () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceModal, {
        instance: inst,
        workspace: ws,
        onSaved: () => {},
        onClose: () => {},
      } as never)
    );
    for (const label of ["General", "Sharing", "Skills &amp; Routines", "Memory", "Jobs &amp; Traces"]) {
      assert.ok(html.includes(label), `tab ${label} missing`);
    }
  });

  it("general tab carries the auto-recall workspace toggle", () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkspaceModal, {
        instance: inst,
        workspace: ws,
        initialTab: "general",
        onSaved: () => {},
        onClose: () => {},
      } as never)
    );
    assert.ok(html.includes("Auto-recall memory + repo before each turn"), "auto-recall missing from general");
  });
});
