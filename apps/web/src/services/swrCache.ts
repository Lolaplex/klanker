import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Universal client-side SWR cache kernel.
 *
 * Memory is the synchronous paint layer; session/local storage is only a
 * bounded accelerator mirror. Server projections remain the truth. The cache
 * never stores bearer tokens, provider secrets or key material: sensitive
 * object fields are stripped before either layer is written.
 */

export type SwrPersist = "session" | "local" | false;

export type SwrOptions<T = unknown> = {
  ttlMs?: number;
  persist?: SwrPersist;
  serialize?: (value: T) => unknown;
  parse?: (raw: unknown) => T | undefined;
  force?: boolean;
};

export type SwrSnapshot<T> = {
  data: T | undefined;
  hasData: boolean;
  error: string;
  ts: number;
  isStale: boolean;
  isRevalidating: boolean;
};

type CacheRecord = {
  data?: unknown;
  hasData: boolean;
  ts: number;
  promise?: Promise<unknown>;
  error?: string;
  revalidating: boolean;
  persist: SwrPersist;
  serialize?: (value: never) => unknown;
  parse?: (raw: unknown) => unknown;
};

type StorageEnvelope = { v: 1; ts: number; data: unknown };

type InvalidationEvent = { target: string; exact: boolean; ts: number };

const ENVELOPE_VERSION = 1;
const DEFAULT_TTL_MS = 30_000;
const MAX_SESSION_ENTRY_BYTES = 512 * 1024;
const CACHE_PREFIX = "klanker:v1:";

const memory = new Map<string, CacheRecord>();
const subscribers = new Map<string, Set<() => void>>();
const invalidationListeners = new Set<(event: InvalidationEvent) => void>();

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const now = () => Date.now();

const SENSITIVE_KEY = /^(secret|api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|bearer[-_]?token|device[-_]?token|password|credential|client[-_]?secret|private[-_]?key|authorization|proxy-authorization)$/i;
const SENSITIVE_SUFFIX = /(?:_secret|_token|_api_key)$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursively drop secret-shaped fields. Provider metadata such as
 *  `key_env`/`key_configured` is intentionally retained — it names a vault
 *  key or boolean presence, never key material. */
export function sanitizeForCache<T>(value: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth > 16) return undefined as T;
  if (seen.has(value as object)) return undefined as T;
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeForCache(item, depth + 1, seen)).filter((item) => item !== undefined) as T;
    }
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k) || (SENSITIVE_SUFFIX.test(k) && k !== "key_configured")) continue;
      const clean = sanitizeForCache(v, depth + 1, seen);
      if (clean !== undefined) out[k] = clean;
    }
    return out as T;
  } finally {
    seen.delete(value as object);
  }
}

function cloneSanitized<T>(value: T): T {
  return sanitizeForCache(value);
}

export function swrKey(instanceId: string, workspace: string, domain: string): string {
  const inst = encodeURIComponent((instanceId || "local").trim() || "local");
  const ws = encodeURIComponent((workspace || "default").trim() || "default");
  return `klanker:v1:inst:${inst}:ws:${ws}:${domain}`;
}

export function swrDomainOfKey(key: string): string {
  const parts = key.split(":");
  return parts.length > 6 ? parts.slice(6).join(":") : "";
}

function storageFor(persist: Exclude<SwrPersist, false>): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return persist === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function parseEnvelope(raw: string | null): StorageEnvelope | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StorageEnvelope;
    if (!parsed || parsed.v !== ENVELOPE_VERSION || typeof parsed.ts !== "number" || !("data" in parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function storageKeys(storage: Storage | null, prefix = CACHE_PREFIX): string[] {
  if (!storage) return [];
  const out: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix)) out.push(key);
    }
  } catch {}
  return out;
}

function readStorageRecord(key: string): CacheRecord | undefined {
  for (const persist of ["session", "local"] as const) {
    const storage = storageFor(persist);
    if (!storage) continue;
    let envelope: StorageEnvelope | undefined;
    try {
      envelope = parseEnvelope(storage.getItem(key));
    } catch {
      envelope = undefined;
    }
    if (!envelope) continue;
    return {
      data: sanitizeForCache(envelope.data),
      hasData: true,
      ts: envelope.ts,
      revalidating: false,
      persist,
    };
  }
  return undefined;
}

