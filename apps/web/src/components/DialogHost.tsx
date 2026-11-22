import React, { useEffect, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { currentDialog, resolveDialog, subscribeDialogs } from "../services/dialogs";

export const DialogHost: React.FC = () => {
  const pending = useSyncExternalStore(subscribeDialogs, currentDialog, () => null);
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(pending?.req.kind === "prompt" ? pending.req.value || "" : "");
  }, [pending]);

  if (!pending) return null;
  const { req } = pending;
  const ok = () => resolveDialog(req.kind === "prompt" ? value : true);
  const cancel = () => resolveDialog(req.kind === "prompt" ? null : false);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={cancel}
    >
      <div
        className="modal-card flex flex-col bg-[#0a0a0a] border border-[#262626] w-full max-w-sm rounded-lg shadow-2xl overflow-hidden font-mono text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider">
            {req.kind === "prompt" ? "INPUT" : "CONFIRM"}
          </span>
          <button
            type="button"
            onClick={cancel}
            className="inline-flex h-11 w-11 items-center justify-center text-[#737373] hover:text-white transition-colors"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          className="p-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            ok();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
          }}
        >
          <p className="text-[#d4d4d4] whitespace-pre-wrap break-words">{req.message}</p>
          {req.kind === "prompt" && (
            <input
              type="text"
              autoFocus
              placeholder={req.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none"
            />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              className="px-3 py-2 rounded border border-[#262626] text-[#a3a3a3] hover:text-white hover:border-[#404040] transition-colors"
            >
              {req.cancelLabel || "Cancel"}
            </button>
            <button
              type="submit"
              className={`px-3 py-2 rounded border transition-colors ${
                req.danger
                  ? "border-red-900 text-red-400 hover:bg-red-950"
                  : "border-[#404040] text-white hover:bg-[#1a1a1a]"
              }`}
            >
              {req.okLabel || "OK"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
