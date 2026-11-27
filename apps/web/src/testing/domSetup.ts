import { JSDOM } from "jsdom";

// Test harness: install a headless DOM BEFORE any component module
// evaluates — @base-ui/react + floating-ui capture the DOM environment
// at module scope, so importing them without a document bakes in the
// no-DOM path and portals never mount. Import this module first.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });

const KEYS = [
  "window", "document", "HTMLElement", "Node", "Element", "navigator",
  "customElements", "DocumentFragment", "MutationObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver",
] as const;

for (const key of KEYS) {
  const v = (dom.window as never)[key];
  Object.defineProperty(globalThis, key, {
    value: typeof v === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key)
      ? (v as (...a: unknown[]) => unknown).bind(dom.window)
      : v,
    configurable: true,
    writable: true,
  });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true, writable: true });
