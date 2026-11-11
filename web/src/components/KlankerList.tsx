import React, { useState } from "react";
import { Plus, Radar, X } from "lucide-react";
import { ChatMessage, DiscoveredPeer, KlankerInstance, ProcessStatus } from "../types/klanker";
import { api } from "../services/api";
import { KlankerMark } from "./KlankerMark";

interface ChatListRow {
  id: string;
  session?: string;
  messages?: ChatMessage[];
}

interface KlankerListProps {
  instances: KlankerInstance[];
  activeId: string | null;
  unread: ReadonlySet<string>;
  statuses: Record<string, ProcessStatus | undefined>;
  onSelect: (instance: KlankerInstance) => void;
  onNew: () => void;
  onAddDiscovered: (peer: DiscoveredPeer) => void;
  chats: ChatListRow[];
  openChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
}

function rowHealth(row: ProcessStatus | undefined): "up" | "down" | "busy" {
  if (row?.state === "running" || row?.state === "not_owned") return "up";
  if (row?.state === "port_busy") return "busy";
  return "down";
}

function dotClass(row: ProcessStatus | undefined): string {
  const health = rowHealth(row);
  if (health === "down") return "bg-[#525252]";
  if (health === "busy") return "border border-white";
  return row?.state === "running" ? "bg-white animate-pulse" : "bg-white";
}

export const KlankerList: React.FC<KlankerListProps> = ({
  instances,
  activeId,
  unread,
  statuses,
  onSelect,
  onNew,
  onAddDiscovered,
  chats,
  openChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
}) => {
  const [discovering, setDiscovering] = useState(false);
  const [offers, setOffers] = useState<DiscoveredPeer[] | null>(null);
  const rows = instances.slice().sort((a, b) => Number(unread.has(b.id)) - Number(unread.has(a.id)));
  const known = new Set(
    instances.map((inst) => inst.endpoint?.base_url || inst.base_url || ""),
  );
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
  return (
    <aside className="h-full w-52 shrink-0 flex flex-col border-r border-[#262626] bg-[#000000]">
      <div
        className="h-12 shrink-0 flex items-center px-3 border-b border-[#262626] font-mono text-xs font-semibold tracking-wider text-white"
      >
        <KlankerMark size={20} className="mr-2 shrink-0" />
        <span>KLANKER</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {instances.length === 0 ? (
          <p className="px-3 py-3 text-[#525252] font-mono text-xs">No Klankers.</p>
        ) : (
          rows.map((inst) => {
            const row = statuses[inst.id];
            const selected = inst.id === activeId;
            const hot = unread.has(inst.id) && !selected;
            return (
              <div key={inst.id}>
              <button
                type="button"
                onClick={() => onSelect(inst)}
                title={rowHealth(row)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 font-mono text-xs transition-colors ${
                  selected ? "bg-[#141414] text-white" : "text-[#a3a3a3] hover:bg-[#181818]"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass(row)}`} />
                <span className={`truncate ${hot ? "font-semibold text-white" : ""}`}>{inst.name}</span>
                {hot ? <span className="ml-auto h-1.5 w-1.5 shrink-0 bg-white" /> : null}
              </button>
              {selected ? (
                <div>
                  <div className="max-h-24 overflow-y-auto">
                    {chats.map((chat, index) => {
                      const open = chat.id === openChatId;
                      const first = chat.messages?.find((m) => m.role === "user")?.content?.trim();
                      const label = first
                        ? first.length > 26
                          ? `${first.slice(0, 26)}…`
                          : first
                        : chat.session
                          ? chat.session
                          : `Chat ${index + 1}`;
                      return (
                        <div key={chat.id} className="group flex items-center">
                          <button
                            type="button"
                            onClick={() => onSelectChat(chat.id)}
                            title={first || label}
                            className={`flex-1 min-w-0 text-left pl-7 pr-1 py-1 font-mono text-[11px] truncate transition-colors ${
                              open ? "bg-[#141414] text-white" : "text-[#a3a3a3] hover:bg-[#181818]"
                            }`}
                          >
                            {label}
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteChat(chat.id)}
                            title="Delete chat"
                            className="shrink-0 p-0.5 mr-1 text-[#525252] opacity-0 group-hover:opacity-100 hover:text-white transition-opacity"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={onNewChat}
                    className="w-full text-left pl-7 pr-2 py-1 font-mono text-[11px] text-[#737373] hover:bg-[#181818] hover:text-white transition-colors"
                  >
                    New chat
                  </button>
                </div>
              ) : null}
              </div>
            );
          })
        )}
      </div>

      {offers !== null && (
        <div className="shrink-0 border-t border-[#262626] px-2 py-2 font-mono text-[11px]">
          {offers.length === 0 ? (
            <p className="text-[#525252] px-1">no discoveries</p>
          ) : (
            offers.map((peer) => {
              const added = known.has(peer.endpoint);
              return (
                <div key={peer.endpoint} className="flex items-center gap-2 px-1 py-1">
                  <span className="truncate text-[#a3a3a3]" title={peer.fqdn || peer.ip}>
                    {peer.hostname}
                    <span className="text-[#525252]"> {peer.endpoint.replace(/^https?:\/\//, "")}</span>
                  </span>
                  <button
                    type="button"
                    disabled={added}
                    onClick={() => onAddDiscovered(peer)}
                    className="ml-auto shrink-0 px-1.5 py-0.5 border border-[#262626] rounded text-[#a3a3a3] hover:text-white hover:border-white disabled:opacity-30 disabled:hover:text-[#a3a3a3] disabled:hover:border-[#262626]"
                  >
                    {added ? "added" : "+ add"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      <div className="shrink-0 p-2 border-t border-[#262626] space-y-1.5">
        <button
          type="button"
          onClick={runDiscovery}
          disabled={discovering}
          className="w-full flex items-center justify-center space-x-1.5 px-2.5 py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] text-[#a3a3a3] hover:text-white rounded text-xs font-mono transition-colors disabled:opacity-40"
        >
          <Radar className="w-3.5 h-3.5" />
          <span>{discovering ? "Scanning…" : "Discover"}</span>
        </button>
        <button
          type="button"
          onClick={onNew}
          className="w-full flex items-center justify-center space-x-1.5 px-2.5 py-1.5 bg-white hover:bg-[#e5e5e5] text-black rounded text-xs font-mono font-medium transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New</span>
        </button>
      </div>
    </aside>
  );
};
