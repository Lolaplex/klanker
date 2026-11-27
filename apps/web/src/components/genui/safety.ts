const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const FORBIDDEN_RE = /<\s*(script|iframe|object|embed)\b|(?:javascript|vbscript|data|file)\s*:/i;

/** Strict action URL gate: only absolute http(s) URLs may leave the app. */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().replace(CONTROL_RE, "");
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Coarse source-level refusal for active content or executable/data schemes. */
export function unsafeOpenUiReason(source: string): string | null {
  const normalized = source.replace(CONTROL_RE, "");
  if (FORBIDDEN_RE.test(normalized)) return "unsafe URL scheme or active embed";
  return null;
}
