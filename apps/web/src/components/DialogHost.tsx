import React, { useEffect, useState, useSyncExternalStore } from "react";
import { currentDialog, resolveDialog, subscribeDialogs } from "../services/dialogs";
import { Dialog } from "./ui/Dialog";

export const DialogHost: React.FC = () => {
  const pending = useSyncExternalStore(subscribeDialogs, currentDialog, () => null);
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(pending?.req.kind === "prompt" ? pending.req.value || "" : "");
  }, [pending]);

  const req = pending?.req;
  const ok = () => resolveDialog(req?.kind === "prompt" ? value : true);
  const cancel = () => resolveDialog(req?.kind === "prompt" ? null : false);

  // ui/Dialog owns Esc-close, focus trap and the backdrop (klanker#170
  // U16) — the host only renders the dynamic confirm/prompt body.
  return (
    <Dialog open={!!pending} onClose={cancel} title={req?.kind === "prompt" ? "INPUT" : "CONFIRM"}>
      {req && (
        <form
          className="p-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            ok();
          }}
        >
          <p className="text-ink-primary whitespace-pre-wrap break-words">{req.message}</p>
          {req.kind === "prompt" && (
            <input
              type="text"
              autoFocus
              placeholder={req.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
            />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              className="px-3 py-2 rounded-md border border-strong text-ink-secondary hover:text-ink-primary transition-colors"
            >
              {req.cancelLabel || "Cancel"}
            </button>
            <button
              type="submit"
              className={`px-3 py-2 rounded-md border transition-colors ${
                req.danger
                  ? "border-red-900 text-red-400 hover:bg-red-950"
                  : "border-strong text-ink-primary hover:bg-hover"
              }`}
            >
              {req.okLabel || "OK"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
};
