import { useEffect } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

export interface ToastItem {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-[90] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 pointer-events-none" aria-live="polite">
      {toasts.map((t) => <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />)}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.kind === "error" ? 8000 : 4500);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);
  const Icon = toast.kind === "error" ? AlertCircle : toast.kind === "success" ? CheckCircle2 : Info;
  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className="pointer-events-auto flex items-start gap-2 rounded-md border border-strong bg-surface px-3 py-2 shadow-lg font-mono text-[11px] text-ink-primary"
    >
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${toast.kind === "error" ? "text-red-500" : "text-ink-secondary"}`} />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{toast.message}</div>
      <button type="button" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)} className="text-ink-dim hover:text-ink-primary">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
