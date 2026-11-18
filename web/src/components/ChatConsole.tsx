import React, { useState, useRef, useEffect } from "react";
import { Terminal, Trash2, ArrowUp, Bot, User, Square, Paperclip, X } from "lucide-react";
import { shouldSubmitOnEnter } from "../chatUi";
import { ChatMessage, KlankerInstance, PendingApproval } from "../types/klanker";
import { CopyButton } from "./CopyButton";
import { MarkdownMessage } from "./MarkdownMessage";

export interface OutAttachment {
  data: string;
  mime?: string;
  name?: string;
}

interface ChatConsoleProps {
  instance: KlankerInstance;
  speakerName?: string;
  messages: ChatMessage[];
  input: string;
  onInput: (v: string) => void;
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
  speakerName,
  messages,
  input,
  onInput,
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
  const [files, setFiles] = useState<OutAttachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [messages, isLoading]);

  useEffect(() => {
    const focus = () => textareaRef.current?.focus();
    window.addEventListener("klanker:focus-composer", focus);
    return () => window.removeEventListener("klanker:focus-composer", focus);
  }, []);

  const resizeComposer = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const overflow = el.scrollHeight > 140;
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    // 1-line input: pans die on the touch-none composer. Overflowing draft:
    // the textarea implements its own pan-y scroll, ancestor none doesn't block it.
    el.style.overflowY = overflow ? "auto" : "hidden";
    el.style.touchAction = overflow ? "pan-y" : "manipulation";
  };

  useEffect(resizeComposer, [input]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!input.trim() && files.length === 0) || isLoading || sendHold) return;
    stickRef.current = true;
    scrollToBottom();
    // Relay requires non-empty text; attach-only sends carry a marker.
    onSendMessage(input.trim() || `attached ${files.length} file${files.length === 1 ? "" : "s"}`, files.length ? files : undefined);
    onInput("");
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

  const coarsePointer = useCoarsePointer();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !shouldSubmitOnEnter({
        key: e.key,
        shiftKey: e.shiftKey,
        composing: e.nativeEvent.isComposing,
        coarsePointer,
      })
    ) {
      return;
    }
    e.preventDefault();
    handleSubmit();
  };

  const last = messages[messages.length - 1];
  const streamingBubble = isLoading && last?.role === "klanker";
  const displaySpeaker = speakerName || instance.name;

  return (
    <div className="flex-1 flex flex-col bg-[#000000] overflow-hidden font-mono text-xs">
      {/* Console Top Toolbar */}
      <div className="min-h-11 bg-[#0a0a0a] border-b border-[#262626] flex items-center justify-between px-3 text-[#737373] select-none touch-none">
        <div className="flex min-w-0 items-center space-x-2">
          <Terminal className="w-3.5 h-3.5 shrink-0 text-white" />
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
              className="inline-flex h-11 items-center gap-1 px-3 border border-[#262626] rounded hover:border-white hover:text-white transition-colors"
            >
              <Square className="w-3 h-3" />
              <span>stop</span>
            </button>
          )}
          <button
            onClick={onClearMessages}
            title="Clear Console"
            className="inline-flex h-11 w-11 items-center justify-center hover:text-white transition-colors"
            aria-label="Clear console"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {pending && (
        <div className="mx-3 mt-3 border border-[#262626] bg-[#0a0a0a] rounded p-3">
          <div className="text-[10px] uppercase tracking-wider text-[#737373]">Approval</div>
          <div className="mt-1 text-white whitespace-pre-wrap break-words select-text">
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
              className="inline-flex h-11 items-center px-4 bg-[#141414] hover:bg-[#1f1f1f] border border-[#262626] rounded text-[11px] text-[#a3a3a3] hover:text-white transition-colors disabled:opacity-50"
            >
              Deny
            </button>
            <button
              type="button"
              disabled={deciding}
              onClick={() => onDecide(true)}
              className="inline-flex h-11 items-center px-4 bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black rounded text-[11px] transition-colors"
            >
              Allow
            </button>
          </div>
        </div>
      )}

      {/* Message List */}
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 overflow-y-auto overscroll-y-contain p-4 space-y-4 select-text"
      >
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
            <MessageBubble
              key={m.id}
              message={m}
              name={displaySpeaker}
              thinking={streamingBubble && m.id === last?.id && !m.content}
            />
          ))
        )}

        {isLoading && !streamingBubble && (
          <div className="flex flex-col items-start">
            <div className="flex items-center space-x-1.5 mb-1 text-[10px] text-[#525252] px-1">
              <Bot className="w-3 h-3 text-white" />
              <span className="text-white font-semibold">{displaySpeaker}</span>
              <span>•</span>
              <span className="animate-pulse text-white">thinking...</span>
            </div>
            <div className="bg-[#0a0a0a] border border-[#262626] rounded p-3 text-[#737373] flex items-center space-x-2">
              <span className="w-2 h-2 bg-white rounded-full animate-ping"></span>
              <span>{streamStatus || "Streaming tokens from harness..."}</span>
            </div>
          </div>
        )}

      </div>

      {/* Input Area */}
      <div className="composer touch-none px-3 pt-2 bg-[#000000] border-t border-[#262626] md:min-h-[73px] md:p-3 md:flex md:items-center">
        <form
          onSubmit={handleSubmit}
          className="w-full flex flex-col min-h-12 bg-[#121212] border border-[#262626] focus-within:border-[#525252] rounded transition-colors"
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
              {files.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 bg-[#1f1f1f] border border-[#2e2e2e] rounded text-[11px] text-[#a3a3a3]"
                >
                  <Paperclip className="w-3.5 h-3.5 shrink-0" />
                  <span className="max-w-[160px] truncate">{f.name || "file"}</span>
                  <button
                    type="button"
                    onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                    className="inline-flex h-5 w-5 min-h-0 min-w-0 items-center justify-center rounded hover:bg-white/10 hover:text-white"
                    aria-label={`Remove ${f.name || "attachment"}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-stretch gap-0.5 pl-1 pr-[5px] min-h-[46px]">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={onPickFiles}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="Attach files"
              aria-label="Attach files"
              className="inline-flex w-11 min-h-0 min-w-0 shrink-0 items-center justify-center text-[#737373] hover:text-white transition-colors"
            >
              <Paperclip className="w-4 h-4" />
            </button>
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => onInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${instance.name}...`}
              className="w-full min-w-0 flex-1 self-center bg-transparent border-0 py-2 text-white outline-none resize-none overscroll-y-contain font-mono text-base leading-snug placeholder-[#525252] md:text-sm"
            />
            <button
              type="submit"
              disabled={(!input.trim() && files.length === 0) || isLoading || sendHold}
              title="Send"
              aria-label="Send message"
              className="self-center inline-flex h-11 w-11 md:h-9 md:w-9 shrink-0 items-center justify-center rounded bg-white hover:bg-[#e5e5e5] disabled:bg-[#262626] disabled:text-[#525252] text-black transition-colors"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

function MessageBubble({
  message,
  name,
  thinking,
}: {
  message: ChatMessage;
  name: string;
  thinking: boolean;
}) {
  const mine = message.role === "user";
  return (
    <div className={`group flex w-full ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`flex min-w-0 max-w-[85%] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div className="mb-1 flex select-none items-center space-x-1.5 px-1 text-[10px] text-[#525252]">
          {mine ? (
            <>
              <span>USER</span>
              <User className="h-3 w-3" />
            </>
          ) : (
            <>
              <Bot className="h-3 w-3 text-white" />
              <span className="font-semibold text-white">{name}</span>
            </>
          )}
          <span>•</span>
          <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
          {message.elapsed_ms ? (
            <>
              <span>•</span>
              <span className="text-[#737373]">{message.elapsed_ms}ms</span>
            </>
          ) : null}
          {message.content ? (
            <CopyButton
              text={message.content}
              label="Copy message"
              borderless
              className="!h-5 !w-5 text-[#525252] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:!h-11 [@media(hover:none)]:!w-11 [@media(hover:none)]:-my-3.5 [@media(hover:none)]:opacity-100"
            />
          ) : null}
        </div>
        <div
          className={`min-w-0 max-w-full rounded border p-3 leading-relaxed select-text ${
            mine
              ? "border-[#333333] bg-[#141414] text-white"
              : "border-[#262626] bg-[#0a0a0a] text-[#e5e5e5]"
          }`}
        >
          {message.role === "klanker" && message.content ? (
            <MarkdownMessage text={message.content} />
          ) : (
            <div className="whitespace-pre-wrap break-words">
              {message.content || (thinking ? "thinking..." : "")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(pointer: coarse)").matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    const onChange = () => setCoarse(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return coarse;
}
