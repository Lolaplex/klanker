import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";
import type { KlankerInstance } from "../../types/klanker";
import { useThemeMode } from "../../theme";
import { Tabs } from "../ui/Tabs";
import type { WorkbenchDetail, WorkbenchTabId } from "./types";
import { BgTab, ChangesTab, DataTab, FilesTab, TracesTab } from "./tabs";

const TABS: { value: WorkbenchTabId; label: string }[] = [
  { value: "changes", label: "Changes" },
  { value: "files", label: "Files" },
  { value: "traces", label: "Traces & Usage" },
  { value: "bg", label: "BG Terminal" },
  { value: "data", label: "Data & Memory" },
  { value: "detail", label: "Detail" },
];

/** Right-side workbench rail (klanker#167): workspace-scoped operator
 *  surface over the U14 management routes. */
export function WorkbenchRail({
  instance,
  workspace,
  session,
  onClose,
  notify,
}: {
  instance: KlankerInstance;
  workspace: string;
  session: string;
  onClose: () => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const [tab, setTab] = useState<WorkbenchTabId>("changes");
  const [detail, setDetail] = useState<WorkbenchDetail | null>(null);
  const openDetail = (next: WorkbenchDetail, activate = true) => {
    setDetail(next);
    if (activate) setTab("detail");
  };
  const tabProps = { instance, workspace, session, openDetail, notify };

  return (
    <aside data-testid="workbench-rail" className="fixed inset-0 z-50 flex w-full flex-col border-l border-strong bg-surface font-mono text-xs md:static md:z-auto md:w-[420px] md:shrink-0">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-strong px-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-dim">workbench</div>
          <div className="truncate text-[11px] text-ink-primary">{workspace || "default"}{session ? ` · ${session}` : ""}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close workbench" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-dim hover:bg-hover hover:text-ink-primary">
          <X className="h-4 w-4" />
        </button>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as WorkbenchTabId)} ariaLabel="Workbench sections" tabs={TABS} />
      <div key={`${instance.id}:${workspace}`} className="min-h-0 flex-1 overflow-hidden">
        {tab === "changes" && (session ? <ChangesTab {...tabProps} openDetail={openDetail} notify={notify} /> : <div className="p-4 text-ink-dim">open a session to inspect its git worktree</div>)}
        {tab === "files" && <FilesTab {...tabProps} openDetail={openDetail} notify={notify} />}
        {tab === "traces" && <TracesTab {...tabProps} openDetail={openDetail} notify={notify} />}
        {tab === "bg" && <BgTab {...tabProps} openDetail={openDetail} notify={notify} />}
        {tab === "data" && <DataTab {...tabProps} openDetail={openDetail} notify={notify} />}
        {tab === "detail" && <DetailTab detail={detail} />}
      </div>
    </aside>
  );
}

function DetailTab({ detail }: { detail: WorkbenchDetail | null }) {
  const { resolvedMode } = useThemeMode();
  const options = useMemo(() => ({
    theme: (resolvedMode === "light" ? "github-light" : "github-dark") as "github-light" | "github-dark",
    diffStyle: "unified" as const,
    lineDiffType: "none" as const,
    overflow: "scroll" as const,
  }), [resolvedMode]);
  if (!detail) return <div className="p-4 text-ink-dim">select a file, diff, log, memory document or skill to inspect it here</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-subtle px-3 py-2">
        <div className="truncate text-[11px] font-semibold text-ink-primary" title={detail.title}>{detail.title}</div>
        {detail.truncated && <div className="text-[9px] uppercase tracking-wider text-amber-500">truncated</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {detail.diff ? (
          <div className="workbench-diff text-[12px] [&_pre]:!bg-transparent">
            <PatchDiff patch={detail.diff} options={options} disableWorkerPool />
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-secondary">{detail.body || "(empty)"}</pre>
        )}
      </div>
    </div>
  );
}
