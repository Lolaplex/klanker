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

/** True when ``origin`` points at this device — a link no other device can use. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return PRIVATE_HOST_RE.test(new URL(origin).hostname);
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
