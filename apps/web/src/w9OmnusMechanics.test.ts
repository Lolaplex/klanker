import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { createRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { ContextMenuProvider, useContextMenu, type ContextMenuItem } from "./components/ui/ContextMenu.tsx";
import { KlankerList, type SessionRow } from "./components/KlankerList.tsx";
import { Header } from "./components/Header.tsx";
import { PowerComposer } from "./components/PowerComposer.tsx";
import { ChatConsole } from "./components/ChatConsole.tsx";
import { readThemePreference, setThemePreference } from "./theme.ts";
import type { KlankerInstance } from "./types/klanker.ts";

// Wave 9A oracle: Omnus interaction mechanics are transferred while the
// monochrome token system remains Klanker-owned.

const inst = {
  id: "local",
  kind: "local",
  name: "klanker",
  workspace: "",
  endpoint: { base_url: "http://127.0.0.1:8787" },
} as unknown as KlankerInstance;

async function renderInDom(el: React.ReactElement): Promise<{ unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(el);
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function src(path: string): string {
  return readFileSync(path, "utf-8");
}

function contextClick(target: Element, x = 40, y = 40): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y });
  target.dispatchEvent(event);
  return event;
}

function key(keyName: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }));
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement {
  const hit = Array.from(root.querySelectorAll("button")).find((b) => (b.textContent || "").includes(text));
  assert.ok(hit, `button containing ${text} missing`);
  return hit as HTMLButtonElement;
}

const listProps = {
  workspaces: [{ id: "alpha", label: "Alpha", kind: "local" }],
  wsHostsOf: () => undefined,
  personasOf: () => [{ id: "default", name: "Nova", role: "coder" }],
  sessionRowsOf: (): SessionRow[] => [
    { chatId: "c1", session: "ses_one", label: "fix the shell navigation", pending: false, host: "storm", branch: "feat/ui-w9", repo: "Lolaplex/klanker", wip_unpushed: true },
  ],
  selWs: "alpha",
  selPersona: "default",
  openChatId: "c1",
  width: 260,
  collapsed: false,
  onResize: () => {},
  onToggleCollapse: () => {},
  onExpandWs: () => {},
  onExpandPersona: () => {},
  onSelectChat: () => {},
  onNewChat: () => {},
  onDeleteChat: () => {},
  onRenameChat: () => {},
  onForkChat: () => {},
  onNewWorkspace: () => {},
  onDeleteWorkspace: () => {},
  onWorkspaceSettings: () => {},
  onNewPersona: () => {},
  onDeletePersona: () => {},
} as const;

function renderList(extra: Record<string, unknown> = {}) {
  return renderInDom(
    React.createElement(ContextMenuProvider, null,
      React.createElement(KlankerList, { ...listProps, ...extra } as never))
  );
}

describe("W9A motion grammar", () => {
  it("defines the Omnus easing/enter/press utilities with reduced-motion fallbacks", () => {
    const css = src("src/index.css");
    for (const needle of [
      "--ease-out-expo: cubic-bezier(0.22, 1, 0.36, 1)",
      "--ease-menu: cubic-bezier(0.16, 1, 0.3, 1)",
      "--ease-modal: cubic-bezier(0.34, 1.4, 0.64, 1)",
      ".klanker-menu-enter",
      ".klanker-modal-enter",
      ".klanker-backdrop-enter",
      ".klanker-press",
      "scale(0.92)",
      "scale(0.94) translateY(6px)",
      "@media (prefers-reduced-motion: reduce)",
    ]) assert.ok(css.includes(needle), `motion grammar missing ${needle}`);
    assert.ok(src("src/components/ui/Dialog.tsx").includes("klanker-modal-enter"), "dialog modal animation missing");
    assert.ok(src("src/components/ui/Dialog.tsx").includes("klanker-backdrop-enter"), "dialog backdrop animation missing");
    assert.ok(src("src/components/ui/Popover.tsx").includes("klanker-menu-enter"), "popover menu animation missing");
    assert.ok(src("src/components/ui/Select.tsx").includes("klanker-menu-enter"), "select menu animation missing");
  });
});

