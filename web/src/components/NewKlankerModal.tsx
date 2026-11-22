import React, { useEffect, useRef, useState } from "react";
import { Radar, X } from "lucide-react";
import { DiscoveredPeer, KlankerInstance } from "../types/klanker";
import { api } from "../services/api";
import { parseBareCode, parsePairInput } from "../pairLink";

interface NewKlankerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (instance: KlankerInstance) => void;
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
  const [discovering, setDiscovering] = useState(false);
  const [offers, setOffers] = useState<DiscoveredPeer[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scan when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    let stop = false;
    setDiscovering(true);
    api
      .discoverPeers()
      .then((peers) => !stop && setOffers(peers))
      .catch(() => !stop && setOffers([]))
      .finally(() => !stop && setDiscovering(false));
    return () => {
      stop = true;
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

  const runDiscovery = async () => {
    setDiscovering(true);
    try {
      setOffers(await api.discoverPeers());
    } catch {
      setOffers([]);
    } finally {
      setDiscovering(false);
    }
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
      onSave(inst);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleManual = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const inst = blankInstance(trimmed);
    inst.endpoint = {
      base_url: url.trim().replace(/\/+$/, ""),
      secret: secret.trim() || undefined,
    };
    onSave(inst);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
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
            <button
              type="button"
              onClick={runDiscovery}
              disabled={discovering}
              className="w-full flex items-center justify-center gap-1.5 min-h-9 px-2 py-1 text-[#a3a3a3] hover:text-white disabled:opacity-40"
            >
              <Radar className={`w-3 h-3 ${discovering ? "animate-pulse" : ""}`} />
              <span>{discovering ? "scanning…" : "rescan network"}</span>
            </button>
            {offers !== null &&
              (offers.length === 0 ? (
                <p className="pt-2 text-[#525252] text-center">no discoveries</p>
              ) : (
                <div className="pt-2 space-y-1">
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
              ))}
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
