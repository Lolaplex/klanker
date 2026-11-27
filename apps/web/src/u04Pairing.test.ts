import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PairModal, PairMintedBlock } from "./components/PairModal.tsx";
import { DevicesPanel } from "./components/DevicesPanel.tsx";
import { Header } from "./components/Header.tsx";
import { WorkspaceModal } from "./components/WorkspaceModal.tsx";
import { NewKlankerModal } from "./components/NewKlankerModal.tsx";
import { fullInviteUrl, pairLinkView, relayMountError, deviceConnectLabel, parsePairInput } from "./pairLink.ts";
import { api } from "./services/api.ts";
import type { KlankerInstance, WorkspaceRow } from "./types/klanker.ts";

// U04 two-layer pairing oracle (klanker#159): layer-1 device pairing in
// the Devices drawer only, layer-2 ws sharing in workspace settings only.

const inst: KlankerInstance = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

// jsdom-less shell: components touch window/localStorage at render time.
Object.defineProperty(globalThis, "window", {
  value: {
    location: { hostname: "localhost", host: "localhost:8787", origin: "http://localhost:8787" },
    matchMedia: undefined,
  },
  configurable: true,
});

describe("PairModal layer-1 tabs", () => {
  const renderModal = () =>
    renderToStaticMarkup(React.createElement(PairModal, { instance: inst, onClose: () => {} } as never));

  it("renders exactly two tabs — Device/Desktop and Browser/PWA", () => {
    const html = renderModal();
    assert.ok(html.includes("Device / Desktop"), "device tab missing");
    assert.ok(html.includes("Browser / PWA"), "browser tab missing");
    assert.ok(!html.includes("share ws"), "share ws tab must be gone — layer 2 lives in workspace settings");
  });

  it("titles itself Pair device, not pair · instance", () => {
    const html = renderModal();
    assert.ok(html.includes("Pair device"), "title missing");
    assert.ok(!html.includes("pair ·"), "legacy instance-scoped title still present");
  });
});

describe("PairMintedBlock remote link surface", () => {
  const remotePair = {
    code: "ABCD-1234",
    token: "tok",
    pair_url: "http://127.0.0.1:8787/#kind=remote&pair=tok",
    expires_in: 60,
  };

  it("pairLinkView keeps the full #kind=remote&pair= url (line-86 regression)", () => {
    const { linkUrl, loopback } = pairLinkView(remotePair.pair_url);
    assert.equal(linkUrl, remotePair.pair_url, "remote pair link must survive key-only matching");
    assert.equal(loopback, true, "127.0.0.1 is loopback");
  });

  it("renders copyable link row, loopback warning and cli hint for mode=remote", () => {
    const { linkUrl, loopback } = pairLinkView(remotePair.pair_url);
    const html = renderToStaticMarkup(
      React.createElement(PairMintedBlock, {
        pair: remotePair,
        linkUrl,
        linkLoopback: loopback,
        secondsLeft: 42,
        totalTtl: 60,
        mode: "remote",
      } as never)
    );
    assert.ok(html.includes("copy link"), "copyable link row missing");
    assert.ok(html.includes("kind=remote&amp;pair=tok") || html.includes("kind=remote&pair=tok"), "full link not rendered");
    assert.ok(html.includes("not loopback"), "loopback warning missing");
    assert.ok(html.includes("klanker workspace join"), "cli hint missing");
  });

  it("hides the loopback warning for a reachable tailnet url", () => {
    const url = "http://100.64.1.2:8787/#kind=remote&pair=tok";
    const { linkUrl, loopback } = pairLinkView(url);
    assert.equal(loopback, false, "tailnet ipv4 is not loopback");
    const html = renderToStaticMarkup(
      React.createElement(PairMintedBlock, {
        pair: { ...remotePair, pair_url: url },
        linkUrl,
        linkLoopback: loopback,
        secondsLeft: 42,
        totalTtl: 60,
        mode: "remote",
      } as never)
    );
    assert.ok(!html.includes("not loopback"), "loopback warning must not render for reachable urls");
  });
});

describe("AuthGate invite copy payload", () => {
  it("fullInviteUrl builds a parsePairInput-redeemable url from origin + original hash", () => {
    const hash = "#kind=ws&ws=alpha&pair=tok123";
    const url = fullInviteUrl("https://hub.example", hash);
    assert.equal(url, "https://hub.example/#kind=ws&ws=alpha&pair=tok123");
    const parsed = parsePairInput(url);
    assert.ok(parsed, "copied invite must parse back");
    assert.equal(parsed.credential, "tok123");
    assert.equal(parsed.origin, "https://hub.example");
  });

  it("adds the hash fragment marker when missing and strips trailing slashes", () => {
    assert.equal(fullInviteUrl("https://hub.example/", "kind=ws&pair=t"), "https://hub.example/#kind=ws&pair=t");
    assert.equal(fullInviteUrl("", "#pair=t"), "", "empty origin yields no invite");
  });
});

