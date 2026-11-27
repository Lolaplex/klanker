import { useMemo } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, PatchDiff } from "@pierre/diffs/react";
import type { PendingApproval } from "../types/klanker";

/**
 * IDE-grade approval review card (klanker#164 U09): rich U02 preview
 * payloads render as a scrollable syntax-highlighted diff or an expanded
 * command card with risk badge; older spokes fall back to summary||tool.
 * Actions: Deny / Allow once / Allow always (remember:true).
 */

const RISK_STYLE: Record<string, string> = {
  low: "border-white text-white",
  medium: "border-amber-500 text-amber-500",
  high: "border-red-500 text-red-500",
};

function CommandPreview({ argv, cwd, risk }: { argv: string[]; cwd?: string; risk?: string }) {
  const level = risk && risk in RISK_STYLE ? risk : "medium";
  return (
    <div className="mt-2 overflow-hidden rounded border border-[#262626] bg-black">
      <div className="flex items-center justify-between gap-2 border-b border-[#262626] px-2.5 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-[#737373]">command</span>
        <span
          className={`shrink-0 px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wider ${RISK_STYLE[level]}`}
          data-testid="risk-badge"
        >
          {level} risk
        </span>
      </div>
      <pre className="select-text overflow-x-auto p-3 text-[12px] leading-relaxed text-[#e5e5e5] whitespace-pre-wrap break-all">
        {argv.map((a, i) => (
          <span key={i}>
            <span className="text-[#525252] select-none">{i === 0 ? "$ " : "  "}</span>
            {a}
            {"\n"}
          </span>
        ))}
      </pre>
      {cwd && (
        <div className="border-t border-[#1f1f1f] px-3 py-1.5 text-[10px] text-[#737373] break-all">
          cwd · {cwd}
        </div>
      )}
    </div>
  );
}

function DiffPreview({
  path,
  unified,
  oldText,
  newText,
  truncated,
  binary,
  error,
}: {
  path: string;
  unified?: string;
  oldText?: string;
  newText?: string;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}) {
  const diffOptions = useMemo(
    () => ({
      theme: "github-dark" as const,
      diffStyle: "unified" as const,
      lineDiffType: "none" as const,
      overflow: "scroll" as const,
    }),
    []
  );
  // Diff computation is expensive — memoize per content pair, never
  // recompute on approval-poll re-renders.
  const fileDiff = useMemo(
    () =>
      oldText !== undefined || newText !== undefined
        ? parseDiffFromFile(
            { name: path, contents: oldText ?? "" },
            { name: path, contents: newText ?? "" }
          )
        : null,
    [path, oldText, newText]
  );

  return (
    <div className="mt-2 overflow-hidden rounded border border-[#262626] bg-black">
      <div className="flex items-center justify-between gap-2 border-b border-[#262626] px-2.5 py-1.5">
        <span className="truncate font-mono text-[11px] text-white" title={path}>
          {path || "file"}
        </span>
        {truncated && (
          <span className="shrink-0 text-[9px] uppercase tracking-wider text-amber-500">truncated</span>
        )}
      </div>
      {error ? (
        <div className="p-3 text-[11px] text-red-500">diff unavailable: {error}</div>
      ) : binary ? (
        <div className="p-3 text-[11px] text-[#737373]">binary file — no text diff</div>
      ) : unified ? (
        <div className="approval-diff max-h-72 overflow-y-auto text-[12px] [&_pre]:!bg-transparent">
          <PatchDiff patch={unified} options={diffOptions} disableWorkerPool />
        </div>
      ) : oldText !== undefined || newText !== undefined ? (
        <div className="approval-diff max-h-72 overflow-y-auto text-[12px] [&_pre]:!bg-transparent">
          <FileDiff
            fileDiff={fileDiff!}
            options={diffOptions}
            disableWorkerPool
          />
        </div>
      ) : (
        <div className="p-3 text-[11px] text-[#737373]">no diff content</div>
      )}
    </div>
  );
}

export function ApprovalReview({
  pending,
  deciding,
  decideError,
  remoteApprovalLabel = null,
  onDecide,
}: {
  pending: PendingApproval;
  deciding: boolean;
  decideError: string | null;
  /** Remote-turn banner variant: the paused device label. */
  remoteApprovalLabel?: string | null;
  /** (allow, remember) — remember:true is the Allow-always wire flag. */
  onDecide: (allow: boolean, remember?: boolean) => void;
}) {
  const preview = pending.preview;

  return (
    <div className="mx-3 mt-3 border border-[#262626] bg-[#0a0a0a] rounded p-3">
      <div className="text-[10px] uppercase tracking-wider text-[#737373]">
        Approval
        {remoteApprovalLabel && (
          <span className="normal-case"> · remote turn on {remoteApprovalLabel} paused — decide here to resume</span>
        )}
      </div>

      {preview?.kind === "diff" ? (
        <DiffPreview
          path={preview.path}
          unified={preview.unified}
          oldText={preview.old_text}
          newText={preview.new_text}
          truncated={preview.truncated}
          binary={preview.binary}
          error={preview.error}
        />
      ) : preview?.kind === "command" ? (
        <CommandPreview argv={preview.argv} cwd={preview.cwd} risk={preview.risk} />
      ) : (
        <div className="mt-1 text-white whitespace-pre-wrap break-words select-text">
          {pending.summary || pending.tool}
        </div>
      )}

      {(pending.summary || pending.tool) && preview && (
        <div className="mt-1.5 text-[11px] text-[#737373] whitespace-pre-wrap break-words select-text">
          {pending.summary || pending.tool}
        </div>
      )}
      {decideError && <div className="mt-1 text-[11px] text-[#a3a3a3] break-words">{decideError}</div>}

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={deciding}
          onClick={() => onDecide(false)}
          className="inline-flex h-11 items-center px-4 bg-[#141414] hover:bg-[#1f1f1f] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white transition-colors disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={deciding}
          onClick={() => onDecide(true)}
          className="inline-flex h-11 items-center px-4 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded text-[11px] transition-colors"
        >
          Allow once
        </button>
        <button
          type="button"
          disabled={deciding}
          onClick={() => onDecide(true, true)}
          title="Allow and remember this rule — matching future asks skip the prompt"
          className="inline-flex h-11 items-center px-4 bg-[#141414] hover:bg-[#1f1f1f] border border-[#525252] rounded text-[11px] text-white transition-colors disabled:opacity-50"
        >
          Allow always
        </button>
      </div>
    </div>
  );
}
