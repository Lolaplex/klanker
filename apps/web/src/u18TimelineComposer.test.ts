import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { applyLiveTurnEvent, stepsFromSessionEvents, usageFromTurnEvent, ToolTimeline } from "./components/ToolTimeline.tsx";
import { mentionQuery, slashMatches, SLASH_COMMANDS } from "./components/PowerComposer.tsx";

async function htmlOf(el: React.ReactElement): Promise<string> {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return document.body.innerHTML;
}

describe("U18 ordered tool timeline projection", () => {
  it("keeps historical tool_call/file_edit/llm_call/error rows in trace order", () => {
    const steps = stepsFromSessionEvents([
      { type: "message", ts: "2026-01-01T00:00:00Z" },
      { type: "tool_call", ts: "2026-01-01T00:00:01Z", tool: "read", args: { path: "a" }, status: "ok", duration_ms: 5, result: "ok" },
      { type: "file_edit", ts: "2026-01-01T00:00:02Z", file: "a.ts", lines_added: 3, lines_removed: 1 },
      { type: "llm_call", ts: "2026-01-01T00:00:03Z", model: "m", tokens_in: 10, tokens_out: 4, cost_usd: 0.001 },
      { type: "error", ts: "2026-01-01T00:00:04Z", tool: "write", error: "denied" },
    ] as never);
    assert.deepEqual(steps.map((s) => s.kind), ["tool", "file", "llm", "error"]);
    assert.equal(steps[0].title, "read");
    assert.equal(steps[3].error, "denied");
  });

  it("reduces live tool_start/tool_end into an ordered completed step", () => {
    let steps = applyLiveTurnEvent([], { type: "tool_start", id: "t1", tool: "mcp.terminal", args_preview: "git diff" });
    assert.equal(steps[0].status, "running");
    steps = applyLiveTurnEvent(steps, { type: "tool_end", id: "t1", tool: "mcp.terminal", ok: false, duration_ms: 42, result_preview: "bad", error: "exit 1" });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].durationMs, 42);
    assert.equal(steps[0].result, "bad");
  });

  it("usage uses the real U13 wire fields tokens_in/tokens_out/est_cost_usd", () => {
    const usage = usageFromTurnEvent({ tokensIn: 0, tokensOut: 0, costUsd: 0 }, { type: "usage", tokens_in: 12, tokens_out: 8, est_cost_usd: 0.002, model: "m" });
    assert.deepEqual(usage, { tokensIn: 12, tokensOut: 8, costUsd: 0.002, model: "m" });
  });

  it("renders collapsible steps with status, duration, args and error detail", async () => {
    const html = await htmlOf(React.createElement(ToolTimeline, {
      steps: [{ id: "1", kind: "tool", title: "grep", status: "error", args: "pat", result: "none", error: "exit 2", durationMs: 9 }],
      usage: { tokensIn: 3, tokensOut: 2, costUsd: 0.1, model: "m" },
      defaultOpen: true,
    }));
    assert.ok(html.includes("tool-timeline"));
    assert.ok(html.includes("grep"));
    assert.ok(html.includes("9ms"));
    assert.ok(html.includes("args: pat"));
    assert.ok(html.includes("exit 2"));
    assert.ok(html.includes("5 tok"));
  });
});

describe("U18 power composer contracts", () => {
  it("slash menu exposes retry undo compress plan fork clear", () => {
    assert.deepEqual(SLASH_COMMANDS.map((c) => c.cmd), ["/retry", "/undo", "/compress", "/plan", "/fork", "/clear"]);
    assert.deepEqual(slashMatches("/re").map((c) => c.cmd), ["/retry"]);
    assert.deepEqual(slashMatches("hello /re"), []);
  });

  it("mention query recognizes workspace files, memory and skill suffixes", () => {
    assert.equal(mentionQuery("read @src/app"), "src/app");
    assert.equal(mentionQuery("@memory:arc"), "memory:arc");
    assert.equal(mentionQuery("plain text"), null);
  });

  it("ChatConsole wires live thought text, steer, jump-to-latest, modes and voice controls", () => {
    const cc = readFileSync("src/components/ChatConsole.tsx", "utf-8");
    const pc = readFileSync("src/components/PowerComposer.tsx", "utf-8");
    const ts = readFileSync("src/turnStream.ts", "utf-8");
    assert.ok(ts.includes('TURN_EVENT_NAME = "klanker:turn-event"'));
    assert.ok(cc.includes('ev.type === "thought" && ev.text'));
    assert.ok(!cc.includes("ev.delta"), "thought uses text, not delta");
    assert.ok(cc.includes("jump to latest"));
    assert.ok(cc.includes("klanker:fork-session"), "fork must be an App-owned CustomEvent intent");
    assert.ok(cc.includes("injectSteer"), "steer API call must be owned by ChatConsole");
    assert.ok(pc.includes("isLoading ? \"Steer turn\" : \"Send\""));
    assert.ok(pc.includes("aria-label=\"ACP mode\""));
    assert.ok(pc.includes("refreshProviders"));
    assert.ok(readFileSync("src/services/streamExtrasApi.ts", "utf-8").includes("/v1/providers?refresh=1"));
    assert.ok(pc.includes("transcribeVoice"));
    assert.ok(pc.includes("speakText"));
    assert.ok(readFileSync("src/services/streamExtrasApi.ts", "utf-8").includes("speechSynthesis"), "browser fallback on 503/unconfigured voice");
    assert.ok(pc.includes("data:") && pc.includes("image attachment"), "image thumbnails in composer staging");
    assert.ok(cc.includes("imageCacheRef"), "sent image thumbnail lookup survives attachment clearing");
  });
});
