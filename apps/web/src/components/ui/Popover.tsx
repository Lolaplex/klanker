import React from "react";
import { Popover as BasePopover } from "@base-ui/react/popover";

/**
 * Monochrome popover shell on @base-ui/react (klanker#162 U07): Esc close,
 * outside-click close, focus management and positioning come from the
 * primitive. The trigger is fully caller-owned; the popup is a styled
 * dark panel.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  widthClass = "w-64",
  align = "end",
  side = "bottom",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactElement;
  children: React.ReactNode;
  widthClass?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner className="z-[70]" sideOffset={4} align={align} side={side}>
          <BasePopover.Popup
            className={`${widthClass} border border-strong bg-surface rounded-md shadow-lg font-mono text-xs outline-none`}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
