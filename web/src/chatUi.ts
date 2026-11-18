export function shouldSubmitOnEnter(input: {
  key: string;
  shiftKey: boolean;
  composing: boolean;
  coarsePointer: boolean;
}): boolean {
  if (input.key !== "Enter" || input.shiftKey || input.composing) return false;
  return !input.coarsePointer;
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeUrl(url: string | null | undefined): string {
  if (!url) return "";
  const value = url.trim();
  if (!value || /[\u0000-\u001F\u007F]/.test(value)) return "";
  if (value.startsWith("//") || value.startsWith("/\\")) return "";
  if (!value.includes(":")) return value;
  try {
    const protocol = new URL(value).protocol;
    if (!SAFE_PROTOCOLS.has(protocol)) return "";
    return value;
  } catch {
    return "";
  }
}

export function visibleImageSrc(src: string | null | undefined): string {
  const url = safeUrl(src);
  if (!url) return "";
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "http:" || protocol === "https:") return url;
  } catch {
    return "";
  }
  return "";
}

/** Drop the single trailing newline a fenced block keeps, and nothing else. */
export function codeFenceText(raw: string): string {
  return raw.replace(/\n$/, "");
}
