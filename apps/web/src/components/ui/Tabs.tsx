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
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: React.ReactNode }[];
  ariaLabel?: string;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onValueChange(v as string)}>
      <BaseTabs.List aria-label={ariaLabel} className="flex items-center gap-1 border-b border-[#262626] px-2 overflow-x-auto">
        {tabs.map((t) => (
          <BaseTabs.Tab
            key={t.value}
            value={t.value}
            className="px-2.5 py-2 text-[11px] uppercase tracking-wider whitespace-nowrap text-[#737373] hover:text-white data-[selected]:text-white border-b-2 border-transparent data-[selected]:border-white cursor-pointer outline-none focus-visible:text-white -mb-px"
          >
            {t.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}
