import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "0";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  text,
  label,
  className = "",
  borderless = false,
}: {
  text: string;
  label: string;
  className?: string;
  borderless?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const id = window.setTimeout(() => setState("idle"), 1500);
    return () => window.clearTimeout(id);
  }, [state]);

  const shown = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;

  return (
    <button
      type="button"
      aria-label={shown}
      title={shown}
      onClick={() => {
        void writeClipboard(text).then((ok) => setState(ok ? "copied" : "failed"));
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-md transition-all ${
        borderless
          ? "h-7 w-7 min-h-0 min-w-0 text-ink-muted hover:bg-hover hover:text-ink-primary"
          : "h-11 w-11 border border-strong text-ink-secondary hover:border-accent hover:text-ink-primary"
      } ${state !== "idle" ? "!opacity-100 text-ink-primary" : ""} ${className}`}
    >
      {state === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
