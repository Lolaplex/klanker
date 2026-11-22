import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { KlankerInstance, PairCreateResult } from "../types/klanker";
import { api } from "../services/api";
import { encodeQrMatrix, qrSvgPath } from "../qr";
import { isLoopbackOrigin } from "../pairLink";

interface PairModalProps {
  instance: KlankerInstance;
  onClose: () => void;
}

export const PairModal: React.FC<PairModalProps> = ({ instance, onClose }) => {
  const [mode, setMode] = useState<"web" | "remote">("web");
  const [pair, setPair] = useState<PairCreateResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const mint = async (targetMode: "web" | "remote") => {
    setBusy(true);
    setError(null);
    setCopied(false);
    setCopiedLink(false);
    try {
      const res = await api.createPairCode(instance, targetMode, 60);
      setPair(res);
      setSecondsLeft(Math.max(1, Number(res.expires_in || 60)));
    } catch (e) {
      setPair(null);
      setSecondsLeft(0);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void mint(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, instance.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!pair || secondsLeft <= 0) return;
    const t = window.setInterval(() => {
      setSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [pair, secondsLeft]);

  // A pair code is single-use and short-lived; while the modal is open,
  // mint the next one as soon as the countdown hits zero so the QR/link
  // on screen is always redeemable. Errors stop the chain — the manual
  // refresh button stays as the recovery path.
  useEffect(() => {
    if (pair && secondsLeft === 0 && !busy) void mint(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair, secondsLeft, busy, mode]);

  const resolvedUrl = useMemo(() => {
    if (!pair?.pair_url) return "";
    if (pair.pair_url.startsWith("/")) {
      const origin = (instance.endpoint?.base_url || instance.base_url || window.location.origin).replace(/\/+$/, "");
      return `${origin}${pair.pair_url}`;
    }
    return pair.pair_url;
  }, [pair, instance.endpoint?.base_url, instance.base_url]);

  const linkUrl = resolvedUrl.includes("#pair=") ? resolvedUrl : "";
  const qrData = useMemo(() => {
    if (!pair || secondsLeft <= 0) return null;
    const payload = linkUrl || pair.code;
    if (!payload) return null;
    try {
      const mat = encodeQrMatrix(payload);
      const quiet = 4;
      return { total: mat.length + quiet * 2, d: qrSvgPath(mat, quiet) };
    } catch {
      return null;
    }
  }, [pair, secondsLeft, linkUrl]);

  const totalTtl = Math.max(1, pair?.expires_in || 60);
  const pct = Math.max(0, Math.min(100, Math.round((secondsLeft / totalTtl) * 100)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-[#0a0a0a] border border-[#262626] rounded-lg font-mono text-xs flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#262626]">
          <span className="text-white tracking-wider uppercase">pair · {instance.name}</span>
          <button type="button" onClick={onClose} className="text-[#525252] hover:text-white" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-1 p-1 bg-[#121212] border border-[#262626] rounded">
            <button
              type="button"
              onClick={() => setMode("web")}
              className={`py-1.5 rounded transition-colors ${mode === "web" ? "bg-[#262626] text-white" : "text-[#737373] hover:text-white"}`}
            >
              mobile / pwa
            </button>
            <button
              type="button"
              onClick={() => setMode("remote")}
              className={`py-1.5 rounded transition-colors ${mode === "remote" ? "bg-[#262626] text-white" : "text-[#737373] hover:text-white"}`}
            >
              remote cli
            </button>
          </div>

          {error && <div className="text-red-500">{error}</div>}

          {pair && secondsLeft > 0 ? (
            <>
              {qrData && (
                <div className="self-center p-2 bg-white rounded">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox={`0 0 ${qrData.total} ${qrData.total}`}
                    className="w-44 h-44"
                    shapeRendering="crispEdges"
                    role="img"
                    aria-label="Single-use pairing QR code"
                  >
                    <rect width={qrData.total} height={qrData.total} fill="#ffffff" />
                    <path d={qrData.d} fill="#000000" />
                  </svg>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 bg-[#121212] border border-[#262626] rounded px-3 py-2">
                <span className="text-white tracking-widest text-sm">{pair.code}</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(pair.code).then(() => setCopied(true)).catch(() => {});
                  }}
                  className="px-2 py-1 border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white"
                >
                  {copied ? "copied" : "copy"}
                </button>
              </div>

              {linkUrl && (
                <div className="flex items-center justify-between gap-2 bg-[#121212] border border-[#262626] rounded px-3 py-2">
                  <span className="text-[#737373] truncate text-[11px]">{linkUrl}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(linkUrl).then(() => setCopiedLink(true)).catch(() => {});
                    }}
                    className="px-2 py-1 border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white shrink-0"
                  >
                    {copiedLink ? "copied" : "copy link"}
                  </button>
                </div>
              )}
              {linkUrl && isLoopbackOrigin(linkUrl) && (
                <p className="text-[10px] text-amber-500">
                  link points at this device — pairing another device needs a reachable URL (tailnet/LAN), not loopback.
                </p>
              )}

              <div className="flex flex-col gap-1">
                <div className="flex justify-between text-[11px] text-[#737373]">
                  <span>single-use pairing expires</span>
                  <span>{secondsLeft}s</span>
                </div>
                <div className="w-full h-1 bg-[#171717] rounded overflow-hidden">
                  <div className="h-full bg-white transition-all duration-1000" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </>
          ) : (
            <div className="py-6 text-center text-[#737373]">
              {busy ? "creating single-use code…" : pair ? "renewing…" : "pairing code expired"}
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void mint(mode)}
            className="inline-flex items-center justify-center gap-1.5 py-2 border border-[#262626] rounded bg-[#141414] hover:bg-[#1f1f1f] text-white disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            new single-use code
          </button>
        </div>
      </div>
    </div>
  );
};
