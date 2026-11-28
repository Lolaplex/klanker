import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { encodeQrMatrix } from "./qr.ts";
import { hostPickerRows } from "./hostPicker.ts";
import { mergeDeviceRows } from "./wsShare.ts";

const src = (path: string) => readFileSync(path, "utf-8");

const FORMAT_BITS_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

function formatCopy1(mat: boolean[][]): number {
  const b = (x: number, y: number) => (mat[y][x] ? 1 : 0);
  let bits = 0;
  const put = (pos: number, bit: number) => { if (bit) bits |= 1 << pos; };
  for (let i = 0; i < 6; i++) put(14 - i, b(i, 8));
  put(8, b(7, 8));
  put(7, b(8, 8));
  put(6, b(8, 7));
  for (let i = 0; i < 6; i++) put(5 - i, b(8, 5 - i));
  return bits;
}

function formatCopy2(mat: boolean[][]): number {
  const size = mat.length;
  const b = (x: number, y: number) => (mat[y][x] ? 1 : 0);
  let bits = 0;
  const put = (pos: number, bit: number) => { if (bit) bits |= 1 << pos; };
  for (let i = 0; i < 7; i++) put(14 - i, b(8, size - 1 - i));
  for (let i = 0; i < 8; i++) put(7 - i, b(size - 8 + i, 8));
  return bits;
}

describe("W13C ISO-18004 QR encoder", () => {
  it("stamps MSB-first format bits in both copies and preserves the dark module", () => {
    const cases: [number, number][] = [
      [1, 21],   // v1
      [18, 25],  // v2
      [40, 29],  // v3
      [140, 45], // v7
    ];
    for (const [len, size] of cases) {
      const mat = encodeQrMatrix("x".repeat(len));
      assert.equal(mat.length, size);
      assert.equal(mat[size - 8][8], true, `dark module missing at v${(size - 17) / 4}`);
      const c1 = formatCopy1(mat);
      const c2 = formatCopy2(mat);
      assert.equal(c1, c2);
      assert.ok(FORMAT_BITS_L.includes(c1), `unknown ECC-L format word ${c1.toString(16)}`);
    }
  });
});


  it("folds relayed spoke self aliases into one canonical channel device row", () => {
    const payload = {
      workspace: "w1",
      sync_policy: "synced",
      owner: "dev-me",
      default_host: "dev-me",
      hub_offline: false,
      self_device_id: "dev-me",
      hosts: [
        { device_id: "dev-me", host_id: "host-local", label: "FelixPC", role: "host", self: false, online: true, via: "local", last_seen: 0, status: "online", leases: [] },
        { device_id: "host-local", label: "FelixPC", role: "host", self: true, online: true, via: "local", last_seen: 0, status: "online", leases: [] },
        { device_id: "hub1", label: "klanker-vps", role: "hub", self: false, online: true, via: "hub", last_seen: 0, status: "online", leases: [] },
      ],
    };
    const picker = hostPickerRows(payload as never);
    assert.equal(picker.filter((r) => r.deviceId === "dev-me").length, 1);
    assert.equal(picker.filter((r) => r.deviceId === "host-local").length, 0);
    const shareRows = mergeDeviceRows(payload as never, []);
    assert.equal(shareRows.filter((r) => r.device_id === "dev-me").length, 1);
    assert.equal(shareRows.filter((r) => r.device_id === "host-local").length, 0);
    assert.equal(shareRows.find((r) => r.device_id === "dev-me")?.self, true);
  });

describe("W13C pairing and hub-join UX", () => {
  it("uses role-explicit device actions with loopback-aware primary emphasis", () => {
    const s = src("src/components/DevicesPanel.tsx");
    assert.match(s, /Link a device/);
    assert.match(s, /Join a hub/);
    assert.match(s, /isLoopbackOrigin\(serveUrl\)/);
    assert.match(s, /isLoopbackHost \? secondaryBtn : primaryBtn/);
    assert.match(s, /isLoopbackHost \? primaryBtn : secondaryBtn/);
  });

  it("separates phone QR-first pairing from desktop code-first pairing and guards loopback QR", () => {
    const s = src("src/components/PairModal.tsx");
    assert.match(s, /LINK A DEVICE/);
    assert.match(s, /Phone \/ Browser/);
    assert.match(s, /Desktop \/ Host/);
    assert.match(s, /data-testid="loopback-warning"/);
    assert.match(s, /Show local link anyway/);
    assert.match(s, /Scan with your phone camera to open Klanker signed in\./);
    assert.match(s, /data-testid="desktop-code-card"/);
    assert.match(s, /mode !== "web" \|\| guarded/, "remote mode must not render the phone QR");
  });

  it("joins a hub through two clear fields, smart paste, recents, and automatic host label", () => {
    const s = src("src/components/NewKlankerModal.tsx");
    assert.match(s, /JOIN A HUB/);
    assert.match(s, /aria-label="Hub address"/);
    assert.match(s, /aria-label="Pair code"/);
    assert.match(s, /klanker\.recentHubs/);
    assert.match(s, /parsePairInput\(raw\)/);
    assert.match(s, /Connecting as \{connectingAs\}/);
    assert.match(s, /hub_label/);
    assert.match(s, /Nearby Tailscale devices/);
  });

  it("separates paired-device sharing from restricted guest invites", () => {
    const s = src("src/components/WorkspaceModal.tsx");
    assert.match(s, /Your paired devices/);
    assert.match(s, /Guest invite \(this workspace only\)/);
    assert.match(s, /Restricted access — guests can only see and sync this workspace/);
  });
});

describe("W13C composer thinking and ACP controls", () => {
  it("renders a reasoning selector for native providers and thought/speed selectors for capable ACP providers", () => {
    const s = src("src/components/PowerComposer.tsx");
    assert.match(s, /ariaLabel="Thinking effort"/);
    assert.match(s, /testId="reasoning-selector"/);
    assert.match(s, /Think: Auto/);
    assert.match(s, /Think: High/);
    assert.match(s, /ariaLabel="ACP thinking"/);
    assert.match(s, /testId="acp-thought-select"/);
    assert.match(s, /ariaLabel="ACP speed"/);
    assert.match(s, /testId="acp-speed-select"/);
  });

  it("persists reasoning and per-provider ACP preferences and wires them into streamChat", () => {
    const tm = src("src/services/turnMode.ts");
    const app = src("src/App.tsx");
    const api = src("src/services/api.ts");
    assert.match(tm, /klanker\.reasoning/);
    assert.match(tm, /klanker\.acpPrefs/);
    assert.match(tm, /writeAcpPref/);
    assert.match(app, /reasoning: !providerIsAcp && reasoning !== "auto"/);
    assert.match(app, /thought_level: providerIsAcp/);
    assert.match(app, /speed: providerIsAcp/);
    assert.match(api, /thought_level\?: string/);
    assert.match(api, /speed\?: string/);
    assert.match(api, /reasoning\?: "off" \| "low" \| "medium" \| "high"/);
    assert.match(api, /thought_levels: Array\.isArray\(p\.thought_levels\)/);
    assert.match(api, /speeds: Array\.isArray\(p\.speeds\)/);
  });
});
