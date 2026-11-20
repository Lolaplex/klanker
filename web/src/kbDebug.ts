/** `?kbdebug=1` opt-in gate — the overlay stays out of the default path. */
export function kbDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).get("kbdebug") === "1";
}
