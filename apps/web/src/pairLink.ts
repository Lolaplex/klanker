/**
 * Connect/pair input parsing — one field, two credential forms:
 *
 *  - absolute pair link `https://relay/#pair=<token>` (scanned or pasted;
 *    the relay's stored mode decides what redeem returns)
 *  - `<code>@<host>` typed form: 8-char pair code (dash optional) + host,
 *    host with or without scheme — guessed http on loopback/private,
 *    https elsewhere
 *
 * Pure functions: no DOM, no fetch — runs under node --test.
 */

export interface PairTarget {
  /** Scheme+authority only, no path — e.g. `https://relay.example:8443`. */
  origin: string;
  /** Pair token or display code — redeem accepts either. */
  credential: string;
}

const CODE_ONLY_RE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;
const CODE_AT_RE = /^([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})\s*@\s*(\S+)$/;
const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;
const PRIVATE_SUFFIX_RE = /\.(local|lan|internal|ts\.net)(:\d+)?$/i;

/** Loopback/RFC1918/suffix hosts are plain http; a public name implies the
 *  TLS proxy. A bare public serve must type its own scheme. */
export function guessScheme(host: string): string {
  return PRIVATE_HOST_RE.test(host) || PRIVATE_SUFFIX_RE.test(host) ? "http" : "https";
}

const LOOPBACK_HOST_RE = /^(localhost|127\.|\[?::1\]?)/i;

/** True when ``origin`` points at this device only — a link no other host
 *  can use. LAN/tailnet addresses are NOT loopback: peers on the same
 *  network can still reach them. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOST_RE.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Normalize an 8-char pair code to the dashed display form. Non-code
 *  input (e.g. a case-sensitive pair token) passes through untouched. */
export function normCode(code: string): string {
  const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : code.trim();
}

export function parsePairInput(raw: string): PairTarget | null {
  const input = (raw || "").trim();
  if (!input) return null;

  // Pair link: `scheme://…#pair=<cred>` (fragment may carry more keys).
  const hashIdx = input.indexOf("#");
  if (hashIdx > 0) {
    try {
      const url = new URL(input.slice(0, hashIdx));
      if (url.protocol === "http:" || url.protocol === "https:") {
        const m = /(?:^|&)pair=([^&]+)/.exec(input.slice(hashIdx + 1));
        if (m?.[1]) return { origin: url.origin, credential: decodeURIComponent(m[1]) };
      }
    } catch {
      // fall through to code@host
    }
    return null;
  }

  const m = CODE_AT_RE.exec(input);
  if (m) {
    const rawHost = m[2].trim();
    let origin: string;
    if (/^https?:\/\//i.test(rawHost)) {
      try {
        origin = new URL(rawHost).origin;
      } catch {
        return null;
      }
    } else {
      const host = rawHost.replace(/\/.*$/, "");
      if (!host) return null;
      origin = `${guessScheme(host)}://${host}`;
    }
    return { origin, credential: normCode(m[1]) };
  }

  return null;
}

/** Bare pair code — only valid once a peer is picked in the connect sheet. */
export function parseBareCode(raw: string): string | null {
  const t = (raw || "").trim();
  return CODE_ONLY_RE.test(t) ? normCode(t) : null;
}

// --- hash classification (AuthGate redeem gate, klanker#151) ---------------
//
// Pair/invite links all resolve to `#pair=<token>` fragments, but the
// stored mode is server-side: a ws-share or remote invite redeemed in a
// browser mints a device credential and burns the single-use token
// without ever issuing a cookie. Markers (`ws=`, `kind=`, `mode=`) are
// the only client-visible hint, so the gate is: bare fragment -> redeem,
// marked fragment -> ask first. Both separators are accepted —
// `#ws=a&pair=t` and the double-hash `#ws=a#pair=t` forms.

export type PairHashAction =
  | { kind: "none" }
  /** Bare web-session link — safe to auto-redeem for the cookie. */
  | { kind: "auto"; token: string }
  /** Device/workspace invite — confirmation prompt before any redeem. */
  | { kind: "confirm"; token: string; ws: string; mode: string };

const DEVICE_MARKERS = new Set(["ws", "remote", "device", "hub"]);

/** Parse a location hash into key/value pairs; `&` and `#` both split. */
export function parseHashParams(hash: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = (hash || "").replace(/^#/, "").trim();
  if (!clean) return out;
  for (const part of clean.split(/[&#]/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    try {
      val = decodeURIComponent(val);
    } catch {}
    if (key && val && !out.has(key)) out.set(key, val);
  }
  return out;
}

/** Decide what a `#…` fragment may trigger on load. Pure — no redeem. */
export function classifyPairHash(hash: string): PairHashAction {
  const params = parseHashParams(hash);
  const token = params.get("pair") || "";
  if (!token) return { kind: "none" };
  const ws = params.get("ws") || "";
  const marker = (params.get("kind") || params.get("mode") || "").toLowerCase();
  if (ws || DEVICE_MARKERS.has(marker)) {
    return { kind: "confirm", token, ws, mode: marker || (ws ? "ws" : "") };
  }
  return { kind: "auto", token };
}

// --- invite link resolution -------------------------------------------------

/** Resolve a minted invite `pair_url` (absolute or root-relative) into a
 *  full link plus a loopback flag. `baseUrl` is the relay the invite was
 *  minted on — localRelayBaseUrl() on desktop, location.origin on PWA. */
export function resolveInviteUrl(pairUrl: string, baseUrl: string): { url: string; loopback: boolean } {
  const raw = (pairUrl || "").trim();
  const base = (baseUrl || "").trim().replace(/\/+$/, "");
  const url = raw.startsWith("/") && base ? `${base}${raw}` : raw;
  return { url, loopback: isLoopbackOrigin(url) };
}
