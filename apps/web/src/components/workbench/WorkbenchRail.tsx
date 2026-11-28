import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";
import type { KlankerInstance } from "../../types/klanker";
import { useThemeMode } from "../../theme";
import { shortId } from "../../wsShare";
import { Tabs } from "../ui/Tabs";
import type { WorkbenchDetail, WorkbenchTabId } from "./types";
import { BgTab, ChangesTab, DataTab, FilesTab, TracesTab } from "./tabs";

const TABS: { value: WorkbenchTabId; label: string }[] = [
  { value: "changes", label: "Changes" },
  { value: "files", label: "Files" },
  { value: "traces", label: "Traces" },
  { value: "bg", label: "Terminal" },
  { value: "data", label: "Memory" },
  { value: "detail", label: "Detail" },
];

const clampRailWidth = (n: number) => Math.max(320, Math.min(640, Math.round(n)));

/** Right-side workbench rail (klanker#167): workspace-scoped operator
 *  surface over the U14 management routes. */
export function WorkbenchRail({
  instance,
  workspace,
  session,
  sessionTitle,
  onClose,
  notify,
  width = 420,
  onResize,
  tab: controlledTab,
  onTabChange,
  detail: controlledDetail,
  onDetailChange,
}: {
  instance: KlankerInstance;
  workspace: string;
  session: string;
  sessionTitle?: string;
  onClose: () => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
  width?: number;
  onResize?: (width: number) => void;
  tab?: WorkbenchTabId;
  onTabChange?: (tab: WorkbenchTabId) => void;
  detail?: WorkbenchDetail | null;
  onDetailChange?: (detail: WorkbenchDetail | null) => void;
}) {
  const [innerTab, setInnerTab] = useState<WorkbenchTabId>("changes");
  const [innerDetail, setInnerDetail] = useState<WorkbenchDetail | null>(null);
  const [innerWidth, setInnerWidth] = useState(() => clampRailWidth(width));
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resizeRef = useRef<(width: number) => void>(() => {});
  const tab = controlledTab ?? innerTab;
  const detail = controlledDetail === undefined ? innerDetail : controlledDetail;
  const railWidth = clampRailWidth(onResize ? width : innerWidth);
  const setWidth = onResize ?? ((n: number) => setInnerWidth(clampRailWidth(n)));
  resizeRef.current = setWidth;
  const setTab = (next: WorkbenchTabId) => {
    if (controlledTab === undefined) setInnerTab(next);
    onTabChange?.(next);
  };
  const setDetailState = (next: WorkbenchDetail | null) => {
    if (controlledDetail === undefined) setInnerDetail(next);
    onDetailChange?.(next);
  };
  const openDetail = (next: WorkbenchDetail, activate = true) => {
    setDetailState(next);
    if (activate) setTab("detail");
  };
  const tabProps = { instance, workspace, session, openDetail, notify };
  const sessionLabel = session ? (sessionTitle?.trim() && sessionTitle.trim() !== session ? sessionTitle.trim() : shortId(session)) : "";
  const [visitedTabs, setVisitedTabs] = useState<Set<WorkbenchTabId>>(() => new Set([tab]));

  useEffect(() => {
    setVisitedTabs(new Set([tab]));
  }, [instance.id, workspace]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setVisitedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [tab]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      resizeRef.current(clampRailWidth(start.width + (start.x - e.clientX)));
    };
    const up = () => { drag.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  return (
    <aside
      data-testid="workbench-rail"
      style={{ "--workbench-width": `${railWidth}px` } as CSSProperties}
      className="fixed inset-0 z-50 flex w-full flex-col border-l border-subtle bg-surface font-mono text-xs md:relative md:z-auto md:w-[var(--workbench-width)] md:min-w-[320px] md:max-w-[640px] md:shrink-0"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workbench"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, width: railWidth };
          e.preventDefault();
        }}
        className="absolute left-0 top-0 z-20 hidden h-full w-2 cursor-col-resize hover:bg-strong md:block"
      />
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-subtle px-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-dim">workbench</div>
          <div className="truncate text-[11px] text-ink-primary" title={session || undefined}>{workspace || "default"}{sessionLabel ? ` · ${sessionLabel}` : ""}</div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close workbench" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-dim hover:bg-hover hover:text-ink-primary">
          <X className="h-4 w-4" />
        </button>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as WorkbenchTabId)} ariaLabel="Workbench sections" tabs={TABS} tabClassName="px-2.5 py-2 text-[11px] shrink-0 whitespace-nowrap text-ink-muted hover:text-ink-primary data-[selected]:text-ink-primary border-b-2 border-transparent data-[selected]:border-accent cursor-pointer outline-none focus-visible:text-ink-primary -mb-px" />
      <div key={`${instance.id}:${workspace}`} className="min-h-0 flex-1 overflow-hidden">
        {(visitedTabs.has("changes") || tab === "changes") && (
          <div hidden={tab !== "changes"} className="h-full min-h-0 overflow-hidden" data-testid="workbench-pane-changes">
            <ChangesTab {...tabProps} active={tab === "changes"} openDetail={openDetail} notify={notify} />
          </div>
        )}
        {(visitedTabs.has("files") || tab === "files") && (
          <div hidden={tab !== "files"} className="h-full min-h-0 overflow-hidden" data-testid="workbench-pane-files">
            <FilesTab {...tabProps} active={tab === "files"} openDetail={openDetail} notify={notify} />
          </div>
        )}
        {(visitedTabs.has("traces") || tab === "traces") && (
          <div hidden={tab !== "traces"} className="h-full min-h-0 overflow-hidden" data-testid="workbench-pane-traces">
            <TracesTab {...tabProps} active={tab === "traces"} openDetail={openDetail} notify={notify} />
          </div>
        )}
        {(visitedTabs.has("bg") || tab === "bg") && (
          <div hidden={tab !== "bg"} className="h-full min-h-0 overflow-hidden" data-testid="workbench-pane-bg">
            <BgTab {...tabProps} active={tab === "bg"} openDetail={openDetail} notify={notify} />
          </div>
        )}
        {(visitedTabs.has("data") || tab === "data") && (
          <div hidden={tab !== "data"} className="h-full min-h-0 overflow-hidden" data-testid="workbench-pane-data">
            <DataTab {...tabProps} active={tab === "data"} openDetail={openDetail} notify={notify} />
          </div>
        )}
        {(visitedTabs.has("detail") || tab === "detail") && (
          <div hidden={tab !== "detail"} className="h-full min-h-0 overflow-hidden" data-testid="workbench-pane-detail">
            <DetailTab detail={detail} />
          </div>
        )}
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
