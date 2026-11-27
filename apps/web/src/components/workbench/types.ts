export interface WorkbenchDetail {
  title: string;
  body: string;
  diff?: string;
  truncated?: boolean;
}

export type WorkbenchTabId = "changes" | "files" | "traces" | "bg" | "data" | "detail";

export interface WorkbenchTabProps {
  openDetail: (detail: WorkbenchDetail, activate?: boolean) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}
