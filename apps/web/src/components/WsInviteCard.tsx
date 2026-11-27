import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { WsInvite } from "../types/klanker";
import { api, caps, localRelayBaseUrl } from "../services/api";
import { encodeQrMatrix, qrSvgPath } from "../qr";
import { wsInviteView } from "../wsShare";

interface WsInviteCardProps {
  /** Workspace the invite grants membership to. */
  ws: string;
  ttlSec?: number;
}

/** Base the invite link resolves against: the managed local relay on
 *  desktop, the serving origin on PWA. */
export function inviteBaseUrl(): string {
  if (caps.keyring) return localRelayBaseUrl();
  try {
    return window.location.origin;
  } catch {
    return "";
  }
}

/** Single-use ws-share invite: QR + dashed code + copyable link. The
 *  invite mints on the LOCAL relay's /v1/ws/invite — peers redeem it as
 *  "pair device" plus a ws member grant in one step. */
export const WsInviteCard: React.FC<WsInviteCardProps> = ({ ws, ttlSec = 60 }) => {
  const [invite, setInvite] = useState<WsInvite | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const mint = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    setCopiedLink(false);
    try {
      const res = await api.createWsInvite(ws, ttlSec);
      setInvite(res);
      setSecondsLeft(Math.max(1, Number(res.expires_in || ttlSec)));
    } catch (e) {
      setInvite(null);
      setSecondsLeft(0);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  useEffect(() => {
    if (!invite || secondsLeft <= 0) return;
    const t = window.setInterval(() => {
      setSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [invite, secondsLeft]);

  // Single-use + short-lived: remint on expiry so the on-screen QR is
  // always redeemable; errors stop the chain (manual refresh remains).
  useEffect(() => {
    if (invite && secondsLeft === 0 && !busy) void mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite, secondsLeft, busy]);

  const view = useMemo(() => (invite ? wsInviteView(invite, inviteBaseUrl()) : null), [invite]);
  const qrData = useMemo(() => {
    if (!view || secondsLeft <= 0) return null;
    const payload = view.link || view.qrText;
    if (!payload) return null;
    try {
      const mat = encodeQrMatrix(payload);
      const quiet = 4;
      return { total: mat.length + quiet * 2, d: qrSvgPath(mat, quiet) };
    } catch {
      return null;
    }
  }, [view, secondsLeft]);

  const totalTtl = Math.max(1, invite?.expires_in || ttlSec);
  const pct = Math.max(0, Math.min(100, Math.round((secondsLeft / totalTtl) * 100)));
  const showLoopbackWarning = Boolean(
    invite && view?.link && (invite.loopback_warning === true || (invite.loopback_warning === undefined && view.loopback))
  );

  return (
    <div className="flex flex-col gap-3" data-ws-invite={ws}>
      {error && <div className="text-red-500">{error}</div>}

      {invite && secondsLeft > 0 && view ? (
        <>
          {qrData && (
            <div className="self-center p-2 bg-accent rounded-md">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox={`0 0 ${qrData.total} ${qrData.total}`}
                className="w-40 h-40"
                shapeRendering="crispEdges"
                role="img"
                aria-label="Workspace invite QR code"
              >
                <rect width={qrData.total} height={qrData.total} fill="#ffffff" />
                <path d={qrData.d} fill="#000000" />
              </svg>
            </div>
          )}

          <div className="flex items-center justify-between gap-2 bg-elevated border border-strong rounded-md px-3 py-2">
            <span className="text-ink-primary tracking-widest text-sm">{view.code}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(view.code).then(() => setCopied(true)).catch(() => {});
              }}
              className="px-2 py-1 border border-strong rounded-md text-[11px] text-ink-secondary hover:text-ink-primary"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>

          {view.link && (
            <div className="flex items-center justify-between gap-2 bg-elevated border border-strong rounded-md px-3 py-2">
              <span className="text-ink-muted truncate text-[11px]">{view.link}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(view.link).then(() => setCopiedLink(true)).catch(() => {});
                }}
                className="px-2 py-1 border border-strong rounded-md text-[11px] text-ink-secondary hover:text-ink-primary shrink-0"
              >
                {copiedLink ? "copied" : "copy link"}
              </button>
            </div>
          )}
          {view.link && invite.loopback_substituted === true && (
            <p className="text-[10px] text-ink-muted" data-testid="loopback-substituted-note">
              Reachable network address selected automatically
            </p>
          )}
          {showLoopbackWarning && (
            <p className="text-[10px] text-ink-secondary" data-testid="loopback-warning">
              invite link resolves to 127.0.0.1 — only this device can reach it. Enable hub mode (LAN bind) or share a
              tailnet/LAN URL so the other device can redeem it.
            </p>
          )}

          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[11px] text-ink-muted">
              <span>single-use invite expires</span>
              <span>{secondsLeft}s</span>
            </div>
            <div className="w-full h-1 bg-hover rounded-md overflow-hidden">
              <div className="h-full bg-accent transition-all duration-1000" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </>
      ) : (
        <div className="py-4 text-center text-ink-muted">
          {busy ? "creating ws invite…" : invite ? "renewing…" : "invite expired"}
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => void mint()}
        className="inline-flex items-center justify-center gap-1.5 py-2 border border-strong rounded-md bg-elevated hover:bg-hover text-ink-primary disabled:opacity-50"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        new invite
      </button>
    </div>
  );
};
