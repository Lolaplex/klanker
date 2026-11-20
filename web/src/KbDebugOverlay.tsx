import React, { useEffect, useReducer, useRef } from "react";

const PROBE_STYLE: React.CSSProperties = {
  position: "absolute",
  visibility: "hidden",
  pointerEvents: "none",
  height: "env(safe-area-inset-bottom, 0px)",
  width: 0,
  top: 0,
  left: 0,
};

/**
 * iOS PWA keyboard forensics: live readout of every number the keyboard
 * heuristics in App.tsx consume (viewport heights, kb shell state, composer
 * edge) plus the env(safe-area-inset-bottom) probe. DOM facts only — mounted
 * as a separate root by main.tsx so it can never skew the app layout it
 * measures (pointer-events: none, no layout impact).
 */
export function KbDebugOverlay() {
  const [, force] = useReducer((c: number) => c + 1, 0);
  const sabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    const tick = () => force();
    const t = window.setInterval(tick, 250);
    vv?.addEventListener("resize", tick);
    vv?.addEventListener("scroll", tick);
    window.addEventListener("resize", tick);
    window.addEventListener("focusin", tick, true);
    window.addEventListener("focusout", tick, true);
    return () => {
      window.clearInterval(t);
      vv?.removeEventListener("resize", tick);
      vv?.removeEventListener("scroll", tick);
      window.removeEventListener("resize", tick);
      window.removeEventListener("focusin", tick, true);
      window.removeEventListener("focusout", tick, true);
    };
  }, []);

  const vv = window.visualViewport;
  const shell = document.querySelector<HTMLElement>("[data-kb]");
  const composer = document.querySelector<HTMLElement>(".composer");
  const rect = composer?.getBoundingClientRect();
  const vvh = getComputedStyle(document.documentElement).getPropertyValue("--vvh").trim() || "unset";
  const rows: [string, string][] = [
    ["innerH", String(Math.round(window.innerHeight))],
    ["vv.h", vv ? String(Math.round(vv.height)) : "n/a"],
    ["vv.top", vv ? String(Math.round(vv.offsetTop)) : "n/a"],
    ["data-kb", shell?.dataset.kb ?? "idle"],
    ["kb-lock", document.documentElement.dataset.kbLock ?? "0"],
    ["sab", `${sabRef.current?.clientHeight ?? 0}px`],
    ["cmp.bot", rect ? String(Math.round(rect.bottom)) : "n/a"],
    ["--vvh", vvh],
  ];

  return (
    <div
      data-kbdebug=""
      style={{
        position: "fixed",
        left: 4,
        bottom: 4,
        zIndex: 99999,
        padding: "4px 6px",
        background: "rgba(0,0,0,0.85)",
        border: "1px solid #333",
        borderRadius: 4,
        color: "#4ade80",
        font: "10px/1.5 monospace",
        pointerEvents: "none",
        whiteSpace: "pre",
      }}
    >
      <div ref={sabRef} style={PROBE_STYLE} aria-hidden />
      {rows.map(([k, v]) => `${k.padEnd(8)} ${v}`).join("\n")}
    </div>
  );
}
