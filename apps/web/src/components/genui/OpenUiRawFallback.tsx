import { CopyButton } from "../CopyButton";

/** Clean raw-code fallback for malformed, unsafe, or unsupported GenUI. */
export function OpenUiRawFallback({ source, reason }: { source: string; reason?: string | null }) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-strong bg-main">
      <div className="flex items-center justify-between gap-2 border-b border-strong pl-3">
        <span className="truncate text-[10px] uppercase tracking-wider text-ink-muted">
          openui{reason ? ` · ${reason}` : " · raw fallback"}
        </span>
        <CopyButton text={source} label="Copy OpenUI source" borderless className="mr-1" />
      </div>
      <pre className="select-text overflow-x-auto p-3 text-[12px] leading-relaxed text-ink-secondary whitespace-pre-wrap">{source}</pre>
    </div>
  );
}