describe("W9A universal context menu", () => {
  function Probe({ items }: { items: ContextMenuItem[] }) {
    const { openMenu } = useContextMenu();
    return React.createElement("button", {
      type: "button",
      "data-testid": "menu-probe",
      onContextMenu: (e: React.MouseEvent) => openMenu(e, items),
    }, "probe");
  }

  it("opens above the shell, clamps inside the viewport, keyboard-selects, and dismisses", async () => {
    const oldW = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const oldH = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
    const picked: string[] = [];
    const items: ContextMenuItem[] = [
      { id: "first", label: "First action", onSelect: () => picked.push("first") },
      { id: "second", label: "Second action", shortcut: "⌘2", onSelect: () => picked.push("second") },
      { id: "sep", separator: true },
      { id: "danger", label: "Danger action", danger: true, onSelect: () => picked.push("danger") },
    ];
    const r = await renderInDom(React.createElement(ContextMenuProvider, null, React.createElement(Probe, { items })));
    try {
      const probe = document.querySelector('[data-testid="menu-probe"]') as HTMLElement;
      let event!: MouseEvent;
      await act(async () => {
        event = contextClick(probe, 395, 395);
      });
      assert.ok(event.defaultPrevented, "browser context menu was not prevented");
      const menu = document.querySelector('[data-testid="context-menu"]') as HTMLElement;
      assert.ok(menu, "context menu did not open");
      assert.ok(menu.className.includes("z-[90]") || (menu.parentElement?.className || "").includes("z-[90]"), "portal z layer missing");
      assert.ok(menu.className.includes("klanker-menu-enter"), "menu enter animation missing");
      assert.ok(menu.className.includes("bg-surface") && menu.className.includes("border-subtle"), "monochrome surface tokens missing");
      assert.ok(parseFloat(menu.style.left) <= 400 - 180 - 8 + 0.5, `right edge not clamped: ${menu.style.left}`);
      assert.ok(parseFloat(menu.style.top) < 395, `bottom edge not clamped/flipped: ${menu.style.top}`);

      await act(async () => key("ArrowDown"));
      await act(async () => key("Enter"));
      assert.deepEqual(picked, ["second"], "ArrowDown+Enter did not activate the second selectable row");
      assert.ok(!document.querySelector('[data-testid="context-menu"]'), "menu stayed open after selection");

      await act(async () => {
        contextClick(probe, 40, 40);
      });
      await act(async () => key("Escape"));
      assert.ok(!document.querySelector('[data-testid="context-menu"]'), "Escape did not dismiss the menu");

      await act(async () => {
        contextClick(probe, 40, 40);
      });
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      });
      assert.ok(!document.querySelector('[data-testid="context-menu"]'), "outside pointerdown did not dismiss the menu");
    } finally {
      r.unmount();
      if (oldW) Object.defineProperty(window, "innerWidth", oldW);
      if (oldH) Object.defineProperty(window, "innerHeight", oldH);
    }
  });
});

