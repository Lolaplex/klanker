import React, { useState, useRef, useEffect } from "react";
import { Terminal, Trash2, CornerDownLeft, Bot, User, Square, Paperclip, X } from "lucide-react";
import { ChatMessage, KlankerInstance, PendingApproval } from "../types/klanker";

export interface OutAttachment {
  data: string;
  mime?: string;
  name?: string;
}

interface ChatConsoleProps {
  instance: KlankerInstance;
  messages: ChatMessage[];
  onSendMessage: (msg: string, attachments?: OutAttachment[]) => void;
  onClearMessages: () => void;
  onStop: () => void;
  isLoading: boolean;
  sendHold: boolean;
  streamStatus?: string | null;
  sessionLabel?: string;
  pending: PendingApproval | null;
  deciding: boolean;
  decideError: string | null;
  onDecide: (allow: boolean) => void;
}

export const ChatConsole: React.FC<ChatConsoleProps> = ({
  instance,
  messages,
  onSendMessage,
  onClearMessages,
  onStop,
  isLoading,
  sendHold,
  streamStatus,
  sessionLabel,
  pending,
  deciding,
  decideError,
  onDecide,
}) => {
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<OutAttachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    window.addEventListener("klanker:focus-composer", focus);
    return () => window.removeEventListener("klanker:focus-composer", focus);
  }, []);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!input.trim() && files.length === 0) || isLoading || sendHold) return;
    // Relay requires non-empty text; attach-only sends carry a marker.
    onSendMessage(input.trim() || `attached ${files.length} file${files.length === 1 ? "" : "s"}`, files.length ? files : undefined);
    setInput("");
    setFiles([]);
  };

  const readFile = (f: File): Promise<OutAttachment> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const raw = String(r.result || "");
        resolve({
          data: raw.includes(",") ? raw.split(",", 2)[1] : raw,
          mime: f.type || undefined,
          name: f.name,
        });
      };
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length) return;
    const next = await Promise.all(picked.map(readFile));
    setFiles((cur) => [...cur, ...next]);
    e.target.value = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const last = messages[messages.length - 1];
  const streamingBubble = isLoading && last?.role === "klanker";

  return (
    <div className="flex-1 flex flex-col bg-[#000000] overflow-hidden font-mono text-xs">
      {/* Console Top Toolbar */}
      <div className="h-9 bg-[#0a0a0a] border-b border-[#262626] flex items-center justify-between px-3 text-[#737373]">
        <div className="flex items-center space-x-2">
          <Terminal className="w-3.5 h-3.5 text-white" />
          <span className="font-semibold text-white tracking-wider uppercase truncate">
            {instance.name}
            <span className="text-[#525252] font-normal normal-case"> · {sessionLabel || "new"}</span>
          </span>
        </div>

        <div className="flex items-center space-x-2">
          {isLoading && (
            <button
              onClick={onStop}
              title="Stop this run"
              className="flex items-center space-x-1 px-1.5 py-0.5 border border-[#262626] rounded hover:border-white hover:text-white transition-colors"
            >
              <Square className="w-3 h-3" />
              <span>stop</span>
            </button>
          )}
          <button
            onClick={onClearMessages}
            title="Clear Console"
            className="p-1 hover:text-white transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {pending && (
        <div className="mx-3 mt-3 border border-[#262626] bg-[#0a0a0a] rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-[#737373]">Approval</div>
          <div className="mt-1 text-white whitespace-pre-wrap break-words">
            {pending.summary || pending.tool}
          </div>
          {decideError && (
            <div className="mt-1 text-[11px] text-[#a3a3a3] break-words">{decideError}</div>
          )}
          <div className="mt-2 flex items-center space-x-2">
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide(false)}
              className="px-2 py-0.5 bg-[#141414] hover:bg-[#1f1f1f] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white transition-colors disabled:opacity-50"
            >
              Deny
            </button>
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide(true)}
              className="px-2 py-0.5 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded text-[11px] transition-colors"
            >
              Allow
            </button>
          </div>
        </div>
      )}

      {/* Message List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[#525252]">
            <div className="w-12 h-12 border border-[#262626] rounded-full flex items-center justify-center mb-3">
              <Bot className="w-6 h-6 text-[#737373]" />
            </div>
            <div className="text-white font-medium mb-1">Klanker is standby.</div>
            <p className="max-w-md text-[11px] text-[#737373]">
              Send a message. The reply streams back here.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col ${
                m.role === "user" ? "items-end" : "items-start"
              }`}
            >
              <div className="flex items-center space-x-1.5 mb-1 text-[10px] text-[#525252] px-1">
                {m.role === "user" ? (
                  <>
                    <span>USER</span>
                    <User className="w-3 h-3" />
                  </>
                ) : (
                  <>
                    <Bot className="w-3 h-3 text-white" />
                    <span className="text-white font-semibold">{instance.name}</span>
                  </>
                )}
                <span>•</span>
                <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                {m.elapsed_ms && (
                  <>
                    <span>•</span>
                    <span className="text-[#737373]">{m.elapsed_ms}ms</span>
                  </>
                )}
              </div>

              <div
                className={`max-w-[85%] rounded p-3 border whitespace-pre-wrap leading-relaxed ${
                  m.role === "user"
                    ? "bg-[#141414] border-[#333333] text-white"
                    : "bg-[#0a0a0a] border-[#262626] text-[#e5e5e5]"
                }`}
              >
                {m.content || (streamingBubble && m.id === last?.id ? "thinking..." : "")}
              </div>
            </div>
          ))
        )}

        {isLoading && !streamingBubble && (
          <div className="flex flex-col items-start">
            <div className="flex items-center space-x-1.5 mb-1 text-[10px] text-[#525252] px-1">
              <Bot className="w-3 h-3 text-white" />
              <span className="text-white font-semibold">{instance.name}</span>
              <span>•</span>
              <span className="animate-pulse text-white">thinking...</span>
            </div>
            <div className="bg-[#0a0a0a] border border-[#262626] rounded p-3 text-[#737373] flex items-center space-x-2">
              <span className="w-2 h-2 bg-white rounded-full animate-ping"></span>
              <span>{streamStatus || "Streaming tokens from harness..."}</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="composer p-3 bg-[#0a0a0a] border-t border-[#262626]">
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="inline-flex items-center space-x-1 px-2 py-0.5 bg-[#141414] border border-[#262626] rounded text-[10px] text-[#a3a3a3]"
              >
                <Paperclip className="w-3 h-3" />
                <span className="max-w-[140px] truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                  className="hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <form onSubmit={handleSubmit} className="relative flex items-end">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={onPickFiles}
          />
          <textarea
            ref={textareaRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${instance.name}...`}
            className="w-full bg-[#121212] border border-[#262626] focus:border-white rounded p-2.5 pr-20 text-white outline-none resize-none font-mono text-xs leading-tight placeholder-[#525252]"
          />
          <div className="absolute right-2 bottom-2 flex items-center space-x-1.5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="Attach files"
              className="p-1.5 border border-[#262626] hover:border-white text-[#737373] hover:text-white rounded transition-colors"
            >
              <Paperclip className="w-3.5 h-3.5" />
            </button>
            <button
              type="submit"
              disabled={(!input.trim() && files.length === 0) || isLoading || sendHold}
              className="p-1.5 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded transition-colors"
            >
              <CornerDownLeft className="w-3.5 h-3.5" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