function evictOldest(storage: Storage, protectingKey: string): void {
  const rows: { key: string; ts: number }[] = [];
  for (const key of storageKeys(storage)) {
    if (key === protectingKey) continue;
    const env = parseEnvelope(storage.getItem(key));
    rows.push({ key, ts: env?.ts ?? 0 });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const count = Math.max(1, Math.ceil(rows.length / 5));
  for (const row of rows.slice(0, count)) {
    try {
      storage.removeItem(row.key);
    } catch {}
  }
}

function writeStorageRecord(key: string, record: CacheRecord): void {
  if (!record.persist || !record.hasData) return;
  const storage = storageFor(record.persist);
  if (!storage) return;
  const serialized = record.serialize ? record.serialize(record.data as never) : record.data;
  const envelope: StorageEnvelope = { v: ENVELOPE_VERSION, ts: record.ts, data: serialized };
  let encoded = "";
  try {
    encoded = JSON.stringify(envelope);
  } catch {
    return;
  }
  if (!encoded || (record.persist === "session" && encoded.length > MAX_SESSION_ENTRY_BYTES)) return;
  try {
    storage.setItem(key, encoded);
  } catch (e) {
    const err = e as { name?: string; code?: number } | null;
    const quota = !!err && (err.name === "QuotaExceededError" || err.code === 22 || err.code === 1014);
    if (!quota) return;
    evictOldest(storage, key);
    try {
      storage.setItem(key, encoded);
    } catch {}
  }
}

function removeStorageRecord(key: string): void {
  for (const persist of ["session", "local"] as const) {
    try {
      storageFor(persist)?.removeItem(key);
    } catch {}
  }
}

function notify(key: string): void {
  const subs = subscribers.get(key);
  if (!subs) return;
  for (const cb of Array.from(subs)) cb();
}

function ensureRecord(key: string): CacheRecord {
  const existing = memory.get(key);
  if (existing) return existing;
  const hydrated = readStorageRecord(key);
  const record: CacheRecord = hydrated ?? { hasData: false, ts: 0, revalidating: false, persist: false };
  memory.set(key, record);
  return record;
}

export function peekSWR<T>(key: string, opts: Pick<SwrOptions<T>, "parse"> = {}): T | undefined {
  if (!key) return undefined;
  const record = ensureRecord(key);
  if (!record.hasData) return undefined;
  const parse = opts.parse ?? (record.parse as ((raw: unknown) => T | undefined) | undefined);
  if (parse) {
    try {
      return parse(record.data);
    } catch {
      return undefined;
    }
  }
  return record.data as T | undefined;
}

function snapshotSWR<T>(key: string, ttlMs = DEFAULT_TTL_MS): SwrSnapshot<T> {
  const record = key ? ensureRecord(key) : undefined;
  const ts = record?.ts ?? 0;
  const hasData = !!record?.hasData;
  return {
    data: hasData ? (record?.data as T | undefined) : undefined,
    hasData,
    error: record?.error || "",
    ts,
    isStale: hasData && now() - ts > ttlMs,
    isRevalidating: !!record?.revalidating,
  };
}

export function writeSWR<T>(key: string, value: T, opts: { persist?: SwrPersist; ts?: number; serialize?: (value: T) => unknown; parse?: (raw: unknown) => T | undefined } = {}): T {
  if (!key) return value;
  const record = ensureRecord(key);
  record.data = cloneSanitized(value);
  record.hasData = true;
  record.ts = opts.ts ?? now();
  record.error = undefined;
  if (opts.persist !== undefined) record.persist = opts.persist;
  if (opts.serialize) record.serialize = opts.serialize as (value: never) => unknown;
  if (opts.parse) record.parse = opts.parse as (raw: unknown) => unknown;
  writeStorageRecord(key, record);
  notify(key);
  return value;
}

export function removeSWR(key: string): void {
  memory.delete(key);
  removeStorageRecord(key);
  notify(key);
}

function markStale(key: string): void {
  const record = ensureRecord(key);
  record.ts = 0;
  for (const persist of ["session", "local"] as const) {
    const storage = storageFor(persist);
    if (!storage) continue;
    const env = parseEnvelope(storage.getItem(key));
    if (!env) continue;
    try {
      storage.setItem(key, JSON.stringify({ ...env, ts: 0 }));
    } catch {}
  }
  notify(key);
}

function emitInvalidationEvent(target: string, exact: boolean): void {
  const event = { target, exact, ts: now() };
  for (const cb of Array.from(invalidationListeners)) cb(event);
}

/** Emit an invalidation signal without deleting cached data. Active
 *  subscribers revalidate; inactive keep-alive panes stay asleep until they
 *  are activated. */
export function emitInvalidation(target: string, opts: { exact?: boolean } = {}): void {
  if (!target) return;
  emitInvalidationEvent(target, opts.exact === true);
}

export function invalidateSWR(key: string): void {
  if (!key) return;
  markStale(key);
  emitInvalidationEvent(key, true);
}

export function invalidateSWRPrefix(prefix: string): void {
  if (!prefix) return;
  const keys = new Set<string>();
  for (const key of memory.keys()) if (key.startsWith(prefix)) keys.add(key);
  for (const persist of ["session", "local"] as const) {
    const storage = storageFor(persist);
    for (const key of storageKeys(storage, CACHE_PREFIX)) if (key.startsWith(prefix)) keys.add(key);
  }
  for (const key of keys) markStale(key);
  emitInvalidationEvent(prefix, false);
}

/** Domain invalidation across instance/workspace scopes. Domain `files`
 *  matches `files`, `files:tree:x`, and nested file keys. */
export function invalidateSWRDomain(domain: string): void {
  if (!domain) return;
  const keys = new Set<string>();
  for (const key of memory.keys()) keys.add(key);
  for (const persist of ["session", "local"] as const) {
    const storage = storageFor(persist);
    for (const key of storageKeys(storage, CACHE_PREFIX)) keys.add(key);
  }
  for (const key of keys) {
    const d = swrDomainOfKey(key);
    if (d === domain || d.startsWith(`${domain}:`)) markStale(key);
  }
  emitInvalidationEvent(`domain:${domain}`, false);
}

export function onSWRInvalidation(listener: (event: InvalidationEvent) => void): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export function subscribeSWR(key: string, listener: () => void): () => void {
  let subs = subscribers.get(key);
  if (!subs) {
    subs = new Set();
    subscribers.set(key, subs);
  }
  subs.add(listener);
  return () => {
    subs?.delete(listener);
    if (subs && subs.size === 0) subscribers.delete(key);
  };
}

function startRevalidation<T>(key: string, fetcher: () => Promise<T>, opts: SwrOptions<T>): Promise<T> {
  const record = ensureRecord(key);
  if (record.promise) return record.promise as Promise<T>;
  if (opts.persist !== undefined) record.persist = opts.persist;
  if (opts.serialize) record.serialize = opts.serialize as (value: never) => unknown;
  if (opts.parse) record.parse = opts.parse as (raw: unknown) => unknown;
  record.revalidating = true;
  notify(key);
  const promise = (async () => {
    const raw = await fetcher();
    const clean = cloneSanitized(raw);
    writeSWR(key, clean, {
      persist: record.persist,
      serialize: opts.serialize,
      parse: opts.parse,
    });
    return clean;
  })();
  record.promise = promise as Promise<unknown>;
  promise.then(
    () => {
      if (record.promise !== promise) return;
      record.promise = undefined;
      record.revalidating = false;
      record.error = undefined;
      notify(key);
    },
    (error) => {
      if (record.promise !== promise) return;
      record.promise = undefined;
      record.revalidating = false;
      record.error = errText(error);
      notify(key);
    }
  );
  return promise;
}

/** SWR fetch: fresh cache resolves immediately, stale cache resolves
 *  immediately while one background revalidation writes through, and every
 *  caller shares the same in-flight promise. */
export function fetchSWR<T>(key: string, fetcher: () => Promise<T>, opts: SwrOptions<T> = {}): Promise<T> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const record = ensureRecord(key);
  const hasData = record.hasData;
  const cached = hasData ? peekSWR<T>(key, opts) : undefined;
  const cacheUsable = hasData && cached !== undefined;
  const fresh = cacheUsable && now() - record.ts <= ttlMs;
  if (fresh && !opts.force) return Promise.resolve(cached as T);
  if (record.promise) {
    if (!opts.force && cacheUsable) return Promise.resolve(cached as T);
    return record.promise as Promise<T>;
  }
  if (cacheUsable && !opts.force) {
    const background = startRevalidation(key, fetcher, opts);
    void background.catch(() => {});
    return Promise.resolve(cached as T);
  }
  return startRevalidation(key, fetcher, opts);
}