describe("W9A sidebar rail, row menus, rename and focus", () => {
  it("renders the animated 52px monochrome icon rail with required actions and monograms", async () => {
    const r = await renderList({ collapsed: true });
    try {
      const aside = document.querySelector("aside") as HTMLElement;
      assert.equal(aside.dataset.collapsed, "true");
      assert.ok(aside.className.includes("md:w-[52px]"), "52px collapsed width missing");
      assert.ok(aside.className.includes("transition") || aside.style.transition.includes("0.34s"), "340ms width transition missing");
      const rail = document.querySelector('[data-testid="sidebar-icon-rail"]') as HTMLElement;
      assert.ok(rail, "icon rail missing");
      for (const title of ["Expand sidebar (Ctrl/⌘ B)", "Search (⌘K)", "New chat (+)"]) {
        assert.ok(rail.querySelector(`[title="${title}"]`), `${title} rail action missing`);
      }
      assert.equal(rail.querySelector('[title="Settings"]'), null, "bottom rail Settings duplicate remains");
      assert.ok(rail.querySelector('[aria-label="Workspace Alpha"]'), "workspace monogram missing");
    } finally {
      r.unmount();
    }
  });

  it("opens context-sensitive workspace, persona and session menus; session rename is inline", async () => {
    const r = await renderList();
    try {
      const expanded = document.querySelector(".sidebar-expanded-choreo") as HTMLElement;
      assert.ok(expanded, "expanded sidebar missing");

      await act(async () => {
        contextClick(buttonWithText(expanded, "Alpha"));
      });
      let menu = document.querySelector('[data-testid="context-menu"]') as HTMLElement;
      for (const label of ["New chat", "New persona", "Workspace settings", "Share / Invite", "Archive workspace"]) {
        assert.ok((menu.textContent || "").includes(label), `workspace menu missing ${label}`);
      }
      await act(async () => key("Escape"));

      await act(async () => {
        contextClick(buttonWithText(expanded, "Nova"));
      });
      menu = document.querySelector('[data-testid="context-menu"]') as HTMLElement;
      for (const label of ["New chat", "Edit persona", "Archive persona"]) {
        assert.ok((menu.textContent || "").includes(label), `persona menu missing ${label}`);
      }
      await act(async () => key("Escape"));

      const row = document.querySelector('[data-session-row="true"]') as HTMLElement;
      assert.ok(row, "session row missing");
      await act(async () => {
        contextClick(row);
      });
      menu = document.querySelector('[data-testid="context-menu"]') as HTMLElement;
      for (const label of ["Open chat", "Rename inline", "Fork session", "Export Markdown", "Export JSON", "Copy Session ID", "Delete chat"]) {
        assert.ok((menu.textContent || "").includes(label), `session menu missing ${label}`);
      }
      await act(async () => {
        (document.querySelector('[data-menu-item="rename-inline"]') as HTMLButtonElement).click();
      });
      assert.ok(document.querySelector('input[aria-label="Rename chat"]'), "context-menu rename did not enter inline rename");
    } finally {
      r.unmount();
    }
  });

  it("double-click on a session row enters inline rename immediately", async () => {
    const r = await renderList();
    try {
      const rowButton = document.querySelector('[data-session-row="true"] button') as HTMLButtonElement;
      assert.ok(rowButton, "session row button missing");
      await act(async () => {
        rowButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      const input = document.querySelector('input[aria-label="Rename chat"]') as HTMLInputElement;
      assert.ok(input, "double-click did not open inline rename");
      assert.equal(input.value, "fix the shell navigation");
    } finally {
      r.unmount();
    }
  });

  it("scrolls the deep-linked session into view and applies the 1800ms accent ring", async () => {
    const proto = Element.prototype as unknown as { scrollIntoView?: (arg?: unknown) => void };
    const old = proto.scrollIntoView;
    let scrolls = 0;
    proto.scrollIntoView = () => { scrolls += 1; };
    const r = await renderList({ focusSession: { nonce: 1, ws: "alpha", persona: "default", id: "c1" } });
    try {
      await act(async () => new Promise((res) => setTimeout(res, 130)));
      const row = document.querySelector('[data-session-row="true"]') as HTMLElement;
      assert.ok(scrolls > 0, "deep-linked row never scrolled into view");
      assert.ok(row.className.includes("ring-1") && row.className.includes("ring-accent/60"), "1800ms focus ring missing");
    } finally {
      r.unmount();
      if (old) proto.scrollIntoView = old;
      else delete proto.scrollIntoView;
    }
  });

  it("App implements narrow-width auto-collapse with manual narrow expansion override", () => {
    const app = src("src/App.tsx");
    assert.ok(app.includes("SIDEBAR_AUTO_COLLAPSE_WIDTH = 1160"), "1160px auto-collapse threshold missing");
    assert.ok(app.includes("window.innerWidth >= DESKTOP_SIDEBAR_WIDTH"), "mobile widths must not enter desktop auto-collapse");
    assert.ok(app.includes("allowExpandedOnNarrow"), "manual expanded-on-narrow override missing");
    assert.ok(app.includes("setAllowExpandedOnNarrow(false)"), "override reset on narrow re-entry missing");
    assert.ok(app.includes("effectiveSidebarCollapsed"), "auto-collapse is not separated from persisted user collapse");
    assert.ok(app.includes('localStorage.getItem("klanker.sidebar.width")'), "sidebar width persistence missing");
    assert.ok(src("src/components/KlankerList.tsx").includes('transition: isDragging ? "none" :'), "drag-resize does not disable width transition");
  });
});

describe("W9A header declutter", () => {
  it("keeps theme control in Settings while the Header shell stays decluttered", async () => {
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
      assert.equal(document.querySelector('button[aria-label="Toggle dark / white theme"]'), null, "header theme toggle duplicate remains");
      assert.equal(document.querySelector('[aria-label="Theme mode"]'), null, "three-way pill rendered in Header");
      assert.equal(document.querySelector('button[aria-label="Expand sidebar"]'), null, "header expand-sidebar duplicate remains");
    } finally {
      r.unmount();
    }
    const headerSrc = src("src/components/Header.tsx");
    const settingsSrc = src("src/components/SettingsPanel.tsx");
    assert.ok(!headerSrc.includes("ThemeSwitcher compact"), "Header still owns the compact three-way pill");
    assert.ok(!headerSrc.includes("useThemeMode"), "Header still owns theme state");
    assert.ok(settingsSrc.includes("<ThemeSwitcher />"), "Settings three-way ThemeSwitcher missing");
    assert.ok(src("src/App.tsx").includes('label: "Toggle dark / white theme"'), "palette theme command missing");
  });
});

describe("W9A composer drag depth and mention insertion", () => {
  async function renderComposer(input = "") {
    const values: string[] = [];
    const textareaRef = createRef<HTMLTextAreaElement>();
    const fileRef = createRef<HTMLInputElement>();
    const r = await renderInDom(React.createElement(PowerComposer, {
      instance: inst,
      input,
      onInput: (v: string) => values.push(v),
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
      displaySpeaker: "Nova",
      session: "ses_1",
      workspace: "alpha",
      persona: "default",
    } as never));
    return { r, values, textareaRef };
  }

  function fileDrag(type: string): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [] } });
    return event;
  }

  it("uses a nested drag-depth counter so child-element crossing never flickers off", async () => {
    const { r } = await renderComposer();
    try {
      const form = document.querySelector("form") as HTMLFormElement;
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      assert.ok(form && textarea, "composer form or textarea missing");
      await act(async () => {
        form.dispatchEvent(fileDrag("dragenter"));
      });
      assert.ok(form.className.includes("border-accent"), "drop highlight missing after first enter");
      await act(async () => {
        textarea.dispatchEvent(fileDrag("dragenter"));
      });
      await act(async () => {
        textarea.dispatchEvent(fileDrag("dragleave"));
      });
      assert.ok(form.className.includes("border-accent"), "nested child leave flickered the highlight off");
      await act(async () => {
        form.dispatchEvent(fileDrag("dragleave"));
      });
      assert.ok(!form.className.includes("border-accent"), "highlight did not clear at depth zero");
      await act(async () => {
        form.dispatchEvent(fileDrag("dragenter"));
        form.dispatchEvent(fileDrag("drop"));
      });
      assert.ok(!form.className.includes("border-accent"), "drop did not reset drag depth");
    } finally {
      r.unmount();
    }
  });

  it("consumes klanker:insert-mention by appending @path and focusing the composer", async () => {
    const { r, values, textareaRef } = await renderComposer("existing draft");
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent("klanker:insert-mention", { detail: { path: "src/App.tsx" } }));
        await new Promise((res) => setTimeout(res, 10));
      });
      assert.equal(values.at(-1), "existing draft @src/App.tsx ");
      assert.equal(document.activeElement, textareaRef.current, "composer did not regain focus");
    } finally {
      r.unmount();
    }
  });
});