describe("NewKlankerModal redeem side", () => {
  it("relayMountError rejects ws and web modes, passes remote", () => {
    assert.ok(relayMountError("ws")?.includes("joins a workspace"), "ws must be rejected");
    assert.ok(relayMountError("web")?.includes("pairs a browser"), "web must be rejected");
    assert.equal(relayMountError("remote"), null, "remote mounts fine");
    assert.equal(relayMountError(""), null);
  });

  it("deviceConnectLabel prefers the typed device name, falls back to peer hostname, never empty-ip", () => {
    assert.equal(deviceConnectLabel("felix-laptop", "peerhost"), "felix-laptop");
    assert.equal(deviceConnectLabel("  ", "peerhost"), "peerhost");
    assert.equal(deviceConnectLabel("", null), "");
  });

  it("renders the device name input and Nearby Tailscale devices title", () => {
    const html = renderToStaticMarkup(
      React.createElement(NewKlankerModal, {
        isOpen: true,
        onClose: () => {},
        onSave: () => {},
        onConnected: () => {},
      } as never)
    );
    assert.ok(html.includes("device name"), "device name input missing");
    assert.ok(html.includes("Nearby Tailscale devices"), "tailscale discovery title missing");
  });
});

describe("DevicesPanel action bar", () => {
  it("always renders + Pair device and Connect to hub", () => {
    const html = renderToStaticMarkup(
      React.createElement(DevicesPanel, {
        instance: inst,
        status: null,
        instances: [inst],
        onEditInstance: () => {},
        onConnect: () => {},
        onPair: () => {},
        onClose: () => {},
      } as never)
    );
    assert.ok(html.includes("+ Pair device"), "pair button missing");
    assert.ok(html.includes("Connect to hub"), "connect button missing");
    assert.ok(!html.includes("hub on LAN"), "duplicate hub checkbox must be gone");
    assert.ok(!html.includes("PROVIDERS"), "read-only providers card must be gone");
  });
});

describe("Header devices pill", () => {
  it("has no standalone Pair button and labels the status pill Devices", () => {
    const html = renderToStaticMarkup(
      React.createElement(Header, {
        activeInstance: inst,
        selWs: "alpha",
        onOpenSettings: () => {},
        onOpenManage: () => {},
        onOpenNav: () => {},
        onOpenDevices: () => {},
      } as never)
    );
    assert.ok(!/>Pair</.test(html), "standalone Pair button must be retired");
    assert.ok(html.includes("Devices"), "devices pill missing");
  });
});

describe("WorkspaceModal sharing tab layer-2 gating", () => {
  const ws = (policy: string): WorkspaceRow =>
    ({
      id: "alpha",
      label: "alpha",
      sync_policy: policy,
      sync_hosts: [],
      repos: [],
      execution: { failover: "none" },
    }) as unknown as WorkspaceRow;

  const renderSettings = (policy: string) =>
    renderToStaticMarkup(
      React.createElement(WorkspaceModal, {
        instance: inst,
        workspace: ws(policy),
        initialTab: "sharing",
        onSaved: () => {},
        onClose: () => {},
      } as never)
    );

  it("hides sharing controls behind a muted note when sync_policy is local", () => {
    const html = renderSettings("local");
    assert.ok(
      html.includes("Local workspace — data stays on this device only"),
      "local muted note missing"
    );
    assert.ok(!html.includes("Shared devices"), "member checklist must be hidden on local");
    assert.ok(!html.includes("default host"), "default host must be hidden on local");
    assert.ok(!html.includes("Invite guest"), "guest invite must be hidden on local");
  });

  it("shows sharing controls when synced", () => {
    const html = renderSettings("synced");
    assert.ok(html.includes("Shared devices"), "member checklist missing on synced");
    assert.ok(html.includes("default host"), "default host missing on synced");
    assert.ok(html.includes("+ Invite guest to this workspace only"), "guest invite collapsible missing on synced");
  });

  it("never prints sync_hosts or fail-closed jargon", () => {
    for (const policy of ["local", "synced"]) {
      const html = renderSettings(policy);
      assert.ok(!html.includes("sync_hosts"), `sync_hosts jargon on ${policy}`);
      assert.ok(!html.includes("fail-closed"), `fail-closed jargon on ${policy}`);
      assert.ok(!html.includes("host_paths.json"), `host_paths.json jargon on ${policy}`);
    }
  });
});

describe("api.setHostLabel wire contract", () => {
  it("PATCHes /v1/host with { label }, never { host_label }", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as { url: string }).url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, host_id: "host_1", host_label: "felix-pc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const res = await api.setHostLabel("felix-pc");
      assert.equal(res.host_label, "felix-pc");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/v1/host");
      assert.equal(calls[0].init?.method, "PATCH");
      const body = JSON.parse(String(calls[0].init?.body || "{}"));
      assert.equal(body.label, "felix-pc");
      assert.ok(!("host_label" in body), "must not send deprecated/rejected host_label field");
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
  });
});