export function prefetchSWR<T>(key: string, fetcher: () => Promise<T>, opts: SwrOptions<T> = {}): void {
  void fetchSWR(key, fetcher, opts).catch(() => {});
}

/** Optimistic mutation: patch visible cache synchronously, run the remote
 *  mutation, keep the optimistic/reconciled value on success, and restore the
 *  exact pre-mutation snapshot on failure before invoking `onRollback`. */
export async function mutateSWR<T, R = unknown>(
  key: string,
  optimisticUpdater: (current: T | undefined) => T,
  remoteMutation: (optimistic: T) => Promise<R>,
  onRollback?: (error: unknown, previous: T | undefined) => void
): Promise<T> {
  const hadData = ensureRecord(key).hasData;
  const previous = peekSWR<T>(key);
  const optimistic = optimisticUpdater(previous);
  const record = ensureRecord(key);
  writeSWR(key, optimistic, { persist: record.persist });
  try {
    const remote = await remoteMutation(optimistic);
    if (remote !== undefined) writeSWR(key, remote as unknown as T, { persist: record.persist });
    return peekSWR<T>(key) ?? optimistic;
  } catch (error) {
    if (hadData && previous !== undefined) writeSWR(key, previous, { persist: record.persist });
    else removeSWR(key);
    onRollback?.(error, previous);
    throw error;
  }
}

