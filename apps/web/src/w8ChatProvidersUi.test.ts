import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  ACP_AGENT_PRESETS,
  CURATED_PROVIDER_PRESETS,
  filterVisibleProviders,
  mergeAcpAgentCatalog,
  normalizeAcpAgentRows,
  readShowTestProviders,
  writeShowTestProviders,
} from "./services/providerCatalog.ts";
import type { ProviderRow } from "./types/klanker.ts";

const row = (name: string, kind: string, command = ""): ProviderRow => ({
  name,
  kind,
  command,
  configurable: true,
  source: "file",
} as ProviderRow);

describe("W8 RGB opacity tokens", () => {
  it("defines semantic RGB channels in both themes and keeps raw variables", () => {
    const css = readFileSync("src/index.css", "utf8");
    for (const name of ["--bg-main-rgb", "--bg-surface-rgb", "--success-rgb", "--danger-rgb"]) {
      assert.ok(css.includes(name), `${name} missing`);
    }
    assert.ok(css.includes("--bg-main-rgb: 0 0 0;"), "dark main channel missing");
    assert.ok(css.includes("--bg-main-rgb: 255 255 255;"), "light main channel missing");
    assert.ok(css.includes("--bg-main: rgb(var(--bg-main-rgb));"), "raw variable compatibility missing");
    assert.ok(css.includes(".no-scrollbar"), "no-scrollbar utility missing");
  });

  it("maps Tailwind colors through <alpha-value> so bg-main/95 compiles", () => {
    const cfg = readFileSync("tailwind.config.js", "utf8");
    assert.ok(cfg.includes('main: "rgb(var(--bg-main-rgb) / <alpha-value>)"'));
    assert.ok(cfg.includes('surface: "rgb(var(--bg-surface-rgb) / <alpha-value>)"'));
    assert.ok(cfg.includes('success: "rgb(var(--success-rgb) / <alpha-value>)"'));
    const list = readFileSync("src/components/KlankerList.tsx", "utf8");
    assert.ok(list.includes("bg-main/95"), "known opacity consumer missing");
  });
});

describe("W8 chat streaming, thinking and failure surface", () => {
  it("concatenates thought chunks instead of forcing one word per line", () => {
    const src = readFileSync("src/components/ChatConsole.tsx", "utf8");
    assert.ok(src.includes("setLiveThought((cur) => `${cur}${ev.text}`)"));
    assert.ok(!src.includes('setLiveThought((cur) => `${cur}${cur ? "\n" : ""}${ev.text}`)'));
  });

  it("resets live thinking and timeline state at every new turn", () => {
    const src = readFileSync("src/components/ChatConsole.tsx", "utf8");
    assert.ok(src.includes("if (isLoading && !wasLoadingRef.current)"));
    const block = src.slice(src.indexOf("if (isLoading && !wasLoadingRef.current)"), src.indexOf("wasLoadingRef.current = isLoading"));
    for (const needle of ["setTimelineSteps([])", 'setTimelineScope("latest turn")', 'setLiveThought("")']) {
      assert.ok(block.includes(needle), `${needle} missing from turn-start reset`);
    }
  });

  it("labels latest-turn and session-total timelines distinctly", () => {
    const src = readFileSync("src/components/ChatConsole.tsx", "utf8");
    const timeline = readFileSync("src/components/ToolTimeline.tsx", "utf8");
    assert.ok(src.includes('setTimelineScope("session total")'));
    assert.ok(src.includes("scopeLabel={timelineScope}"));
    assert.ok(timeline.includes("scopeLabel"));
  });

  it("renders a turn-start status immediately before the first SSE frame", () => {
    const src = readFileSync("src/components/ChatConsole.tsx", "utf8");
    assert.ok(src.includes("TurnStatusInline"));
    assert.ok(src.includes('data-testid="turn-start-status"'));
    assert.ok(src.includes('status || "Thinking…"'));
    assert.ok(!src.includes("Connecting…"), "obsolete Connecting label remains");
  });

  it("turn failures are loud error annotations, never masked as (no reply)", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    assert.ok(app.includes("turnFailure = ev.error || lastStatus || `exit code ${ev.returncode}`"));
    assert.ok(app.includes("content: `Turn failed: ${turnFailure}`"));
    assert.ok(app.includes("error: true"));
    assert.ok(app.indexOf("content: `Turn failed: ${turnFailure}`") < app.indexOf('content: "(no reply)"'), "failure branch must run before the no-reply fallback");
    const bubble = readFileSync("src/components/ChatConsole.tsx", "utf8");
    assert.ok(bubble.includes('data-testid="turn-error-message"'));
    assert.ok(bubble.includes("text-danger"));
    const sync = readFileSync("src/chatSync.ts", "utf8");
    assert.ok(sync.includes('m.content.startsWith("Turn failed:")'));
  });
});

