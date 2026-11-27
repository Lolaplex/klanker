import React from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

/**
 * Monochrome dialog shell on @base-ui/react (klanker#162 U07): Esc close,
 * focus trap, aria wiring come from the primitive; styling stays
 * #0a0a0a / #262626 / font-mono.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  /** max-w-md default; wide bumps to max-w-2xl. */
  wide?: boolean;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[60] bg-black/70" />
        <BaseDialog.Viewport className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <BaseDialog.Popup
            className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} bg-surface border border-strong rounded-lg font-mono text-xs flex flex-col max-h-[90vh] outline-none`}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-strong shrink-0">
              <BaseDialog.Title className="text-ink-primary tracking-wider uppercase truncate">
                {title}
              </BaseDialog.Title>
              <BaseDialog.Close
                aria-label="Close"
                className="text-ink-dim hover:text-ink-primary cursor-pointer"
              >
                <X className="w-4 h-4" />
              </BaseDialog.Close>
            </div>
            {children}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