/** React SWR hook. `isLoading` is only true when there is no data at all;
 *  revalidation never replaces rendered stale rows with a spinner. */
export function useSWR<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: SwrOptions<T> & {
    enabled?: boolean;
    revalidateOnFocus?: boolean;
    refreshIntervalMs?: number;
  } = {}
): SwrSnapshot<T> & { isLoading: boolean; refresh: () => Promise<T> } {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const enabled = opts.enabled !== false && !!key;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [snap, setSnap] = useState<SwrSnapshot<T>>(() => snapshotSWR<T>(key, ttlMs));

  useEffect(() => {
    setSnap(snapshotSWR<T>(key, ttlMs));
    if (!key) return undefined;
    return subscribeSWR(key, () => setSnap(snapshotSWR<T>(key, ttlMs)));
  }, [key, ttlMs]);

  const revalidate = useCallback((force = false): Promise<T> => {
    if (!key) return Promise.reject(new Error("missing SWR key"));
    const o = optsRef.current;
    return fetchSWR(key, () => fetcherRef.current(), {
      ttlMs: o.ttlMs,
      persist: o.persist,
      serialize: o.serialize,
      parse: o.parse,
      force,
    });
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    void revalidate(false).catch(() => {});
  }, [enabled, revalidate]);

  useEffect(() => {
    if (!key) return undefined;
    return onSWRInvalidation((event) => {
      if (!enabledRef.current) return;
      const exactHit = event.exact && event.target === key;
      const prefixHit = !event.exact && key.startsWith(event.target);
      const domainHit = !event.exact && event.target.startsWith("domain:") && (() => {
        const domain = event.target.slice("domain:".length);
        const mine = swrDomainOfKey(key);
        return mine === domain || mine.startsWith(`${domain}:`);
      })();
      if (exactHit || prefixHit || domainHit) void revalidate(false).catch(() => {});
    });
  }, [key, revalidate]);

  useEffect(() => {
    if (!enabled || !opts.revalidateOnFocus) return undefined;
    const update = () => {
      if (document.visibilityState === "visible") void revalidate(false).catch(() => {});
    };
    const focus = () => void revalidate(false).catch(() => {});
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", focus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, revalidate]);

  useEffect(() => {
    if (!enabled || !opts.refreshIntervalMs) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void revalidate(false).catch(() => {});
    }, opts.refreshIntervalMs);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, revalidate, opts.refreshIntervalMs]);

  const refresh = useCallback(() => revalidate(true), [revalidate]);
  return {
    ...snap,
    isLoading: !snap.hasData && !snap.error,
    refresh,
  };
}

let invalidationWired = false;

/** Install the UI-event invalidation bridge once. Turn trailers and tool_end
 *  frames mark git/files/session domains stale without deleting their last
 *  good rows; active subscribers revalidate, hidden panes do not. */
export function wireSwrInvalidations(): void {
  if (invalidationWired || typeof window === "undefined") return;
  invalidationWired = true;
  window.addEventListener("klanker:turn-event", (event) => {
    const ev = ((event as CustomEvent<Record<string, unknown>>).detail || {}) as Record<string, unknown>;
    const type = typeof ev.type === "string" ? ev.type : "";
    if (type === "tool_end") {
      const tool = typeof ev.tool === "string" ? ev.tool.toLowerCase() : "";
      const mutating = /(?:^|[.:_])(write|edit|patch|delete|remove|move|rename|run)(?:$|[.:_])/.test(tool) || tool.includes("terminal.run");
      if (mutating) {
        invalidateSWRDomain("git");
        invalidateSWRDomain("files");
      }
    } else if (type === "trailer") {
      invalidateSWRDomain("git");
      invalidateSWRDomain("files");
      invalidateSWRDomain("sessions");
    }
  });
  window.addEventListener("klanker:swr-invalidate", (event) => {
    const detail = ((event as CustomEvent<Record<string, unknown>>).detail || {}) as Record<string, unknown>;
    const target = typeof detail.target === "string" ? detail.target : "";
    if (!target) return;
    if (detail.exact === true) invalidateSWR(target);
    else invalidateSWRPrefix(target);
  });
}

/** Test hook and emergency hygiene lever: clears memory and only the
 *  cache-prefixed storage mirror, never unrelated app preferences. */
export function clearSWRCache(): void {
  memory.clear();
  for (const persist of ["session", "local"] as const) {
    const storage = storageFor(persist);
    for (const key of storageKeys(storage, CACHE_PREFIX)) {
      try {
        storage?.removeItem(key);
      } catch {}
    }
  }
  for (const key of Array.from(subscribers.keys())) notify(key);
}
