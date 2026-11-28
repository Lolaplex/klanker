export type TurnMode = "auto" | "fast" | "agent";
export type ReasoningLevel = "auto" | "off" | "low" | "medium" | "high";
export type AcpPref = { mode?: string; thought_level?: string; speed?: string };

export const TURN_MODE_STORAGE_KEY = "klanker.turnMode";
export const REASONING_STORAGE_KEY = "klanker.reasoning";
export const ACP_PREFS_STORAGE_KEY = "klanker.acpPrefs";

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

export function readReasoningLevel(): ReasoningLevel {
  try {
    const raw = window.localStorage.getItem(REASONING_STORAGE_KEY);
    return raw === "off" || raw === "low" || raw === "medium" || raw === "high" || raw === "auto" ? raw : "auto";
  } catch {
    return "auto";
  }
}

export function writeReasoningLevel(level: ReasoningLevel): void {
  try {
    window.localStorage.setItem(REASONING_STORAGE_KEY, level);
  } catch {}
}

export function readAcpPrefs(): Record<string, AcpPref> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(ACP_PREFS_STORAGE_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, AcpPref> : {};
  } catch {
    return {};
  }
}

export function readAcpPref(provider: string): AcpPref {
  return readAcpPrefs()[provider] || {};
}

export function writeAcpPref(provider: string, patch: AcpPref): AcpPref {
  const prefs = readAcpPrefs();
  const next = { ...(prefs[provider] || {}), ...patch };
  for (const k of Object.keys(next) as (keyof AcpPref)[]) if (!next[k]) delete next[k];
  prefs[provider] = next;
  try {
    window.localStorage.setItem(ACP_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
  return next;
}
