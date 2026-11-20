/**
 * Web Push (VAPID) client helpers. The relay half (key endpoint + subscription
 * store + sender) is agents-relay scope; this module degrades honestly when
 * the routes are absent — the probe returns null and the caller says so.
 */
import type { KlankerInstance } from "./types/klanker";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode a base64url VAPID public key (no padding) into raw bytes. */
export function vapidToKey(key: string): Uint8Array {
  const b64 = (key + "=".repeat((4 - (key.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    const c2 = b64[i + 2] ?? "=";
    const c3 = b64[i + 3] ?? "=";
    const n =
      (B64.indexOf(b64[i]) << 18) |
      (B64.indexOf(b64[i + 1]) << 12) |
      ((c2 === "=" ? 0 : B64.indexOf(c2)) << 6) |
      (c3 === "=" ? 0 : B64.indexOf(c3));
    bytes.push((n >> 16) & 255);
    if (c2 !== "=") bytes.push((n >> 8) & 255);
    if (c3 !== "=") bytes.push(n & 255);
  }
  return new Uint8Array(bytes);
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

export type PushResult = { ok: true } | { ok: false; reason: string };

/**
 * Probe the relay for its VAPID key, subscribe the active service worker and
 * POST the subscription back. Every failure returns a reason — no silent
 * success, no pretending the relay stores anything when the route is absent.
 */
export async function subscribePush(
  inst: KlankerInstance,
  workspace?: string,
  persona?: string
): Promise<PushResult> {
  if (!pushSupported()) return { ok: false, reason: "push unsupported in this browser" };
  if (typeof Notification !== "undefined" && Notification.permission === "denied") {
    return { ok: false, reason: "notification permission denied" };
  }
  // Lazy: keeps this module importable under node --test (no window/fetch).
  const { api } = await import("./services/api");
  const key = await api.pushVapidKey(inst);
  if (!key) return { ok: false, reason: "this relay has no push endpoint" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "notification permission denied" };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidToKey(key) as BufferSource,
  });
  await api.pushSubscribe(inst, {
    workspace: workspace || undefined,
    persona: persona || undefined,
    subscription: sub.toJSON(),
  });
  return { ok: true };
}
