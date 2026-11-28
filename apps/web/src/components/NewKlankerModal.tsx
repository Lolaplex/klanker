import React, { useEffect, useRef, useState } from "react";
import { Radar } from "lucide-react";
import { DiscoveredPeer, KlankerInstance } from "../types/klanker";
import { api } from "../services/api";
import { guessScheme, normCode, parseBareCode, parsePairInput, relayMountError } from "../pairLink";
import { Dialog } from "./ui/Dialog";

interface NewKlankerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (instance: KlankerInstance) => void | Promise<void>;
  onConnected?: () => void;
}

function blankInstance(name: string): KlankerInstance {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id: slug || crypto.randomUUID(),
    name,
    slug,
    role: "remote",
    provider: "",
    model: "",
    workspace: "",
    lock_workspace: false,
    port: 0,
    system_prompt: "",
    endpoint: { base_url: "" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    kind: "remote",
  };
}

function cleanHubInput(raw: string): string {
  const t = (raw || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) {
    try {
      return new URL(t).host;
    } catch {
      return t;
    }
  }
  return t.replace(/\/.*$/, "");
}

function hubOrigin(raw: string): string {
  const host = cleanHubInput(raw);
  if (!host) return "";
  if (/^https?:\/\//i.test(raw.trim())) {
    try {
      return new URL(raw.trim()).origin;
    } catch {
      return "";
    }
  }
  return `${guessScheme(host)}://${host}`;
}

