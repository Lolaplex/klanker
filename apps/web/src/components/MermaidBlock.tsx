import { useEffect, useRef, useState } from "react";
import { sanitizeSvg } from "../mermaidSafe";
import { useThemeMode } from "../theme";
import { CopyButton } from "./CopyButton";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

/** Lazy singleton — mermaid is heavy, never loaded unless a diagram
 *  actually renders. Strict security level: no htmlLabels, no click
 *  handler execution. */
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((mod) => mod.default);
  return mermaidPromise;
}

// Mermaid initializes globally — the theme is not a render-time argument,
// so re-initialize whenever the app mode flips (klanker#170 U16). Dark
// mode renders "dark", inverted white renders "neutral" (light grays,
// black ink — the monochrome-faithful light stock theme).
let initializedFor: string | null = null;
function initForMode(m: typeof import("mermaid").default, mode: "dark" | "light") {
  if (initializedFor === mode) return;
  m.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: mode === "light" ? "neutral" : "dark",
    fontFamily: "monospace",
  });
  initializedFor = mode;
}

let idCounter = 0;

export function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${++idCounter}-${Date.now()}`);
  const { resolvedMode } = useThemeMode();

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then(async (m) => {
        initForMode(m, resolvedMode);
        const { svg: raw } = await m.render(idRef.current, source);
        if (!cancelled) setSvg(sanitizeSvg(raw));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [source, resolvedMode]);

  return (
    <div className="my-2 overflow-hidden rounded-md border border-strong bg-main">
      <div className="flex items-center justify-between gap-2 border-b border-strong pl-3">
        <span className="truncate text-[10px] uppercase tracking-wider text-ink-muted">mermaid</span>
        <CopyButton text={source} label="Copy diagram source" borderless className="mr-1" />
      </div>
      {error ? (
        <pre className="select-text overflow-x-auto p-3 text-[12px] leading-relaxed text-ink-secondary">
          {`diagram error: ${error}\n\n${source}`}
        </pre>
      ) : svg ? (
        <div
          className="mermaid-diagram select-text overflow-x-auto p-3 [&_svg]:max-w-full"
          // Sanitized by sanitizeSvg + mermaid strict mode — no scripts,
          // no foreignObject, no event handlers, no javascript: hrefs.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="p-3 text-[11px] text-ink-dim">rendering diagram…</div>
      )}
    </div>
  );
}
