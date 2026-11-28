export type TurnMode = "auto" | "fast" | "agent";

export const TURN_MODE_STORAGE_KEY = "klanker.turnMode";

export function readTurnMode(): TurnMode {
  try {
    const raw = window.localStorage.getItem(TURN_MODE_STORAGE_KEY);
    return raw === "fast" || raw === "agent" || raw === "auto" ? raw : "auto";
  } catch {
    return "auto";
  }
}

export function writeTurnMode(mode: TurnMode): void {
  try {
    window.localStorage.setItem(TURN_MODE_STORAGE_KEY, mode);
  } catch {}
}
