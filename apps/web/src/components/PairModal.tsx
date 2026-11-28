import React, { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { KlankerInstance, PairCreateResult } from "../types/klanker";
import { api } from "../services/api";
import { encodeQrMatrix, qrSvgPath } from "../qr";
import { isLoopbackOrigin, pairLinkView } from "../pairLink";
import { Dialog } from "./ui/Dialog";

interface PairModalProps {
  instance: KlankerInstance;
  onClose: () => void;
}

type PairMode = "web" | "remote";

interface PairMintedBlockProps {
  pair: PairCreateResult;
  linkUrl: string;
  linkLoopback: boolean;
  secondsLeft: number;
  totalTtl: number;
  mode: PairMode;
}

function hostPart(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Minted single-use link surface. Phone/browser is QR-first; desktop/host
 *  is code-first because scanning a host invite with a phone camera is the
 *  wrong mental model. Loopback links are dev-only behind an explicit toggle. */
export const PairMintedBlock: React.FC<PairMintedBlockProps> = ({
  pair,
  linkUrl,
  linkLoopback,
  secondsLeft,
  totalTtl,
  mode,
}) => {
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showLocal, setShowLocal] = useState(false);

  const pct = Math.max(0, Math.min(100, Math.round((secondsLeft / Math.max(1, totalTtl)) * 100)));
  const showLoopbackWarning = Boolean(
    linkUrl && (pair.loopback_warning === true || (pair.loopback_warning === undefined && linkLoopback))
  );
  const guarded = showLoopbackWarning && !showLocal;
  const qrData = useMemo(() => {
    if (secondsLeft <= 0 || mode !== "web" || guarded) return null;
    const payload = linkUrl || pair.code;
    if (!payload) return null;
    try {
      const mat = encodeQrMatrix(payload);
      const quiet = 4;
      return { total: mat.length + quiet * 2, d: qrSvgPath(mat, quiet) };
    } catch {
      return null;
    }
  }, [pair, secondsLeft, linkUrl, mode, guarded]);

  const copy = (text: string, done: (v: boolean) => void) => {
    void navigator.clipboard?.writeText(text).then(() => done(true)).catch(() => {});
  };

  return (
    <>
      {guarded ? (
        <div className="border border-strong rounded-md bg-elevated px-3 py-3 space-y-2" data-testid="loopback-warning">
          <div className="text-ink-primary font-semibold">Local-only link</div>
          <p className="text-[11px] leading-relaxed text-ink-secondary">
            This machine only listens locally (127.0.0.1). Other devices can't reach it directly — click Join a hub to
            connect to your VPS/hub, or bind to LAN/Tailscale in Settings.
          </p>
          <button
            type="button"
            onClick={() => setShowLocal(true)}
            className="text-[10px] text-ink-dim hover:text-ink-primary underline underline-offset-2"
          >
            Show local link anyway
          </button>
        </div>
      ) : null}

      {qrData && (
        <div className="self-center p-2 bg-accent rounded-md" data-testid="pair-qr">
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
      {mode === "web" && !guarded ? (
        <p className="text-center text-[11px] text-ink-muted">Scan with your phone camera to open Klanker signed in.</p>
      ) : null}

      {!guarded && (mode === "remote" ? (
        <div className="border border-strong rounded-md bg-elevated px-3 py-3 space-y-2" data-testid="desktop-code-card">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-ink-muted">
            <span>Hub host</span>
            <span className="normal-case tracking-normal text-ink-secondary">{hostPart(linkUrl) || "this hub"}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xl font-semibold tracking-[0.22em] text-ink-primary">{pair.code}</span>
            <button
              type="button"
              onClick={() => copy(pair.code, setCopied)}
              className="px-2 py-1 border border-strong rounded-md text-[11px] text-ink-secondary hover:text-ink-primary"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 bg-elevated border border-strong rounded-md px-3 py-2">
          <span className="text-ink-primary tracking-widest text-sm">{pair.code}</span>
          <button
            type="button"
            onClick={() => copy(pair.code, setCopied)}
            className="px-2 py-1 border border-strong rounded-md text-[11px] text-ink-secondary hover:text-ink-primary"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
      ))}

      {linkUrl && !guarded && (
        <div className="flex items-center justify-between gap-2 bg-elevated border border-strong rounded-md px-3 py-2">
          <span className="text-ink-muted truncate text-[11px]">{linkUrl}</span>
          <button
            type="button"
            onClick={() => copy(linkUrl, setCopiedLink)}
            className="px-2 py-1 border border-strong rounded-md text-[11px] text-ink-secondary hover:text-ink-primary shrink-0"
          >
            {copiedLink ? "copied" : "copy link"}
          </button>
        </div>
      )}
      {linkUrl && pair.loopback_substituted === true && (
        <p className="text-[10px] text-ink-muted" data-testid="loopback-substituted-note">
          Reachable network address selected automatically
        </p>
      )}
      {linkUrl && mode === "remote" && !guarded && (
        <p className="text-[10px] text-ink-dim select-text">cli: klanker workspace join "{linkUrl}"</p>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-[11px] text-ink-muted">
          <span>single-use pairing expires</span>
          <span>{secondsLeft}s</span>
        </div>
        <div className="w-full h-1 bg-hover rounded-md overflow-hidden">
          <div className="h-full bg-accent transition-all duration-1000" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </>
  );
};

/** Layer-1 device pairing mint surface: Phone/Browser QR or Desktop/Host code. */
export const PairModal: React.FC<PairModalProps> = ({ instance, onClose }) => {
  const baseUrl = instance.endpoint?.base_url || instance.base_url || "";
  const [mode, setMode] = useState<PairMode>(() => (isLoopbackOrigin(baseUrl) ? "remote" : "web"));
  const [pair, setPair] = useState<PairCreateResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = async (targetMode: PairMode) => {
    setBusy(true);
    setError(null);
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
    if (!pair || secondsLeft <= 0) return;
    const t = window.setInterval(() => {
      setSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [pair, secondsLeft]);

  useEffect(() => {
    if (pair && secondsLeft === 0 && !busy) void mint(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair, secondsLeft, busy, mode]);

  const resolvedUrl = useMemo(() => {
    if (!pair?.pair_url) return "";
    if (pair.pair_url.startsWith("/")) {
      const origin = (baseUrl || window.location.origin).replace(/\/+$/, "");
      return `${origin}${pair.pair_url}`;
    }
    return pair.pair_url;
  }, [pair, baseUrl]);

  const { linkUrl, loopback: linkLoopback } = pairLinkView(resolvedUrl);
  const totalTtl = Math.max(1, pair?.expires_in || 60);

  const modeBtn = (m: PairMode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`py-1.5 rounded-md transition-colors ${mode === m ? "bg-hover text-ink-primary" : "text-ink-muted hover:text-ink-primary"}`}
    >
      {label}
    </button>
  );

  return (
    <Dialog open onClose={onClose} title="LINK A DEVICE">
      <div className="p-4 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-1 p-1 bg-elevated border border-strong rounded-md">
          {modeBtn("web", "Phone / Browser")}
          {modeBtn("remote", "Desktop / Host")}
        </div>

        {error && <div className="text-red-500">{error}</div>}

        {pair && secondsLeft > 0 ? (
          <PairMintedBlock
            pair={pair}
            linkUrl={linkUrl}
            linkLoopback={linkLoopback}
            secondsLeft={secondsLeft}
            totalTtl={totalTtl}
            mode={mode}
          />
        ) : (
          <div className="py-6 text-center text-ink-muted">
            {busy ? "creating single-use code…" : pair ? "renewing…" : "pairing code expired"}
          </div>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => void mint(mode)}
          className="inline-flex items-center justify-center gap-1.5 py-2 border border-strong rounded-md bg-elevated hover:bg-hover text-ink-primary disabled:opacity-50"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          new single-use code
        </button>
      </div>
    </Dialog>
  );
};
