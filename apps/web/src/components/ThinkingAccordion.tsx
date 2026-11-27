import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Collapsible reasoning accordion (klanker#163 U08): `<think>` content
 * sits above the answer body, elapsed thinking time in the header,
 * live auto-scroll while open and streaming.
 */
export function ThinkingAccordion({
  thinking,
  streaming = false,
}: {
  thinking: string;
  /** Still streaming — elapsed timer ticks and open panel auto-scrolls. */
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startRef = useRef<number>(Date.now());
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!streaming) {
      setElapsed((prev) => prev ?? Date.now() - startRef.current);
      return;
    }
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 250);
    return () => clearInterval(t);
  }, [streaming]);

  useEffect(() => {
    if (open && streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [thinking, open, streaming]);

  const secs = elapsed === null ? null : (elapsed / 1000).toFixed(1);

  return (
    <div className="mb-2 overflow-hidden rounded border border-[#1f1f1f] bg-black">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle thinking"
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wider text-[#737373] hover:text-white transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>thinking{streaming ? "…" : ""}</span>
        {secs !== null && <span className="text-[#525252] normal-case">{secs}s</span>}
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="max-h-48 overflow-y-auto border-t border-[#1f1f1f] px-3 py-2 text-[11px] leading-relaxed text-[#737373] whitespace-pre-wrap break-words"
        >
          {thinking}
        </div>
      )}
    </div>
  );
}
