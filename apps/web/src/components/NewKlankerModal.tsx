import React, { useEffect, useRef, useState } from "react";
import { Radar, X } from "lucide-react";
import { DiscoveredPeer, KlankerInstance } from "../types/klanker";
import { api } from "../services/api";
import { parseBareCode, parsePairInput } from "../pairLink";

interface NewKlankerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (instance: KlankerInstance) => void | Promise<void>;
}

function blankInstance(name: string): KlankerInstance {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    // saveKlanker resolves the final unique slug-id; seed it here.
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

export const NewKlankerModal: React.FC<NewKlankerModalProps> = ({ isOpen, onClose, onSave }) => {
  const [pairInput, setPairInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedPeer, setPickedPeer] = useState<DiscoveredPeer | null>(null);
  const [offers, setOffers] = useState<DiscoveredPeer[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Scan on open, then keep scanning while the modal is up so peers
  // pop in live. One scan at a time; a failed pass keeps the last good
  // list instead of blanking it.
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
    setPairInput("");
    setError(null);
    setPickedPeer(null);
    setOffers(null);
    setAdvanced(false);
    setName("");
    setUrl("");
    setSecret("");
    onClose();
  };

  const pick = (peer: DiscoveredPeer) => {
    setPickedPeer(peer);
    setPairInput("");
    setError(null);
    inputRef.current?.focus();
  };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    let target = parsePairInput(pairInput);
    if (!target && pickedPeer) {
      const code = parseBareCode(pairInput);
      if (code) target = { origin: pickedPeer.endpoint, credential: code };
    }
    if (!target) {
      setError(
        pickedPeer
          ? `enter the pair code shown on ${pickedPeer.hostname}`
          : "paste a pair link (https://host/#pair=…) or type CODE@host"
      );
      return;
    }
    setBusy(true);
    try {
      const probe = { ...blankInstance("pair-probe"), endpoint: { base_url: target.origin } };
      const res = await api.redeemPairToken(probe, target.credential);
      if (res.mode === "web") {
        throw new Error("that link pairs a browser — open it on the device itself");
      }
      if (!res.token) {
        throw new Error("relay returned no token");
      }
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
    inst.endpoint = {
      base_url: url.trim().replace(/\/+$/, ""),
      secret: secret.trim() || undefined,
    };
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

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="modal-card flex flex-col bg-[#0a0a0a] border border-[#262626] w-full max-w-sm rounded-lg shadow-2xl overflow-hidden font-mono text-xs">
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider">CONNECT</span>
          <button type="button" onClick={close} className="inline-flex h-11 w-11 items-center justify-center text-[#737373] hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 space-y-4">
          <form onSubmit={(e) => void connect(e)} className="space-y-2">
            <label className="text-[11px] text-[#737373] uppercase tracking-wider block">
              {pickedPeer ? `pair code for ${pickedPeer.hostname}` : "pair link or code"}
            </label>
            <input
              ref={inputRef}
              type="text"
              autoFocus
              placeholder={pickedPeer ? "XXXX-XXXX" : "https://host/#pair=… or CODE@host"}
              value={pairInput}
              onChange={(e) => setPairInput(e.target.value)}
              className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none"
            />
            {pickedPeer && (
              <p className="text-[10px] text-[#525252]">
                mint a code on {pickedPeer.endpoint.replace(/^https?:\/\//, "")} (pair → remote cli), then type it here.
              </p>
            )}
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full min-h-9 px-4 py-1.5 bg-white hover:bg-[#e5e5e5] text-black font-semibold rounded transition-colors disabled:opacity-50"
            >
              {busy ? "connecting…" : "Connect"}
            </button>
          </form>

          <div className="border border-[#262626] rounded p-2">
            {offers && offers.length > 0 ? (
              <div className="space-y-1">
                {offers.map((peer) => (
                  <button
                    key={peer.endpoint}
                    type="button"
                    onClick={() => pick(peer)}
                    className={`w-full text-left min-h-9 px-2 py-1.5 rounded transition-colors ${
                      pickedPeer?.endpoint === peer.endpoint
                        ? "bg-[#1f1f1f] text-white"
                        : "text-[#a3a3a3] hover:bg-[#141414] hover:text-white"
                    }`}
                  >
                    {peer.hostname}
                    <span className="text-[#525252]"> {peer.endpoint.replace(/^https?:\/\//, "")}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center min-h-9 py-1" aria-label="Scanning for peers">
                <Radar className="w-4 h-4 text-[#525252] animate-pulse" />
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-[10px] text-[#525252] hover:text-[#a3a3a3] uppercase tracking-wider"
          >
            {advanced ? "− hide manual url+secret" : "+ old relay? manual url+secret"}
          </button>

          {advanced && (
            <form onSubmit={handleManual} className="space-y-3 border border-[#262626] rounded p-2.5">
              <div>
                <label className="text-[11px] text-[#737373] uppercase tracking-wider block mb-1">Name</label>
                <input
                  type="text"
                  required
                  placeholder="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] text-[#737373] uppercase tracking-wider block mb-1">Relay URL</label>
                <input
                  type="text"
                  placeholder="https://relay.example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] text-[#737373] uppercase tracking-wider block mb-1">Instance secret</label>
                <input
                  type="password"
                  placeholder="RELAY_SECRET of that instance"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none"
                />
              </div>
              <button
                type="submit"
                className="w-full min-h-9 px-4 py-1.5 bg-[#1f1f1f] hover:bg-[#262626] text-white rounded transition-colors"
              >
                Add manually
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
