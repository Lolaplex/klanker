import React from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

/**
 * Monochrome select on @base-ui/react (klanker#162 U07) — replaces every
 * native `<select>`: full keyboard navigation, typeahead, aria wiring.
 */
export function Select({
  value,
  onChange,
  options,
  disabled = false,
  ariaLabel,
  className = "",
  placeholder = "select…",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(v) => onChange(v as string)}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={`w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none flex items-center justify-between gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      >
        <BaseSelect.Value placeholder={placeholder} />
        <BaseSelect.Icon className="text-[#525252]">
          <ChevronDown className="w-3 h-3" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className="z-[70]" sideOffset={4}>
          <BaseSelect.Popup className="min-w-40 max-h-64 overflow-y-auto border border-[#262626] bg-[#0a0a0a] rounded-md shadow-lg font-mono text-xs py-1 outline-none">
            {options.map((o) => (
              <BaseSelect.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="flex items-center gap-2 px-2 py-1.5 min-h-8 text-[#a3a3a3] data-[highlighted]:bg-[#181818] data-[highlighted]:text-white data-[selected]:text-white cursor-pointer outline-none data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
              >
                <BaseSelect.ItemIndicator className="w-4 shrink-0">
                  <Check className="w-3.5 h-3.5" />
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
