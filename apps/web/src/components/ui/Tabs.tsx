import React from "react";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";

/**
 * Monochrome tabs on @base-ui/react (klanker#162 U07): arrow-key
 * navigation, role=tablist/tab/tabpanel + aria wiring from the primitive.
 */
export function Tabs({
  value,
  onValueChange,
  tabs,
  ariaLabel,
  tabClassName,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: React.ReactNode }[];
  ariaLabel?: string;
  tabClassName?: string;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onValueChange(v as string)}>
      <BaseTabs.List aria-label={ariaLabel} className="flex items-center justify-start gap-1 border-b border-subtle px-1 overflow-x-auto overflow-y-hidden no-scrollbar">
        {tabs.map((t) => (
          <BaseTabs.Tab
            key={t.value}
            value={t.value}
            className={tabClassName || "px-2.5 py-2 text-[11px] shrink-0 uppercase tracking-wider whitespace-nowrap text-ink-muted hover:text-ink-primary data-[selected]:text-ink-primary border-b-2 border-transparent data-[selected]:border-accent cursor-pointer outline-none focus-visible:text-ink-primary -mb-px"}
          >
            {t.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}
