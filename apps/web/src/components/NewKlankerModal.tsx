import React, { useEffect, useRef, useState } from "react";
import { Radar } from "lucide-react";
import { DiscoveredPeer, KlankerInstance } from "../types/klanker";
import { api } from "../services/api";
import {parseBareCode, parsePairInput, relayMountError, deviceConnectLabel } from "../pairLink";
import { Dialog } from "./ui/Dialog";

interface NewKlankerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (instance: KlankerInstance) => void | Promise<void>;
  /** Fired after a successful /v1/hub/connect (no instance row is made —
   *  the link shows in the devices panel). */
  onConnected?: () => void;
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

export const NewKlankerModal: React.FC<NewKlankerModalProps> = ({ isOpen, onClose, onSave, onConnected }) => {
  const [pairInput, setPairInput] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pickedPeer, setPickedPeer] = useState<DiscoveredPeer | null>(null);
  const [offers, setOffers] = useState<DiscoveredPeer[] | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [advPairInput, setAdvPairInput] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Scan on open, then keep scanning while the modal is up so peers
  // pop in live. One scan at a time; a failed pass keeps the last good
  // list instead of blanking it.
  // Prefill the device name from this host's own label — a connect never
  // registers as "127.0.0.1" on the hub (klanker#159 U04).
  useEffect(() => {
    if (!isOpen) return;
    let stop = false;
    void api
      .fetchHostInfo()
      .then((info) => {
        if (!stop && info.host_label) {
          setDeviceName((cur) => cur || info.host_label);
        }
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
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
    setPairInput("");
    setError(null);
    setNote(null);
    setPickedPeer(null);
    setOffers(null);
    setAdvanced(false);
    setAdvPairInput("");
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

  /** Primary flow (klanker#151): paste a hub/ws invite link or code —
   *  the local relay redeems it via /v1/hub/connect, persists the link
   *  and live-attaches the channel (device pair + ws grant in one step). */
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNote(null);
    let target = parsePairInput(pairInput);
    if (!target && pickedPeer) {
      const code = parseBareCode(pairInput);
      if (code) target = { origin: pickedPeer.endpoint, credential: code };
    }
    if (!target) {
      setError(
        pickedPeer
          ? `enter the invite code shown on ${pickedPeer.hostname}`
          : "paste an invite link (https://host/#pair=…) or type CODE@host"
      );
      return;
    }
    setBusy(true);
    try {
      const res = await api.connectHub({
        url: target.origin,
        code: target.credential,
        label: deviceConnectLabel(deviceName, pickedPeer?.hostname),
      });
      if (!res.ok) throw new Error(res.error || "hub connect failed");
      onConnected?.();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Advanced / ops remote: redeem a mode=remote pair code directly and
   *  mount the relay over /v1/remotes — the pre-hub path for relays
   *  without channel support. */
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
      if (mountError) {
        throw new Error(mountError);
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
    <Dialog open onClose={close} title="CONNECT">
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 space-y-4">
          <form onSubmit={(e) => void connect(e)} className="space-y-2">
            <label className="text-[11px] text-ink-muted uppercase tracking-wider block">
              {pickedPeer ? `invite code for ${pickedPeer.hostname}` : "connect to hub / pair device"}
            </label>
            <input
              ref={inputRef}
              type="text"
              autoFocus
              placeholder={pickedPeer ? "XXXX-XXXX" : "https://host/#pair=… or CODE@host"}
              value={pairInput}
              onChange={(e) => setPairInput(e.target.value)}
              className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
            />
            <input
              type="text"
              aria-label="Device name"
              placeholder="device name — how the hub lists this machine"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
            />
            {pickedPeer && (
              <p className="text-[10px] text-ink-dim">
                mint an invite on {pickedPeer.endpoint.replace(/^https?:\/\//, "")} (Devices → + Pair device), then type it here.
              </p>
            )}
            {note && <p className="text-[11px] text-ink-secondary">{note}</p>}
            {error && <p className="text-[11px] text-red-500">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full min-h-9 px-4 py-1.5 bg-accent hover:bg-accent-hover text-accent-ink font-semibold rounded-md transition-colors disabled:opacity-50"
            >
              {busy ? "connecting…" : "Connect"}
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
                    className={`w-full text-left min-h-9 px-2 py-1.5 rounded-md transition-colors ${
                      pickedPeer?.endpoint === peer.endpoint
                        ? "bg-hover text-ink-primary"
                        : "text-ink-secondary hover:bg-elevated hover:text-ink-primary"
                    }`}
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
                legacy direct mount — for relays without hub channel support. Pair links redeem
                straight into a stored remote; the manual form mounts a url+secret.
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
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full min-h-9 px-4 py-1.5 bg-hover hover:bg-hover text-ink-primary rounded-md transition-colors disabled:opacity-50"
                >
                  {busy ? "pairing…" : "Pair remote"}
                </button>
              </form>
              <form onSubmit={handleManual} className="space-y-3 border-t border-strong pt-3">
                <div>
                  <label className="text-[11px] text-ink-muted uppercase tracking-wider block mb-1">Name</label>
                  <input
                    type="text"
                    required
                    placeholder="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-ink-muted uppercase tracking-wider block mb-1">Relay URL</label>
                  <input
                    type="text"
                    placeholder="https://relay.example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-ink-muted uppercase tracking-wider block mb-1">Instance secret</label>
                  <input
                    type="password"
                    placeholder="RELAY_SECRET of that instance"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    className="w-full bg-elevated border border-strong focus:border-accent rounded-md px-2.5 py-1.5 text-ink-primary outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full min-h-9 px-4 py-1.5 bg-hover hover:bg-hover text-ink-primary rounded-md transition-colors"
                >
                  Add manually
                </button>
              </form>
            </div>
          )}
        </div>
    </Dialog>
  );
};