describe("W8 provider filtering", () => {
  const rows = [
    row("openrouter", "openai_compat"),
    row("echo", "echo"),
    row("scripted.tool", "scripted.tool"),
    row("scripted", "scripted"),
    row("acp.cursor", "acp"),
    row("acp.devin", "acp-agent", "devin acp"),
  ];

  it("hides echo, scripted fixtures and broken legacy ACP stubs by default", () => {
    assert.deepEqual(filterVisibleProviders(rows, false).map((r) => r.name), ["openrouter", "acp.devin"]);
  });

  it("the legacy show-test preference persists but never exposes fixtures", () => {
    assert.deepEqual(filterVisibleProviders(rows, true).map((r) => r.name), ["openrouter", "acp.devin"]);
    writeShowTestProviders(true);
    assert.equal(readShowTestProviders(), true);
    writeShowTestProviders(false);
    assert.equal(readShowTestProviders(), false);
  });

  it("uses one canonical filter in picker and providers panel", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const panel = readFileSync("src/components/ProvidersPanel.tsx", "utf8");
    assert.ok(app.includes("filterVisibleProviders(r.rows)"));
    assert.ok(panel.includes("filterVisibleProviders(rows, false)"));
    assert.ok(!panel.includes('writeShowTestProviders(value)'), "fixture toggle write path remains");
  });
});

describe("W8 curated provider and ACP catalog", () => {
  it("ships the exact curated model-provider presets", () => {
    const byId = new Map(CURATED_PROVIDER_PRESETS.map((p) => [p.id, p]));
    assert.equal(byId.get("openrouter")?.url, "https://openrouter.ai/api/v1");
    assert.equal(byId.get("openrouter")?.keyEnv, "OPENROUTER_API_KEY");
    assert.equal(byId.get("openai")?.url, "https://api.openai.com/v1");
    assert.equal(byId.get("openai")?.keyEnv, "OPENAI_API_KEY");
    assert.equal(byId.get("gemini")?.url, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(byId.get("gemini")?.keyEnv, "GEMINI_API_KEY");
    assert.equal(byId.get("lmstudio")?.url, "http://127.0.0.1:1234/v1");
    assert.equal(byId.get("lmstudio")?.keyEnv, undefined);
    assert.equal(byId.get("ollama")?.url, "http://127.0.0.1:11434/v1");
    assert.equal(byId.get("ollama")?.keyEnv, undefined);
  });

  it("curated setup writes manifest, secret, probes and refreshes in order in the panel", () => {
    const src = readFileSync("src/components/ProvidersPanel.tsx", "utf8");
    const enable = src.indexOf("const enablePreset");
    const add = src.indexOf("await api.addProvider(instance, {", enable);
    const secret = src.indexOf("await api.setProviderSecret(instance, preset.keyEnv", enable);
    const probe = src.indexOf("await api.probeProvider(instance, preset.id)", enable);
    assert.ok(add >= 0 && secret > add && probe > secret, "preset flow order broken");
    assert.ok(src.includes("load();") && src.includes("onChanged?.();"));
    assert.ok(src.includes('data-testid="curated-provider-setup"'));
  });

  it("ships current ACP presets and merges optional relay detection rows", () => {
    const byId = new Map(ACP_AGENT_PRESETS.map((a) => [a.id, a]));
    assert.equal(byId.get("devin")?.command, "devin acp");
    assert.equal(byId.get("claude")?.command, "npx -y @agentclientprotocol/claude-agent-acp");
    assert.equal(byId.get("codex")?.command, "npx -y @agentclientprotocol/codex-acp");
    const normalized = normalizeAcpAgentRows([{ id: "devin", installed: true, path: "C:/tools/devin.exe" }]);
    assert.equal(normalized[0]?.installed, true);
    const merged = mergeAcpAgentCatalog([{ id: "devin", installed: true, path: "C:/tools/devin.exe" }], true);
    assert.equal(merged.find((a) => a.id === "devin")?.installed, true);
    assert.equal(merged.find((a) => a.id === "codex")?.installed, false);
    const fallback = mergeAcpAgentCatalog(null, false);
    assert.equal(fallback.every((a) => a.detectionUnavailable), true);
  });

  it("ACP one-click flow creates acp.<id> manifests and probes immediately", () => {
    const src = readFileSync("src/components/ProvidersPanel.tsx", "utf8");
    assert.ok(src.includes('const name = `acp.${id}`;'));
    assert.ok(src.includes('kind: "acp-agent", command'));
    assert.ok(src.includes("await api.probeProvider(instance, name)"));
    assert.ok(src.includes("api.listProviderAgents(instance)"));
    assert.ok(src.includes("+ Custom ACP agent…"));
  });
});
