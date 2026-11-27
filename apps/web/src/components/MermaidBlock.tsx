import { useEffect, useRef, useState } from "react";
import { sanitizeSvg } from "../mermaidSafe";
import { CopyButton } from "./CopyButton";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

/** Lazy singleton — mermaid is heavy, never loaded unless a diagram
 *  actually renders. Strict security level: no htmlLabels, no click
 *  handler execution. */
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((mod) => {
    const m = mod.default;
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "monospace",
    });
    return m;
  });
  return mermaidPromise;
}

let idCounter = 0;

export function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${++idCounter}-${Date.now()}`);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then(async (m) => {
        const { svg: raw } = await m.render(idRef.current, source);
        if (!cancelled) setSvg(sanitizeSvg(raw));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <div className="my-2 overflow-hidden rounded border border-[#262626] bg-black">
      <div className="flex items-center justify-between gap-2 border-b border-[#262626] pl-3">
        <span className="truncate text-[10px] uppercase tracking-wider text-[#737373]">mermaid</span>
        <CopyButton text={source} label="Copy diagram source" borderless className="mr-1" />
      </div>
      {error ? (
        <pre className="select-text overflow-x-auto p-3 text-[12px] leading-relaxed text-[#a3a3a3]">
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
        <div className="p-3 text-[11px] text-[#525252]">rendering diagram…</div>
      )}
    </div>
  );
}
