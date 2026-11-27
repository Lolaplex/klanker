import { Switch as BaseSwitch } from "@base-ui/react/switch";

/**
 * Monochrome switch on @base-ui/react (klanker#162 U07): Space toggles,
 * role=switch + aria-checked come from the primitive.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className="inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-[#262626] bg-[#121212] px-0.5 cursor-pointer transition-colors data-[checked]:bg-white data-[checked]:border-white disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:border-white"
    >
      <BaseSwitch.Thumb className="block h-3.5 w-3.5 rounded-full bg-[#737373] transition-transform data-[checked]:translate-x-4 data-[checked]:bg-black" />
    </BaseSwitch.Root>
  );
}
