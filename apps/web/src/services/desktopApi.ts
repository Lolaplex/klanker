/**
 * Desktop-only Tauri bridge for the quick-ask overlay, its configurable
 * global hotkey, and the startup splash. Kept out of services/api.ts so the
 * relay API surface stays host-agnostic.
 */

export interface QuickAskConfig {
  enabled: boolean;
  shortcut: string;
}

export interface OpenMainSessionPayload {
  workspace?: string;
  persona?: string;
  session?: string;
}

/** Native event names shared by the Rust shell, quick-ask window, and the
 *  main-window bridge. Centralized because these strings are a cross-process
 *  contract, not UI copy. */
export const DESKTOP_EVENTS = {
  quickAskOpen: "klanker:quick-ask-open",
  focusComposer: "klanker:focus-composer",
  openSession: "klanker:open-session",
} as const;

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type TauriListen = (
  name: string,
  cb: (event: { payload?: unknown }) => void
) => Promise<() => void>;

function tauriCore(): { invoke?: TauriInvoke } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { __TAURI__?: { core?: { invoke?: TauriInvoke } } }).__TAURI__?.core;
}

function tauriEvents(): { listen?: TauriListen } | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { __TAURI__?: { event?: { listen?: TauriListen } } }).__TAURI__?.event;
}

export function isDesktopRuntime(): boolean {
  return typeof tauriCore()?.invoke === "function";
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const call = tauriCore()?.invoke;
  if (!call) return Promise.reject(new Error("not a tauri host"));
  return call(cmd, args) as Promise<T>;
}

/** Cheap input-shape gate only. The Rust command remains the authority —
 *  it parses with the same global-shortcut implementation that registers it. */
export function quickAskShortcutFormatError(shortcut: string): string | null {
  const trimmed = shortcut.trim();
  if (!trimmed) return "hotkey is empty";
  if (!trimmed.includes("+")) return "use a modifier plus a key, e.g. Alt+Space";
  if (trimmed.startsWith("+") || trimmed.endsWith("+") || trimmed.includes("++")) {
    return "hotkey has an empty key or modifier";
  }
  return null;
}

export async function getQuickAskConfig(): Promise<QuickAskConfig> {
  return invoke<QuickAskConfig>("get_quick_ask_config");
}

export async function setQuickAskConfig(enabled: boolean, shortcut: string): Promise<QuickAskConfig> {
  return invoke<QuickAskConfig>("set_quick_ask_config", { enabled, shortcut });
}

export async function hideQuickAsk(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke<void>("hide_quick_ask");
}

export async function openMainSession(payload: OpenMainSessionPayload): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke<void>("open_main_session", {
    workspace: payload.workspace || undefined,
    persona: payload.persona || undefined,
    session: payload.session || undefined,
  });
}

export async function closeSplash(): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke<void>("close_splash");
}

/** Subscribe to a desktop broadcast event. Resolves to a safe no-op outside
 *  Tauri so quick-ask tests and browser dev rendering need no branch noise. */
export async function listenDesktopEvent(
  name: string,
  cb: (event: { payload?: unknown }) => void
): Promise<() => void> {
  const listen = tauriEvents()?.listen;
  if (!listen) return () => {};
  return listen(name, cb);
}
