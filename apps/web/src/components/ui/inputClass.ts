/** Shared input chrome (klanker#170 U16): one canonical class string for
 *  text inputs / textareas / selects across every modal — semantic tokens
 *  only, so the inverted white mode restyles all inputs in one place. */
export const inputClass =
  "w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none placeholder-ink-dim";

/** Shared uppercase micro-label for form fields. */
export const labelClass = "text-[10px] uppercase tracking-wider text-ink-dim";
