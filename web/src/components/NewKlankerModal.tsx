import React, { useState } from "react";
import { Radar, X } from "lucide-react";
import { DiscoveredPeer, KlankerInstance } from "../types/klanker";
import { api } from "../services/api";

interface NewKlankerModalProps {
  isOpen: boolean;
  autoDiscover?: boolean;
  onClose: () => void;
  onSave: (instance: KlankerInstance) => void;
}

export const NewKlankerModal: React.FC<NewKlankerModalProps> = ({ isOpen, autoDiscover, onClose, onSave }) => {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [offers, setOffers] = useState<DiscoveredPeer[] | null>(null);

  React.useEffect(() => {
    if (isOpen && autoDiscover) void runDiscovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => {
    setName("");
    setUrl("");
    setOffers(null);
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
    setName(peer.hostname);
    setUrl(peer.endpoint);
    setOffers(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    const newInst: KlankerInstance = {
      id: crypto.randomUUID(),
      name: trimmed,
      slug: trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      role: "remote",
      provider: "",
      model: "",
      workspace: "",
      lock_workspace: false,
      port: 0,
      system_prompt: "",
      endpoint: { base_url: url.trim().replace(/\/+$/, "") },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      kind: "remote",
    };

    onSave(newInst);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#0a0a0a] border border-[#262626] w-full max-w-sm rounded-lg shadow-2xl overflow-hidden font-mono text-xs">
        <div className="px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider">ADD HOST</span>
          <button type="button" onClick={close} className="text-[#737373] hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="text-[11px] text-[#737373] uppercase tracking-wider block mb-1">Name</label>
            <input
              type="text"
              required
              autoFocus
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
              placeholder="https://relay.example.com (empty = this origin)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none"
            />
          </div>

          <div className="border border-[#262626] rounded p-2">
            <button
              type="button"
              onClick={runDiscovery}
              disabled={discovering}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[#a3a3a3] hover:text-white disabled:opacity-40"
            >
              <Radar className="w-3 h-3" />
              <span>{discovering ? "scanning…" : "discover on network"}</span>
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
                      className="w-full text-left px-2 py-1 text-[#a3a3a3] hover:bg-[#141414] hover:text-white rounded"
                    >
                      {peer.hostname}
                      <span className="text-[#525252]"> {peer.endpoint.replace(/^https?:\/\//, "")}</span>
                    </button>
                  ))}
                </div>
              ))}
          </div>

          <div className="flex items-center justify-end space-x-2">
            <button type="button" onClick={close} className="px-3 py-1.5 text-[#737373] hover:text-white transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-white hover:bg-[#e5e5e5] text-black font-semibold rounded transition-colors"
            >
              Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
