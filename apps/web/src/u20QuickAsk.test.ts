import "./testing/domSetup.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { quickAskShortcutFormatError } from "./services/desktopApi.ts";

const src = (path: string) => readFileSync(path, "utf-8");

type InvokeCall = { cmd: string; args?: Record<string, unknown> };

function installTauriMock(invokeCalls: InvokeCall[]) {
  const listeners = new Map<string, (event: { payload?: unknown }) => void>();
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: {
      core: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          invokeCalls.push({ cmd, args });
          if (cmd === "legacy_state") return {};
          if (cmd === "serve_ensure_local") {
            return { state: "running", pid: 4321, owned: true, port: 8787, host: "127.0.0.1", klanker_version: "test", detail: null };
          }
          if (cmd === "secret_get") return "test-token";
          if (cmd === "get_quick_ask_config") return { enabled: true, shortcut: "Alt+Space" };
          return null;
        },
      },
      event: {
        listen: async (name: string, cb: (event: { payload?: unknown }) => void) => {
          listeners.set(name, cb);
          return () => listeners.delete(name);
        },
      },
    },
  });
  return listeners;
}

async function renderInDom(el: React.ReactElement): Promise<{ unmount: () => void }> {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return {
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function setTextareaValue(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  assert.ok(setter, "textarea value setter missing");
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function sse(events: object[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("U20 desktop quick-ask bridge contracts", () => {
  it("validates only the input shape locally and leaves registration truth to Rust", () => {
    assert.equal(quickAskShortcutFormatError("Alt+Space"), null);
    assert.equal(quickAskShortcutFormatError("Ctrl+Shift+K"), null);
    assert.equal(quickAskShortcutFormatError(""), "hotkey is empty");
    assert.equal(quickAskShortcutFormatError("K"), "use a modifier plus a key, e.g. Alt+Space");
    assert.equal(quickAskShortcutFormatError("Alt+"), "hotkey has an empty key or modifier");
  });

  it("wires Tauri quick-ask intents back into DOM events with cleanup", () => {
    const hook = src("src/hooks/useInstances.ts");
    const desktop = src("src/services/desktopApi.ts");
    assert.ok(desktop.includes('focusComposer: "klanker:focus-composer"'), "focus-composer event contract missing");
    assert.ok(desktop.includes('openSession: "klanker:open-session"'), "open-session event contract missing");
    assert.ok(hook.includes("await add(DESKTOP_EVENTS.focusComposer"), "focus-composer Tauri listener missing");
    assert.ok(hook.includes("window.dispatchEvent(new Event(DESKTOP_EVENTS.focusComposer))"), "focus-composer DOM re-dispatch missing");
    assert.ok(hook.includes("await add(DESKTOP_EVENTS.openSession"), "open-session Tauri listener missing");
    assert.ok(hook.includes("new CustomEvent(DESKTOP_EVENTS.openSession, { detail: ev.payload })"), "open-session payload re-dispatch missing");
    assert.ok(hook.includes("for (const off of unlisteners.splice(0)) off()"), "listener cleanup missing");
  });

  it("keeps quick-ask, splash, and hotkey OS glue in the thin Rust shell", () => {
    const quick = src("../desktop/src-tauri/src/quick_ask.rs");
    const splash = src("../desktop/src-tauri/src/splash.rs");
    const lib = src("../desktop/src-tauri/src/lib.rs");
    const conf = src("../desktop/src-tauri/tauri.conf.json");
    for (const needle of [
      'WebviewUrl::App("index.html?view=quick-ask".into())',
      ".inner_size(640.0, 420.0)",
      ".always_on_top(true)",
      ".skip_taskbar(true)",
      ".visible(false)",
      'app.emit("klanker:quick-ask-open", ())',
      'app.emit("klanker:open-session", payload)',
      'WindowEvent::Focused(false)',
      'pub fn get_quick_ask_config',
      'pub fn set_quick_ask_config',
      'pub fn hide_quick_ask',
      'pub fn open_main_session',
    ]) {
      assert.ok(quick.includes(needle), `quick_ask.rs missing ${needle}`);
    }
    assert.ok(splash.includes("data:text/html;charset=utf-8"), "embedded splash data URL missing");
    assert.ok(splash.includes("Duration::from_secs(6)"), "splash 6s safety timeout missing");
    assert.ok(splash.includes("if closer.get_webview_window(SPLASH_LABEL).is_some()"), "timeout must not raise main after React already closed splash");
    assert.ok(splash.includes('pub fn close_splash'), "close_splash command missing");
    for (const cmd of ["get_quick_ask_config", "set_quick_ask_config", "hide_quick_ask", "open_main_session", "close_splash"]) {
      assert.ok(lib.includes(`quick_ask::${cmd}`) || lib.includes(`splash::${cmd}`), `${cmd} not registered`);
    }
    assert.ok(conf.includes('"visible": false'), "main window must stay hidden until splash handoff");
  });

  it("routes ?view=quick-ask without disturbing the main App branch", () => {
    const main = src("src/main.tsx");
    assert.ok(main.includes('get("view") === "quick-ask"'), "query detection missing");
    assert.ok(main.includes("<QuickAskApp />"), "QuickAskApp render branch missing");
    assert.ok(main.includes("<App />"), "main App branch missing");
    assert.ok(main.includes("closeSplash()"), "splash close on React mount missing");
  });

  it("exposes quick-ask toggle and configurable hotkey in the Desktop settings section", () => {
    const settings = src("src/components/SettingsPanel.tsx");
    assert.ok(settings.includes("Quick-Ask overlay"), "toggle label missing");
    assert.ok(settings.includes("Global hotkey"), "hotkey control missing");
    for (const preset of ["Alt+Space", "Ctrl+Shift+K", "Alt+K"]) {
      assert.ok(settings.includes(`"${preset}"`), `${preset} preset missing`);
    }
    assert.ok(settings.includes("getQuickAskConfig"), "config hydration missing");
    assert.ok(settings.includes("setQuickAskConfig"), "config save missing");
    assert.ok(settings.includes("quickAskError"), "validation/registration error display missing");
    assert.ok(settings.includes("bg-surface") && settings.includes("border-subtle") && settings.includes("text-ink-secondary"), "monochrome tokens missing");
  });
});

describe("U20 QuickAskApp live relay flow", () => {
  it("loads selectors, streams markdown, opens the session in main, and handles Escape", async () => {
    localStorage.clear();
    const invokeCalls: InvokeCall[] = [];
    installTauriMock(invokeCalls);
    const { QuickAskApp } = await import("./components/QuickAskApp.tsx");

    const fetches: { url: string; init?: RequestInit }[] = [];
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      fetches.push({ url, init });
      if (url.endsWith("/v1/workspaces")) {
        return new Response(JSON.stringify({ workspaces: [{ id: "alpha", label: "Alpha" }] }), { status: 200 });
      }
      if (url.includes("/v1/personas")) {
        return new Response(JSON.stringify({ personas: [{ id: "nova", name: "Nova" }] }), { status: 200 });
      }
      if (url.endsWith("/v1/chat/stream")) {
        return sse([
          { type: "start", run: "run-test" },
          { type: "delta", text: "Hello" },
          { type: "delta", text: " **world**" },
          { type: "trailer", session: "ses_mock", returncode: 0 },
        ]);
      }
      return new Response("not found", { status: 404 });
    };

    const rendered = await renderInDom(React.createElement(QuickAskApp));
    try {
      await act(async () => new Promise((res) => setTimeout(res, 60)));
      assert.ok(document.body.textContent?.includes("quick ask"), "spotlight chrome missing");
      const textarea = document.querySelector('textarea[aria-label="Quick ask prompt"]') as HTMLTextAreaElement;
      assert.ok(textarea, "auto-focused prompt input missing");

      await act(async () => {
        setTextareaValue(textarea, "draft");
      });
      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      assert.equal(textarea.value, "", "Escape did not clear a non-empty input");
      assert.equal(invokeCalls.some((c) => c.cmd === "hide_quick_ask"), false, "Escape hid the window while input was non-empty");

      await act(async () => {
        setTextareaValue(textarea, "hello quick ask");
        textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await new Promise((res) => setTimeout(res, 60));
      });

      const stream = fetches.find((c) => c.url.endsWith("/v1/chat/stream"));
      assert.ok(stream, "no /v1/chat/stream call captured");
      assert.equal(stream?.init?.method, "POST");
      const body = JSON.parse(String(stream?.init?.body || "{}")) as Record<string, unknown>;
      assert.equal(body.text, "hello quick ask");
      assert.equal(body.workspace, "alpha");
      assert.equal(body.persona, "nova");
      assert.match(String(body.session), /^ses_[a-f0-9]{12}$/);
      assert.ok(String(body.run).length >= 32, "run id missing");
      assert.equal((stream?.init?.headers as Record<string, string>)?.Authorization, "Bearer test-token");
      assert.ok(document.body.textContent?.includes("Hello"), "streamed answer text missing");
      assert.ok(document.querySelector("strong")?.textContent?.includes("world"), "streamed markdown was not rendered");

      const open = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("Open in full app")) as HTMLButtonElement;
      assert.ok(open, "Open in full app action missing");
      await act(async () => {
        open.click();
        await new Promise((res) => setTimeout(res, 20));
      });
      const openCall = invokeCalls.find((c) => c.cmd === "open_main_session");
      assert.ok(openCall, "open_main_session IPC missing");
      assert.equal(openCall.args?.workspace, "alpha");
      assert.equal(openCall.args?.persona, "nova");
      assert.equal(openCall.args?.session, "ses_mock");

      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((res) => setTimeout(res, 20));
      });
      assert.ok(invokeCalls.some((c) => c.cmd === "hide_quick_ask"), "Escape on empty input did not hide quick-ask");
    } finally {
      rendered.unmount();
      (globalThis as { fetch: unknown }).fetch = originalFetch;
    }
  });
});