describe("W9A chat and workbench context-sensitive rows", () => {
  it("right-clicking a chat message exposes copy, fork, regenerate and read-aloud actions", async () => {
    const sent: string[] = [];
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify({ events: [] }), { status: 200 });
    const r = await renderInDom(React.createElement(ContextMenuProvider, null,
      React.createElement(ChatConsole, {
        instance: inst,
        speakerName: "Nova",
        messages: [{ id: "m1", role: "klanker", content: "hello **world**", timestamp: new Date().toISOString() }],
        input: "",
        onInput: () => {},
        onSendMessage: (msg: string) => sent.push(msg),
        onStop: () => {},
        isLoading: false,
        sendHold: false,
        sessionLabel: "ses_1",
        workspace: "alpha",
        persona: "default",
        pending: null,
        deciding: false,
        decideError: null,
        onDecide: () => {},
      } as never)));
    try {
      const content = document.querySelector(".klanker-md") as HTMLElement;
      assert.ok(content, "assistant markdown row missing");
      await act(async () => {
        contextClick(content);
      });
      const menu = document.querySelector('[data-testid="context-menu"]') as HTMLElement;
      for (const label of ["Copy Markdown", "Fork from here", "Regenerate", "Read aloud"]) {
        assert.ok((menu.textContent || "").includes(label), `message menu missing ${label}`);
      }
      await act(async () => {
        (document.querySelector('[data-menu-item="regenerate"]') as HTMLButtonElement).click();
      });
      assert.deepEqual(sent, ["/retry"], "message regenerate action did not reuse the retry path");
    } finally {
      r.unmount();
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });

  it("workbench Files and Changes rows expose detail/copy/mention context actions", () => {
    const tabs = src("src/components/workbench/tabs.tsx");
    assert.ok((tabs.match(/onContextMenu=/g) || []).length >= 3, "workbench rows do not wire context menus");
    for (const needle of [
      '"Open in Detail"',
      '"Copy path"',
      '"Mention @path in Composer"',
      '"klanker:insert-mention"',
      "useContextMenu",
    ]) assert.ok(tabs.includes(needle), `workbench context wiring missing ${needle}`);
    assert.ok(src("src/components/PowerComposer.tsx").includes('window.addEventListener("klanker:insert-mention"'), "composer mention listener missing");
  });
});
