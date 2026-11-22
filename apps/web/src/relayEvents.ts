/** Pure parsers for relay SSE events, hash pairing, and store API responses. */
import type { RelayEvent, StoreItem, StoreListResult } from "./types/klanker";

/** Parse an SSE chunk (multiple lines terminated by blank line) into typed RelayEvents. */
export function parseSseChunk(chunk: string): RelayEvent[] {
  const out: RelayEvent[] = [];
  for (const frame of chunk.split(/\r?\n\r?\n/)) {
    let eventName = "";
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join("\n")) as Partial<RelayEvent>;
      const kind = String(parsed.kind || eventName || "").trim();
      if (!kind) continue;
      out.push({
        id: Number(parsed.id ?? 0),
        kind,
        workspace: String(parsed.workspace || ""),
        ts: Number(parsed.ts ?? 0),
        payload:
          parsed.payload && typeof parsed.payload === "object"
            ? (parsed.payload as Record<string, unknown>)
            : {},
      });
    } catch {
      // Ignore malformed frames without breaking the stream loop.
    }
  }
  return out;
}

/** Extract single-use pairing token from URL fragment ``#pair=<token>``. */
export function extractPairTokenFromHash(hash: string): string | null {
  const clean = (hash || "").replace(/^#/, "").trim();
  if (!clean) return null;
  for (const part of clean.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "pair" && val) {
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return null;
}

/** Normalize GET /v1/workspaces/<ws>/store/items HTTP responses (501 -> unsupported). */
export function parseStoreListResponse(status: number, bodyText: string): StoreListResult {
  if (status === 501) {
    return { supported: false, items: [] };
  }
  if (status < 200 || status >= 300) {
    let msg = bodyText;
    try {
      const j = JSON.parse(bodyText) as { error?: string; detail?: string };
      msg = j.error || j.detail || bodyText;
    } catch {}
    throw new Error(`${status}${msg ? `: ${String(msg).slice(0, 300)}` : ""}`);
  }
  try {
    const parsed = JSON.parse(bodyText) as { items?: StoreItem[] };
    return {
      supported: true,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
  } catch {
    return { supported: true, items: [] };
  }
}
