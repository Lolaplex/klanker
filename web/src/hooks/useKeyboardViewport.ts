import { useEffect, useState } from "react";
import { STANDALONE } from "../chatBuckets";
import { focusWithoutScroll } from "../chatUi";

/**
 * iOS keyboard/viewport geometry. Returns `idleH` (the shell's full height)
 * and `kbBox` ({height, top}) while the keyboard is open — the app shell
 * animates between them. Handles installed-PWA height lies, first-tap
 * scroll interception, and the kb-height cache in localStorage.
 */
export function useKeyboardViewport(): { kbBox: { height: number; top: number } | null; idleH: number } {
  const [kbBox, setKbBox] = useState<{ height: number; top: number } | null>(null);
  const [idleH, setIdleH] = useState<number>(() =>
    typeof window !== "undefined"
      ? STANDALONE
        ? window.screen.height || window.innerHeight
        : window.innerHeight
      : 844
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const TEXT_INPUT_TYPES = new Set([
      "text",
      "search",
      "email",
      "url",
      "tel",
      "password",
      "number",
    ]);

    const isTextEditable = (el: EventTarget | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
      if (el instanceof HTMLInputElement) {
        return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
      }
      return el.isContentEditable;
    };

    const editableFocused = () => isTextEditable(document.activeElement);

    // Installed iOS PWAs lie about heights: window.innerHeight shrinks on the
    // first keyboard open and never restores, and vv.height under-reports by
    // the safe-area insets. Probe the real full height via a hidden 100vh el.
    const probeFullHeight = () => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;top:0;left:0;height:100vh;visibility:hidden;pointer-events:none";
      document.documentElement.appendChild(probe);
      const h = probe.offsetHeight;
      probe.remove();
      return h || window.innerHeight;
    };

    let fullHeight = STANDALONE ? probeFullHeight() : window.innerHeight;
    setIdleH(fullHeight);
    let lastWidth = window.innerWidth;
    let settle = 0;
    let unlockTimer = 0;
    let focusInAt = -10000;

    const kbStoreKey = (baseH: number) =>
      `klanker.kbh.${STANDALONE ? "pwa" : "web"}.${Math.round(baseH)}`;
    const readLastKbH = (baseH: number) => {
      try {
        const raw = window.localStorage.getItem(kbStoreKey(baseH));
        const n = raw ? Number(raw) : 0;
        if (n >= 160 && n < baseH - 100) return n;
      } catch {
        /* private mode */
      }
      return Math.max(180, Math.round(baseH - (STANDALONE ? (baseH < 500 ? 200 : 376) : 290)));
    };
    const saveLastKbH = (baseH: number, h: number) => {
      try {
        window.localStorage.setItem(kbStoreKey(baseH), String(Math.round(h)));
      } catch {
        /* private mode */
      }
    };
    let lastKbH = readLastKbH(fullHeight);

    const setStandaloneLock = (lock: boolean) => {
      if (!STANDALONE) return;
      const root = document.documentElement;
      if (lock) {
        window.clearTimeout(unlockTimer);
        if (root.dataset.kbLock !== "1") root.dataset.kbLock = "1";
      } else if (root.dataset.kbLock) {
        delete root.dataset.kbLock;
      }
    };

    const clampScroll = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    const sync = () => {
      clampScroll();
      if (vv.scale > 1.01) return;
      // --vvh feeds modal/sheet max-height (dvh does not shrink for the iOS keyboard).
      document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
      if (window.innerWidth !== lastWidth) {
        lastWidth = window.innerWidth;
        fullHeight = STANDALONE ? probeFullHeight() : window.innerHeight;
        setIdleH(fullHeight);
        lastKbH = readLastKbH(fullHeight);
      }
      const focused = editableFocused();
      const covered = fullHeight - (vv.height + vv.offsetTop);
      const vvShrunk = covered > 100 || vv.offsetTop > 100;
      if (!STANDALONE && (!focused || !vvShrunk) && Math.abs(vv.height - window.innerHeight) < 20) {
        fullHeight = window.innerHeight;
        setIdleH(fullHeight);
      }
      if (focused && vvShrunk && vv.height >= 160) {
        lastKbH = Math.round(vv.height);
        saveLastKbH(fullHeight, lastKbH);
      }
      const touchLayout =
        window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches;
      const openingWindow =
        focused &&
        touchLayout &&
        performance.now() - focusInAt < 450;
      const keyboardOpen = focused && (vvShrunk || openingWindow);
      const targetH = vvShrunk ? Math.round(vv.height) : lastKbH;
      const settledTop =
        !STANDALONE &&
        vv.offsetTop > 4 &&
        performance.now() - focusInAt >= 360
          ? Math.round(vv.offsetTop)
          : 0;
      if (focused || keyboardOpen) {
        setStandaloneLock(true);
      }
      setKbBox((prev) => {
        const next = keyboardOpen ? { height: targetH, top: settledTop } : null;
        if (prev === next) return prev;
        if (prev && next && prev.height === next.height && prev.top === next.top)
          return prev;
        return next;
      });
    };

    let tap: { el: HTMLElement; id: number; x: number; y: number } | null = null;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        tap = null;
        return;
      }
      const target = e.target;
      if (isTextEditable(target) && document.activeElement !== target) {
        const t = e.touches[0];
        tap = { el: target, id: t.identifier, x: t.clientX, y: t.clientY };
        if (STANDALONE) setStandaloneLock(true);
      } else {
        tap = null;
      }
    };

    const onTouchCancel = () => {
      tap = null;
    };

    // Intercept qualified first-taps on unfocused mobile inputs (react-aria /
    // futo-notes / tweb pattern): prevent native touch-focus scroll & pan, then
    // lift off-screen for focus({ preventScroll: true }) + double-rAF restore.
    const onTouchEnd = (e: TouchEvent) => {
      const cur = tap;
      tap = null;
      if (!cur || e.touches.length > 0 || !cur.el.isConnected) return;
      if (document.activeElement === cur.el) return;
      let match: Touch | null = null;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === cur.id) {
          match = t;
          break;
        }
      }
      if (!match) return;
      if (Math.hypot(match.clientX - cur.x, match.clientY - cur.y) >= 12) {
        if (STANDALONE && !editableFocused()) {
          window.clearTimeout(unlockTimer);
          unlockTimer = window.setTimeout(() => {
            if (!editableFocused()) setStandaloneLock(false);
          }, 120);
        }
        return;
      }
      e.preventDefault();
      if (STANDALONE) setStandaloneLock(true);
      focusWithoutScroll(cur.el);
    };

    const onFocusIn = (e: FocusEvent) => {
      if (isTextEditable(e.target)) {
        focusInAt = performance.now();
        if (STANDALONE) setStandaloneLock(true);
      }
      sync();
      window.clearTimeout(settle);
      settle = window.setTimeout(sync, 460);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (isTextEditable(e.relatedTarget)) return;
      // Trigger the CSS height transition back to idleH immediately at t=0ms
      // so the shell glides down in lockstep with the iOS keyboard, then
      // release kbLock once the slide finishes.
      focusInAt = -10000;
      sync();
      window.clearTimeout(settle);
      settle = window.setTimeout(sync, 460);
      window.clearTimeout(unlockTimer);
      unlockTimer = window.setTimeout(() => {
        if (!editableFocused()) {
          setStandaloneLock(false);
          sync();
        }
      }, STANDALONE ? 340 : 460);
    };

    sync();
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
    document.addEventListener("touchcancel", onTouchCancel, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", clampScroll, { passive: true });
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(unlockTimer);
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchend", onTouchEnd, true);
      document.removeEventListener("touchcancel", onTouchCancel, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", clampScroll);
    };
  }, []);

  return { kbBox, idleH };
}
