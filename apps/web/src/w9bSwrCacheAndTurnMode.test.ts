import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { api } from "./services/api.ts";
import {
  clearSWRCache,
  fetchSWR,
  invalidateSWR,
  mutateSWR,
  peekSWR,
  swrKey,
  useSWR,
  writeSWR,
} from "./services/swrCache.ts";
import { writeTurnMode } from "./services/turnMode.ts";
import { PowerComposer } from "./components/PowerComposer.tsx";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { WorkbenchRail } from "./components/workbench/WorkbenchRail.tsx";
import type { KlankerInstance } from "./types/klanker.ts";

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function click(el: Element | null) {
  assert.ok(el, "click target missing");
  act(() => {
    (el as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  clearSWRCache();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("W9B universal SWR cache kernel", () => {
  it("peekSWR seeds useState synchronously so first paint has zero loading flash", async () => {
    const key = swrKey("local", "alpha", "test:zero-flash");
    writeSWR(key, "cached rows", { persist: "session" });
    assert.equal(peekSWR<string>(key), "cached rows");
    let seenFirst = "";
    function Probe() {
      const swr = useSWR<string>(key, async () => "network rows", { ttlMs: 60_000 });
      if (!seenFirst) seenFirst = swr.data ? `data:${swr.data}` : swr.isLoading ? "loading" : "empty";
      return React.createElement("div", { "data-testid": "probe" }, seenFirst);
    }
    const r = await renderInDom(React.createElement(Probe));
    try {
      assert.equal(seenFirst, "data:cached rows");
      assert.ok(!seenFirst.includes("loading"), "cached data was replaced by a loading flash");
    } finally {
      r.unmount();
    }
  });

  it("renders stale data during background revalidation and never swaps in a spinner", async () => {
    const key = swrKey("local", "alpha", "test:stale");
    writeSWR(key, "stale rows", { ts: Date.now() - 10_000, persist: "session" });
    let resolveFetch: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => { resolveFetch = resolve; });
    function Probe() {
      const swr = useSWR<string>(key, () => pending, { ttlMs: 10 });
      return React.createElement("div", { "data-testid": "probe" }, `${swr.data || "empty"}|${swr.isLoading ? "loading" : "ready"}|${swr.isRevalidating ? "revalidating" : "idle"}`);
    }
    const r = await renderInDom(React.createElement(Probe));
    try {
      await flush(5);
      const text = () => r.host.textContent || "";
      assert.ok(text().startsWith("stale rows|ready|revalidating"), `stale rows not retained: ${text()}`);
      assert.ok(!text().includes("loading"), "spinner replaced stale rows");
      resolveFetch("fresh rows");
      await flush(20);
      assert.ok(text().startsWith("fresh rows|ready|idle"), `fresh rows did not reconcile: ${text()}`);
    } finally {
      r.unmount();
    }
  });

  it("deduplicates concurrent fetches into one single-flight network promise", async () => {
    const key = swrKey("local", "alpha", "test:single-flight");
    let calls = 0;
    let resolveFetch: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => { resolveFetch = resolve; });
    const fetcher = () => {
      calls += 1;
      return pending;
    };
    const a = fetchSWR(key, fetcher);
    const b = fetchSWR(key, fetcher);
    assert.strictEqual(a, b, "second caller did not receive the same in-flight promise");
    assert.equal(calls, 1);
    resolveFetch("one");
    assert.equal(await a, "one");
    assert.equal(await b, "one");
    assert.equal(calls, 1);
  });

  it("rolls optimistic session rename and delete back to the exact pre-mutation rows", async () => {
    const key = swrKey("local", "alpha", "sessions:default");
    const before = [{ id: "ses_1", title: "old title", host: "host-a" }, { id: "ses_2", title: "keep", host: "host-a" }];
    writeSWR(key, before, { persist: "session" });

    let rejectRename: (e: Error) => void = () => {};
    const rename = mutateSWR(
      key,
      (rows) => (rows ?? []).map((r) => (r.id === "ses_1" ? { ...r, title: "new title" } : r)),
      () => new Promise((_, reject) => { rejectRename = reject; })
    );
    assert.equal(peekSWR<typeof before>(key)?.[0].title, "new title", "rename was not optimistic");
    rejectRename(new Error("backend rejected rename"));
    await assert.rejects(rename, /backend rejected rename/);
    assert.deepEqual(peekSWR<typeof before>(key), before, "rename rollback was not exact");

    let rejectDelete: (e: Error) => void = () => {};
    const del = mutateSWR(
      key,
      (rows) => (rows ?? []).filter((r) => r.id !== "ses_1"),
      () => new Promise((_, reject) => { rejectDelete = reject; })
    );
    assert.deepEqual(peekSWR<typeof before>(key)?.map((r) => r.id), ["ses_2"], "delete was not optimistic");
    rejectDelete(new Error("backend rejected delete"));
    await assert.rejects(del, /backend rejected delete/);
    assert.deepEqual(peekSWR<typeof before>(key), before, "delete rollback was not exact");
  });

  it("silently tolerates malformed and version-mismatched storage envelopes", async () => {
    const key = swrKey("local", "alpha", "test:corrupt");
    window.sessionStorage.setItem(key, "not-json{");
    window.localStorage.setItem(key, JSON.stringify({ v: 99, ts: Date.now(), data: "wrong" }));
    assert.equal(peekSWR(key), undefined);
    const out = await fetchSWR(key, async () => "healed", { persist: "session" });
    assert.equal(out, "healed");
    assert.equal(peekSWR(key), "healed");
  });

  it("evicts oldest mirrored entries cleanly when sessionStorage quota is exceeded", async () => {
    const victim = swrKey("local", "quota", "files:victim");
    const freshKey = swrKey("local", "quota", "files:fresh");
    window.sessionStorage.setItem(victim, JSON.stringify({ v: 1, ts: 1, data: { old: true } }));
    const proto = Object.getPrototypeOf(window.sessionStorage) as Storage;
    const originalSet = proto.setItem;
    let thrown = false;
    proto.setItem = function (key: string, value: string) {
      if (key === freshKey && !thrown) {
        thrown = true;
        throw new DOMException("quota", "QuotaExceededError");
      }
      return originalSet.call(this, key, value);
    };
    try {
      await fetchSWR(freshKey, async () => ({ fresh: true }), { persist: "session" });
    } finally {
      proto.setItem = originalSet;
    }
    assert.equal(window.sessionStorage.getItem(victim), null);
    const raw = window.sessionStorage.getItem(freshKey) || "";
    assert.ok(raw.includes('"fresh":true'));
  });

  it("strips secrets and tokens while preserving non-secret provider metadata", () => {
    const key = swrKey("local", "alpha", "test:secrets");
    writeSWR(key, {
      secret: "plain-secret-value",
      api_key: "plain-api-key",
      access_token: "plain-token",
      nested: { password: "plain-password", bearer_token: "plain-bearer" },
      key_env: "LLM_API_KEY",
      key_configured: true,
      model: "safe-model",
    }, { persist: "session" });
    const cached = peekSWR<Record<string, unknown>>(key)!;
    assert.equal(cached.secret, undefined);
    assert.equal(cached.api_key, undefined);
    assert.equal(cached.access_token, undefined);
    assert.deepEqual(cached.nested, {});
    assert.equal(cached.key_env, "LLM_API_KEY");
    assert.equal(cached.key_configured, true);
    assert.equal(cached.model, "safe-model");
    const raw = window.sessionStorage.getItem(key) || "";
    for (const forbidden of ["plain-secret-value", "plain-api-key", "plain-token", "plain-password", "plain-bearer"]) {
      assert.ok(!raw.includes(forbidden), `secret material leaked into storage: ${forbidden}`);
    }
  });
});

describe("W9B keep-alive workbench panes", () => {
  it("keeps visited tab state mounted, suspends inactive invalidation refresh, and revives at 0ms", async () => {
    const fx = stubFetch((url) => {
      if (url.includes("/git")) return { ok: true, is_git: true, branch: "main", repo: "repo", worktree: "", dirty_files: [], wip_unpushed: false, diff: "", diff_truncated: false };
      if (url.includes("/files/grep")) return { ok: true, path: ".", matches: [], truncated: false };
      if (url.includes("/files/read")) return { ok: true, path: "a.ts", offset: 1, limit: 2000, line_count: 1, truncated: false, content: "x", encoding: "utf-8" };
      if (url.includes("/files")) return { ok: true, path: ".", entries: [{ name: "a.ts", type: "file", size: 1 }] };
      if (url.includes("/stats")) return { ok: true, workspace: "alpha", stats: { total_tokens: 0, tokens_in: 0, tokens_out: 0, est_cost_usd: 0, sessions_count: 0, tool_calls_total: 0, tool_success_rate: 0, file_edits_count: 0, lines_added: 0, lines_removed: 0, top_tools: [], top_errors: [] } };
      if (url.includes("/doctor")) return { ok: true, checks: [], failed: 0, warned: 0 };
      if (url.includes("/bg")) return { ok: true, sessions: [] };
      if (url.includes("/memory")) return { ok: true, files: [] };
      if (url.includes("/skills")) return { ok: true, skills: [] };
      if (url.includes("/approvals/allowlist")) return { ok: true, patterns: [] };
      if (url.includes("/store")) return { ok: true, supported: false, items: [] };
      return { ok: true };
    });
    const r = await renderInDom(React.createElement(WorkbenchRail, { instance: inst, workspace: "alpha", session: "", onClose: () => {}, notify: () => {} }));
    try {
      await flush(50);
      const tabByText = (text: string) => Array.from(document.querySelectorAll("[role='tab']")).find((el) => el.textContent === text) || null;
      click(tabByText("Files"));
      await flush(60);
      const filesCalls = () => fx.calls.filter((c) => c.url.includes("/files?") || c.url.includes("/files?workspace")).length;
      const baseline = filesCalls();
      assert.ok(baseline >= 1, "files tree did not load");
      const input = document.querySelector("input[aria-label='Search files']") as HTMLInputElement | null;
      assert.ok(input, "grep input missing");
      act(() => setInputValue(input, "needle"));
      await flush(5);

      click(tabByText("Changes"));
      await flush(30);
      const filesPane = document.querySelector("[data-testid='workbench-pane-files']") as HTMLElement | null;
      assert.ok(filesPane, "visited files pane was unmounted");
      assert.equal(filesPane.hidden, true, "inactive files pane is not hidden");
      assert.equal((document.querySelector("input[aria-label='Search files']") as HTMLInputElement | null)?.value, "needle", "grep query was not preserved while hidden");

      act(() => invalidateSWR(swrKey("local", "alpha", "files:tree:.")));
      await flush(50);
      assert.equal(filesCalls(), baseline, "hidden pane revalidated while inactive");

      click(tabByText("Files"));
      await flush(60);
      assert.equal((document.querySelector("input[aria-label='Search files']") as HTMLInputElement | null)?.value, "needle", "grep query lost on reactivation");
      assert.ok(filesCalls() > baseline, "reactivated stale pane did not revalidate exactly once awake");
      assert.equal((document.querySelector("[data-testid='workbench-pane-files']") as HTMLElement | null)?.hidden, false);
    } finally {
      r.unmount();
      fx.restore();
    }
  });
});

describe("W9B turn mode and tier wire", () => {
  it("sends turn_mode on /v1/chat/stream and parses the tier SSE frame", async () => {
    const sse = [
      'data: {"type":"start","run":"run_1"}',
      'data: {"type":"tier","tier":"fast","mode":"fast"}',
      'data: {"type":"delta","text":"hello"}',
      'data: {"type":"trailer","session":"ses_1","returncode":0}',
      "",
    ].join("\n\n");
    const fx = stubFetch(() => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    try {
      const events: Record<string, unknown>[] = [];
      for await (const ev of api.streamChat(inst, { text: "hi", run: "run_1", turn_mode: "fast" })) events.push(ev as Record<string, unknown>);
      assert.equal(fx.calls.length, 1);
      assert.ok(fx.calls[0].url.endsWith("/v1/chat/stream"));
      assert.equal(JSON.parse(String(fx.calls[0].init?.body)).turn_mode, "fast");
      assert.deepEqual(events.find((e) => e.type === "tier"), { type: "tier", tier: "fast", mode: "fast" });
      assert.ok(events.some((e) => e.type === "delta" && e.text === "hello"));
    } finally {
      fx.restore();
    }
  });

  it("persists the composer mode pill selection in localStorage", async () => {
    const textareaRef = React.createRef<HTMLTextAreaElement>();
    const fileRef = React.createRef<HTMLInputElement>();
    const r = await renderInDom(React.createElement(PowerComposer, {
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
      textareaRef,
      fileRef,
      isLoading: false,
      sendHold: false,
      displaySpeaker: "klanker",
      session: "ses_1",
      workspace: "alpha",
      persona: "default",
    }));
    try {
      click(document.querySelector("[data-turn-mode='fast']"));
      await flush(5);
      assert.equal(window.localStorage.getItem("klanker.turnMode"), "fast");
      writeTurnMode("agent");
      await flush(5);
      assert.equal(window.localStorage.getItem("klanker.turnMode"), "agent");
    } finally {
      r.unmount();
    }
  });

  it("renders the relay tier as a subtle monochrome assistant metadata tag", () => {
    const html = renderToStaticMarkup(React.createElement(ChatConsole, {
      instance: inst,
      title: "alpha · default",
      speakerName: "klanker",
      input: "",
      onInput: () => {},
      onSendMessage: () => {},
      onStop: () => {},
      isLoading: false,
      sendHold: false,
      pending: null,
      deciding: false,
      decideError: null,
      onDecide: () => {},
      messages: [{ id: "a1", role: "klanker", content: "fast answer", timestamp: "2026-01-01T00:00:00Z", tier: "fast", turn_mode: "fast" }],
    } as never));
    assert.ok(html.includes('data-testid="turn-tier"'), "tier tag missing");
    assert.ok(html.includes("fast"), "tier text missing");
    assert.ok(html.includes("border-subtle"), "tier tag is not monochrome-subtle");
    const app = readFileSync("src/App.tsx", "utf-8");
    assert.ok(app.includes("turn_mode: readTurnMode()"), "App does not pass turn_mode");
    assert.ok(app.includes('ev.type === "tier"'), "App does not consume tier SSE");
  });
});

describe("W9B sidebar craft", () => {
  it("uses zero-layout-shift inline rename typography and 120ms hover prefetch wiring", () => {
    const src = readFileSync("src/components/KlankerList.tsx", "utf-8");
    assert.ok(src.includes("font-mono text-[11px] leading-normal"), "rename input does not inherit row typography");
    assert.ok(src.includes("border-b border-strong"), "rename input misses crisp monochrome underline");
    assert.ok(src.includes('setRenameText(s.label); setRenaming("");'), "Escape does not restore the prior title");
    assert.ok(src.includes("}, 120);"), "hover prefetch is not debounced to 120ms");
    assert.ok(src.includes("onPointerEnter={() => schedulePrefetch"), "session rows lack hover prefetch");
    assert.ok(src.includes("onPointerDown={() => schedulePrefetch"), "session rows lack pointerdown warmup");
    const app = readFileSync("src/App.tsx", "utf-8");
    assert.ok(app.includes("onPrefetchSession={tree.prefetchSession}"), "App does not wire hover prefetch");
  });
});
