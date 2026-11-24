import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  busyForChat,
  busyKey,
  chatsKey,
  loadBucket,
  LS_SEL,
  LS_TITLES,
  migrateLegacyStorage,
  sendHeld,
  type ChatBucket,
  type TurnBusy,
} from "./chatBuckets.ts";
import { dedupeWorkspaces, sessionHostPill, wsSyncBadge } from "./wsTree.ts";
import type { WorkspaceHosts, WorkspaceRow } from "./types/klanker.ts";

// Map-backed Storage stub — migrateLegacyStorage iterates key(i)/length.
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

const chat = (id: string, session: string, texts: string[], draft = false) => ({
  id,
  session,
  draft,
  messages: texts.map((t, i) => ({ id: `${id}-m${i}`, role: "user" as const, content: t })),
});

const hosts = (over: Partial<WorkspaceHosts> = {}): WorkspaceHosts => ({
  workspace: "wsA",
  sync_policy: "synced",
  owner: "dev_self",
  default_host: "dev_self",
  hub_offline: false,
  hosts: [],
  ...over,
});

describe("dedupeWorkspaces", () => {
  it("lists a shared ws once top-level and merges the richer row", () => {
    const rows: WorkspaceRow[] = [
      { id: "wsA", label: "local stub" },
      { id: "wsB" },
      { id: "wsA", sync_policy: "shared", sync_hosts: ["dev_1", "dev_2"] },
    ];
    const out = dedupeWorkspaces(rows);
    assert.equal(out.length, 2);
    assert.equal(out.filter((r) => r.id === "wsA").length, 1);
    const wsA = out.find((r) => r.id === "wsA")!;
    assert.equal(wsA.label, "local stub"); // earlier field survives
    assert.equal(wsA.sync_policy, "shared"); // later row overwrites
  });
});

describe("wsSyncBadge", () => {
  it("reads local when policy is local or absent (fail-closed)", () => {
    assert.deepEqual(wsSyncBadge({}, null), { kind: "local", label: "local" });
    assert.deepEqual(wsSyncBadge({ sync_policy: "local" }, hosts({ sync_policy: "local" })), {
      kind: "local",
      label: "local",
    });
  });

  it("counts member hosts for synced, reads hub for shared", () => {
    const h = hosts({
      hosts: [
        { device_id: "d1", label: "a", role: "owner", self: true, online: true, via: "", last_seen: 0, status: "", leases: [] },
        { device_id: "d2", label: "b", role: "member", self: false, online: true, via: "", last_seen: 0, status: "", leases: [] },
      ],
    });
    assert.deepEqual(wsSyncBadge({ sync_policy: "synced" }, h), {
      kind: "synced",
      label: "synced 2 hosts",
    });
    assert.deepEqual(wsSyncBadge({ sync_policy: "shared" }, hosts({ sync_policy: "shared" })), {
      kind: "hub",
      label: "hub",
    });
    // No hosts payload → the ws row's policy drives the badge.
    assert.deepEqual(wsSyncBadge({ sync_policy: "shared" }, null), { kind: "hub", label: "hub" });
  });

  it("reads offline when the synced hub has no connected devices", () => {
    assert.deepEqual(
      wsSyncBadge({ sync_policy: "synced" }, hosts({ hub_offline: true })),
      { kind: "offline", label: "offline" }
    );
  });
});

describe("sessionHostPill", () => {
  it("resolves a bound host label from session.host", () => {
    const h = hosts({
      hosts: [
        { device_id: "dev_box", label: "Workstation", role: "member", self: false, online: true, via: "", last_seen: 0, status: "", leases: [] },
      ],
    });
    assert.equal(sessionHostPill("dev_box", "ses_1", h), "Workstation");
    assert.equal(sessionHostPill(undefined, "ses_1", h), null);
  });

  it("falls back to an active (ws, session) lease holder", () => {
    const h = hosts({
      hosts: [
        {
          device_id: "dev_gpu",
          label: "GPU box",
          role: "member",
          self: false,
          online: true,
          via: "",
          last_seen: 0,
          status: "",
          leases: [{ session: "ses_9", run_id: "r1", fence: 1, expires_in: 60 }],
        },
      ],
    });
    assert.equal(sessionHostPill(undefined, "ses_9", h), "GPU box");
    assert.equal(sessionHostPill(undefined, "ses_other", h), null);
  });
});

describe("turn busy map", () => {
  const busy = (over: Partial<TurnBusy> = {}): TurnBusy => ({
    instanceId: "local",
    wsId: "wsA",
    persona: "default",
    session: "ses_1",
    chatId: "c1",
    run: "r1",
    ...over,
  });

  it("a busy wsA::ses1 never holds wsA::ses2", () => {
    const map: Record<string, TurnBusy> = { [busyKey("wsA", "ses_1")]: busy() };
    assert.equal(sendHeld(map, "wsA", "ses_2", "c2"), false);
    // Same session bound to a different chat row: held.
    assert.equal(sendHeld(map, "wsA", "ses_1", "c2"), true);
    // The busy chat itself is never held.
    assert.equal(sendHeld(map, "wsA", "ses_1", "c1"), false);
    // Drafts (no session yet) are never held.
    assert.equal(sendHeld(map, "wsA", "", "c3"), false);
  });

  it("parallel sessions coexist in the same bucket without interference", () => {
    const map: Record<string, TurnBusy> = {
      [busyKey("wsA", "ses_1")]: busy(),
      [busyKey("wsA", "ses_2")]: busy({ session: "ses_2", chatId: "c2", run: "r2" }),
    };
    assert.equal(Object.keys(map).length, 2);
    assert.equal(busyForChat(map, "c2")?.run, "r2");
    assert.equal(busyForChat(map, "nope"), null);
  });
});