function readRecentHubs(): string[] {
  try {
    const rows = JSON.parse(localStorage.getItem("klanker.recentHubs") || "[]");
    return Array.isArray(rows) ? rows.map(String).filter(Boolean).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function writeRecentHub(host: string): void {
  try {
    const clean = cleanHubInput(host);
    if (!clean) return;
    const next = [clean, ...readRecentHubs().filter((h) => h !== clean)].slice(0, 5);
    localStorage.setItem("klanker.recentHubs", JSON.stringify(next));
  } catch {}
}

export const NewKlankerModal: React.FC<NewKlankerModalProps> = ({ isOpen, onClose, onSave, onConnected }) => {
  const [hubAddress, setHubAddress] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [hostLabel, setHostLabel] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameOverride, setNameOverride] = useState("");
  const [recentHubs, setRecentHubs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [offers, setOffers] = useState<DiscoveredPeer[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [advPairInput, setAdvPairInput] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setRecentHubs(readRecentHubs());
    let stop = false;
    void api.fetchHostInfo().then((info) => {
      if (!stop && info.host_label) setHostLabel((cur) => cur || info.host_label);
    }).catch(() => {});
    return () => { stop = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let stop = false;
    let timer = 0;
    const scan = async () => {
      try {
        const peers = await api.discoverPeers();
        if (!stop) setOffers(peers);
      } catch {
        // keep previous offers
      } finally {
        if (!stop) timer = window.setTimeout(() => void scan(), 5000);
      }
    };
    void scan();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => {
    setHubAddress("");
    setPairCode("");
    setError(null);
    setNote(null);
    setOffers(null);
    setAdvanced(false);
    setAdvPairInput("");
    setName("");
    setUrl("");
    setSecret("");
    setRenameOpen(false);
    setNameOverride("");
    onClose();
  };

  const smartPaste = (raw: string, field: "host" | "code") => {
    const target = parsePairInput(raw);
    if (target) {
      setHubAddress(cleanHubInput(target.origin));
      setPairCode(normCode(target.credential));
      return;
    }
    if (field === "host") setHubAddress(raw);
    else setPairCode(raw.toUpperCase());
  };

  const pick = (peer: DiscoveredPeer) => {
    setHubAddress(cleanHubInput(peer.endpoint));
    setError(null);
    window.setTimeout(() => codeRef.current?.focus(), 0);
  };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNote(null);
    let origin = hubOrigin(hubAddress);
    let credential = parseBareCode(pairCode) || "";
    const combined = parsePairInput(pairCode) || parsePairInput(hubAddress);
    if (combined) {
      origin = combined.origin;
      credential = combined.credential;
    }
    if (!origin || !credential) {
      setError("enter hub address and pair code — or paste a full invite link into either field");
      return;
    }
    setBusy(true);
    try {
      const label = (nameOverride.trim() || hostLabel).trim();
      const res = await api.connectHub({
        url: origin,
        code: credential,
        label,
        hub_label: cleanHubInput(origin),
      });
      if (!res.ok) throw new Error(res.error || "hub connect failed");
      writeRecentHub(origin);
      onConnected?.();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connectDirect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const target = parsePairInput(advPairInput);
    if (!target) {
      setError("paste a pair link (https://host/#pair=…) or type CODE@host");
      return;
    }
    setBusy(true);
    try {
      const probe = { ...blankInstance("pair-probe"), endpoint: { base_url: target.origin } };
      const res = await api.redeemPairToken(probe, target.credential);
      const mountError = relayMountError(String(res.mode || ""));
      if (mountError) throw new Error(mountError);
      if (!res.token) throw new Error("relay returned no token");
      let instName = res.host_id || "";
      try {
        instName = instName || new URL(target.origin).hostname;
      } catch {}
      const inst = blankInstance(instName || "remote");
      inst.endpoint = { base_url: target.origin, secret: res.token };
      await onSave(inst);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const inst = blankInstance(trimmed);
    inst.endpoint = { base_url: url.trim().replace(/\/+$/, ""), secret: secret.trim() || undefined };
    setBusy(true);
    setError(null);
    try {
      await onSave(inst);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const connectingAs = (nameOverride.trim() || hostLabel || "this device").trim();

  return (
    <Dialog open onClose={close} title="JOIN A HUB">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 space-y-4">
        <form onSubmit={(e) => void connect(e)} className="space-y-2">
          <label className="text-[11px] text-ink-muted uppercase tracking-wider block" htmlFor="join-hub-address">Hub address</label>
          <input
            id="join-hub-address"
            type="text"
            autoFocus
            aria-label="Hub address"
            placeholder="klanker.lolax.dev"
            value={hubAddress}
            onChange={(e) => smartPaste(e.target.value, "host")}
            className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
          />
          {recentHubs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {recentHubs.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => { setHubAddress(h); codeRef.current?.focus(); }}
                  className="px-2 py-1 border border-subtle rounded-full text-[10px] text-ink-muted hover:border-strong hover:text-ink-primary"
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          <label className="text-[11px] text-ink-muted uppercase tracking-wider block" htmlFor="join-hub-code">Pair code</label>
          <input
            id="join-hub-code"
            ref={codeRef}
            type="text"
            aria-label="Pair code"
            placeholder="ABCD-1234"
            value={pairCode}
            onChange={(e) => smartPaste(e.target.value, "code")}
            className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-2 text-ink-primary outline-none uppercase tracking-widest font-mono text-base"
          />
          <div className="flex items-center justify-between gap-2 text-[10px] text-ink-dim">
            <span>Connecting as {connectingAs}</span>
            <button type="button" onClick={() => setRenameOpen((v) => !v)} className="hover:text-ink-secondary underline underline-offset-2">
              rename
            </button>
          </div>
          {renameOpen && (
            <input
              type="text"
              aria-label="Device name override"
              placeholder={hostLabel || "device name"}
              value={nameOverride}
              onChange={(e) => setNameOverride(e.target.value)}
              className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
            />
          )}
          {note && <p className="text-[11px] text-ink-secondary">{note}</p>}
          {error && <p className="text-[11px] text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full min-h-9 px-4 py-1.5 bg-accent hover:bg-accent-hover text-accent-ink font-semibold rounded-md transition-colors disabled:opacity-50"
          >
            {busy ? "connecting…" : "Join hub"}
          </button>
        </form>

        <div className="border border-strong rounded-md p-2">
          <div className="px-1 pb-1 text-[10px] uppercase tracking-wider text-ink-dim">Nearby Tailscale devices</div>
          {offers && offers.length > 0 ? (
            <div className="space-y-1">
              {offers.map((peer) => (
                <button
                  key={peer.endpoint}
                  type="button"
                  onClick={() => pick(peer)}
                  className="w-full text-left min-h-9 px-2 py-1.5 rounded-md transition-colors text-ink-secondary hover:bg-elevated hover:text-ink-primary"
                >
                  {peer.hostname}
                  <span className="text-ink-dim"> {peer.endpoint.replace(/^https?:\/\//, "")}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center min-h-9 py-1" aria-label="Scanning for peers">
              <Radar className="w-4 h-4 text-ink-dim animate-pulse" />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="text-[10px] text-ink-dim hover:text-ink-secondary uppercase tracking-wider"
        >
          {advanced ? "− hide ops remote" : "+ advanced / ops remote"}
        </button>

        {advanced && (
          <div className="space-y-3 border border-strong rounded-md p-2.5">
            <p className="text-[10px] text-ink-dim">
              legacy direct mount — for relays without hub channel support. Pair links redeem straight into a stored remote;
              the manual form mounts a url+secret.
            </p>
            <form onSubmit={(e) => void connectDirect(e)} className="space-y-2">
              <label className="text-[11px] text-ink-muted uppercase tracking-wider block">remote pair link / code</label>
              <input
                type="text"
                placeholder="https://host/#pair=… or CODE@host"
                value={advPairInput}
                onChange={(e) => setAdvPairInput(e.target.value)}
                className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
              />
              <button type="submit" disabled={busy} className="w-full min-h-9 px-4 py-1.5 bg-hover text-ink-primary rounded-md disabled:opacity-50">
                {busy ? "pairing…" : "Pair remote"}
              </button>
            </form>
            <form onSubmit={handleManual} className="space-y-3 border-t border-strong pt-3">
              <input type="text" required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-elevated border border-strong rounded-md px-2.5 py-1.5 text-ink-primary outline-none" />
              <input type="text" placeholder="https://relay.example.com" value={url} onChange={(e) => setUrl(e.target.value)} className="w-full bg-elevated border border-strong rounded-md px-2.5 py-1.5 text-ink-primary outline-none" />
              <input type="password" placeholder="RELAY_SECRET of that instance" value={secret} onChange={(e) => setSecret(e.target.value)} className="w-full bg-elevated border border-strong rounded-md px-2.5 py-1.5 text-ink-primary outline-none" />
              <button type="submit" className="w-full min-h-9 px-4 py-1.5 bg-hover text-ink-primary rounded-md">Add manually</button>
            </form>
          </div>
        )}
      </div>
    </Dialog>
  );
};
