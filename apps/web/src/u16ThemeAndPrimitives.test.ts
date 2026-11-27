import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ThemeRoot } from "./ThemeRoot.tsx";
import { useThemeMode, setThemePreference, readThemePreference, applyResolvedMode } from "./theme.ts";
import { Dialog } from "./components/ui/Dialog.tsx";

// U16 oracle (klanker#170): theme switching propagates everywhere, zero
// hardcoded surface hexes, every modal on ui/Dialog with working Escape,
// no global 44px touch rule.

async function renderInDom(el: React.ReactElement): Promise<{ html: () => string; unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(el);
  });
  return {
    html: () => document.body.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function ThemeProbe({ onMode }: { onMode: (m: string) => void }) {
  const { resolvedMode } = useThemeMode();
  onMode(resolvedMode);
  return null;
}

describe("theme switching propagates", () => {
  it("toggling dark ↔ light updates dataset.theme, meta theme-color and the resolved mode", async () => {
    const modes: string[] = [];
    const r = await renderInDom(
      React.createElement(ThemeRoot, null, React.createElement(ThemeProbe, { onMode: (m) => modes.push(m) }))
    );
    try {
      await act(async () => {
        setThemePreference("dark");
      });
      assert.equal(document.documentElement.dataset.theme, "dark");
      assert.equal((document.querySelector('meta[name="theme-color"]') as HTMLMetaElement)?.content, "#000000");

      await act(async () => {
        setThemePreference("light");
      });
      assert.equal(document.documentElement.dataset.theme, "light");
      assert.equal((document.querySelector('meta[name="theme-color"]') as HTMLMetaElement)?.content, "#ffffff");
      assert.ok(modes.includes("light"), `theme root never saw light mode: ${modes.join(",")}`);
      assert.ok(modes.includes("dark"), `theme root never saw dark mode: ${modes.join(",")}`);

      await act(async () => {
        setThemePreference("dark");
      });
    } finally {
      r.unmount();
      setThemePreference("dark");
    }
  });

  it("preference persists to localStorage and resolves system", () => {
    setThemePreference("light");
    assert.equal(localStorage.getItem("klanker.theme"), "light");
    assert.equal(readThemePreference(), "light");
    setThemePreference("system");
    assert.equal(readThemePreference(), "system");
    setThemePreference("dark");
  });

  it("applyResolvedMode sets the html class in lockstep with the dataset", () => {
    applyResolvedMode("light");
    assert.ok(document.documentElement.classList.contains("light"));
    assert.ok(!document.documentElement.classList.contains("dark"));
    applyResolvedMode("dark");
    assert.ok(document.documentElement.classList.contains("dark"));
    assert.ok(!document.documentElement.classList.contains("light"));
  });
});

describe("dynamic renderer wiring (source-checked)", () => {
  it("MermaidBlock renders neutral in light, dark in dark — no static singleton theme", () => {
    const src = readFileSync("src/components/MermaidBlock.tsx", "utf-8");
    assert.ok(src.includes('resolvedMode === "light" ? "neutral" : "dark"') || src.includes('mode === "light" ? "neutral" : "dark"'), "mermaid theme not mode-driven");
    assert.ok(src.includes("useThemeMode"), "MermaidBlock does not consume useThemeMode");
  });

  it("ApprovalReview binds @pierre/diffs to github-light/github-dark by mode", () => {
    const src = readFileSync("src/components/ApprovalReview.tsx", "utf-8");
    assert.ok(src.includes('"github-light"'), "github-light missing");
    assert.ok(src.includes('"github-dark"'), "github-dark missing");
    assert.ok(src.includes("useThemeMode"), "ApprovalReview does not consume useThemeMode");
  });

  it("KlankerMark uses css variables, zero hardcoded fills", () => {
    const src = readFileSync("src/components/KlankerMark.tsx", "utf-8");
    assert.ok(!src.includes('fill="#ffffff"') && !src.includes('fill="#000000"'), "hardcoded fills remain");
    assert.ok(src.includes("var(--accent)"), "accent var missing");
  });
});

describe("zero hardcoded surface hexes in components", () => {
  it("no bg-[#0 / bg-[#1 surface classes remain in any component", () => {
    const files = readdirSync("src/components").filter((f) => f.endsWith(".tsx"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(`src/components/${f}`, "utf-8");
      const hits = src.match(/bg-\[#[01][0-9a-fA-F]{5}\]/g);
      if (hits) offenders.push(`${f}: ${hits.join(",")}`);
    }
    assert.deepEqual(offenders, [], `hardcoded surface hexes remain:\n${offenders.join("\n")}`);
  });

  it("no bg-[#0 / bg-[#1 surface classes remain in App.tsx", () => {
    const src = readFileSync("src/App.tsx", "utf-8");
    assert.ok(!/bg-\[#[01][0-9a-fA-F]{5}\]/.test(src), "hardcoded surface hex in App.tsx");
  });

  it("index.html no longer hard-locks class=dark", () => {
    const src = readFileSync("index.html", "utf-8");
    assert.ok(!src.includes('<html lang="en" class="dark">'), "dark lock still present");
  });
});

describe("modal primitive consolidation", () => {
  const MODALS = [
    "SettingsPanel",
    "WorkspaceModal",
    "NewKlankerModal",
    "PairModal",
    "PersonaEditorModal",
    "DialogHost",
  ];

  it("every modal imports ui/Dialog and drops the fixed inset-0 overlay shell", () => {
    for (const m of MODALS) {
      const src = readFileSync(`src/components/${m}.tsx`, "utf-8");
      assert.ok(src.includes('from "./ui/Dialog"'), `${m} does not use ui/Dialog`);
      assert.ok(!src.includes('fixed inset-0 z-'), `${m} still renders its own overlay shell`);
    }
  });

  it("ui/Dialog closes on Escape", async () => {
    let closed = false;
    const r = await renderInDom(
      React.createElement(Dialog, { open: true, onClose: () => (closed = true), title: "test" },
        React.createElement("div", null, "body"))
    );
    try {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((res) => setTimeout(res, 30));
      });
      assert.ok(closed, "Escape did not close the dialog");
    } finally {
      r.unmount();
    }
  });

  it("the three tab bars consume ui/Tabs", () => {
    for (const [path, needle] of [
      ["src/components/SettingsPanel.tsx", 'from "./ui/Tabs"'],
      ["src/components/WorkspaceModal.tsx", 'from "./ui/Tabs"'],
      ["src/components/workbench/WorkbenchRail.tsx", 'from "../ui/Tabs"'],
    ] as const) {
      const src = readFileSync(path, "utf-8");
      assert.ok(src.includes(needle), `${path} does not use ui/Tabs`);
    }
  });

  it("boolean toggles consume ui/Switch", () => {
    for (const f of ["SettingsPanel", "WorkspaceModal", "ProvidersPanel", "WsManageTabs"]) {
      const src = readFileSync(`src/components/${f}.tsx`, "utf-8");
      assert.ok(src.includes('from "./ui/Switch"'), `${f} does not use ui/Switch`);
    }
  });
});

describe("44px touch rule removal", () => {
  it("index.css no longer enforces global min-width/min-height 44px on input/button", () => {
    const src = readFileSync("src/index.css", "utf-8");
    const block = src.match(/@media \(hover: none\) \{[\s\S]*?\n  \}/);
    assert.ok(block, "hover:none media block missing entirely");
    const body = block![0];
    assert.ok(!/button,?\s*\n?\s*\[role="button"\]/.test(body), "global button/input targeting still present");
    assert.ok(body.includes(".touch-target"), "explicit .touch-target utility missing");
  });
});

describe("no OpenUI runtime coupling", () => {
  it("package.json carries zero @openuidev/ dependencies", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const offenders = deps.filter((d) => d.startsWith("@openuidev/"));
    assert.deepEqual(offenders, [], `openuidev packages remain: ${offenders.join(",")}`);
  });

  it("zero @openuidev/ imports anywhere under src/", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (/\.tsx?$/.test(entry)) {
          const src = readFileSync(p, "utf-8");
          if (/from\s+["']@openuidev\/|import\s+["']@openuidev\//.test(src)) offenders.push(p);
        }
      }
    };
    walk("src");
    assert.deepEqual(offenders, [], `openuidev imports remain:\n${offenders.join("\n")}`);
  });
});