describe("migrateLegacyStorage", () => {
  it("merges every instance's legacy bucket into the ws keyspace losslessly", () => {
    const s = fakeStorage();
    // inst1: ses1 with 2 msgs, ses2 with 1 msg
    const b1: ChatBucket = {
      openId: "c1",
      items: [chat("c1", "ses_1", ["hi", "there"]), chat("c2", "ses_2", ["solo"])],
    };
    // inst2: same ws/persona — ses1 richer (3 msgs), plus ses3
    const b2: ChatBucket = {
      openId: "c3",
      items: [chat("c3", "ses_1", ["hi", "there", "extra"]), chat("c4", "ses_3", ["other"])],
    };
    s.setItem("klanker.chats.inst1 wsA default", JSON.stringify(b1));
    s.setItem("klanker.chats.inst2 wsA default", JSON.stringify(b2));
    s.setItem("klanker.chats.inst1 wsB scout", JSON.stringify({ openId: "c9", items: [chat("c9", "ses_b", ["x"])] }));
    // Unparseable entry must keep its key — never silently dropped.
    s.setItem("klanker.chats.inst3 wsA default", "{not json");

    const r = migrateLegacyStorage(s);
    assert.equal(r.buckets, 3); // inst3 skipped — unparseable

    const wsA = loadBucket("wsA default", s)!;
    const sessions = new Map(wsA.items.map((i) => [i.session, i]));
    assert.equal(sessions.get("ses_1")?.messages.length, 3); // richer wins
    assert.ok(sessions.has("ses_2"));
    assert.ok(sessions.has("ses_3"));
    assert.equal(wsA.items.filter((i) => !i.session && i.draft).length, 0);

    const wsB = loadBucket("wsB scout", s)!;
    assert.equal(wsB.items.length, 1);

    // Landed keys removed; the unparseable one stays.
    assert.equal(s.getItem("klanker.chats.inst1 wsA default"), null);
    assert.equal(s.getItem("klanker.chats.inst1 wsB scout"), null);
    assert.equal(s.getItem("klanker.chats.inst3 wsA default"), "{not json");
  });

  it("re-keys selection and titles, preferring the active instance", () => {
    const s = fakeStorage();
    s.setItem("klanker.sel.local", JSON.stringify({ ws: "wsA", persona: "scout" }));
    s.setItem("klanker.sel.remote", JSON.stringify({ ws: "wsB" }));
    s.setItem("klanker.active", "remote");
    s.setItem(
      "klanker.titles",
      JSON.stringify({ "local wsA default ses_1": "first", "remote wsA default ses_1": "ignored", "wsB scout ses_2": "kept" })
    );

    migrateLegacyStorage(s);
    assert.deepEqual(JSON.parse(s.getItem(LS_SEL)!), { ws: "wsB", persona: "default" });

    const titles = JSON.parse(s.getItem(LS_TITLES)!);
    assert.equal(titles["wsA default ses_1"], "first"); // new-style wins regardless
    assert.equal(titles["wsB scout ses_2"], "kept"); // already ws-shaped key passes through
    assert.equal(s.getItem("klanker.titles"), null);
    assert.equal(s.getItem("klanker.sel.local"), null);
    assert.equal(s.getItem("klanker.sel.remote"), null);
  });

  it("runs once — a second call is a no-op", () => {
    const s = fakeStorage();
    s.setItem("klanker.chats.inst1 wsA default", JSON.stringify({ openId: "c1", items: [chat("c1", "ses_1", ["a"])] }));
    assert.equal(migrateLegacyStorage(s).buckets, 1);
    s.setItem("klanker.chats.inst4 wsA default", JSON.stringify({ openId: "c9", items: [chat("c9", "ses_9", ["late"])] }));
    assert.deepEqual(migrateLegacyStorage(s), { buckets: 0, titles: 0 });
    // The late legacy key is untouched — the flag guards.
    assert.ok(s.getItem("klanker.chats.inst4 wsA default"));
    assert.equal(loadBucket("wsA default", s)?.items.some((i) => i.session === "ses_9"), false);
  });

  it("writes to the klanker.ws.chats. keyspace", () => {
    const s = fakeStorage();
    s.setItem(
      "klanker.chats.inst1 default default",
      JSON.stringify({ openId: "c1", items: [chat("c1", "ses_1", ["hello world"])] })
    );
    migrateLegacyStorage(s);
    assert.ok(s.getItem(chatsKey("default default")));
    assert.equal(s.getItem("klanker.chats.inst1 default default"), null);
  });
});
