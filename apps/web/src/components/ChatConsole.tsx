import React, { useState, useRef, useEffect } from "react";
import { ArrowUp, Bot, User, Square, Paperclip, RotateCcw, X } from "lucide-react";
import { shouldSubmitOnEnter, focusWithoutScroll } from "../chatUi";
import { splitThinking } from "../thinkingParse";
import { chatToJson, chatToMarkdown, downloadText, exportStem } from "../chatExport";
import { ChatMessage, KlankerInstance, ModelPick, PendingApproval, ProviderRow } from "../types/klanker";
import { CopyButton } from "./CopyButton";
import { ThinkingAccordion } from "./ThinkingAccordion";
import { ApprovalReview } from "./ApprovalReview";
import { MarkdownMessage } from "./MarkdownMessage";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { Popover } from "./ui/Popover";
import { HostPicker } from "./HostPicker";
import type { HostBinding, HostRow } from "../hostPicker";

export interface OutAttachment {
  data: string;
  mime?: string;
  name?: string;
}

/** Per-chat override: "" fields inherit the instance/host default. */
export type ChatPick = ModelPick;

export type ChatProviderRow = ProviderRow;

interface ChatConsoleProps {
  instance: KlankerInstance;
  /** Console headline — `Workspace · Persona` for the open chat
   *  (instance.name used to render here; the console is workspace-first). */
  title?: string;
  speakerName?: string;
  messages: ChatMessage[];
  input: string;
  onInput: (v: string) => void;
  onSendMessage: (
    msg: string,
    attachments?: OutAttachment[],
    opts?: { command?: boolean; reuseAssistant?: boolean }
  ) => void;
  onStop: () => void;
  isLoading: boolean;
  /** A turn on another device/channel is still running for this session. */
  remoteActive?: boolean;
  sendHold: boolean;
  streamStatus?: string | null;
  sessionLabel?: string;
  providers?: ChatProviderRow[];
  pick?: ChatPick;
  onPick?: (p: ChatPick) => void;
  /** Starred {provider,model} rows shown on top of the picker. */
  favorites?: ModelPick[];
  onStar?: (p: ModelPick, star: boolean) => void;
  /** Provider rows came from the offline cache. */
  providersStale?: boolean;
  /** Bound host offline — picker stays read-only on cached rows. */
  providersDisabled?: boolean;
  /** Per-chat host picker state (klanker#152); null hides the chip. */
  host?: {
    rows: HostRow[];
    binding: HostBinding;
    switching: boolean;
    note: string | null;
    onSwitch: (deviceId: string) => void;
  } | null;
  /** Label of the remote host whose turn paused for this approval —
   *  renders the remote banner variant inside the approval card. */
  remoteApprovalLabel?: string | null;
  pending: PendingApproval | null;
  deciding: boolean;
  decideError: string | null;
  onDecide: (allow: boolean, remember?: boolean) => void;
}

export const ChatConsole: React.FC<ChatConsoleProps> = ({
  instance,
  title,
  speakerName,
  messages,
  input,
  onInput,
  onSendMessage,
  onStop,
  isLoading,
  remoteActive,
  sendHold,
  streamStatus,
  sessionLabel,
  providers = [],
  pick,
  onPick,
  favorites = [],
  onStar,
  providersStale = false,
  providersDisabled = false,
  host = null,
  remoteApprovalLabel = null,
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
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let prevH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const nextH = el.clientHeight;
      const delta = prevH - nextH;
      prevH = nextH;
      if (stickRef.current) {
        el.scrollTop = el.scrollHeight;
      } else if (delta > 0) {
        el.scrollTop += delta;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const focus = () => focusWithoutScroll(textareaRef.current);
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

  const SLASH_COMMAND = /^\/(retry|undo|compress)(\s+\d+)?$/;
  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!input.trim() && files.length === 0) || isLoading || sendHold) return;
    stickRef.current = true;
    scrollToBottom();
    const typed = input.trim();
    // Trace commands never become user bubbles (klanker#169 U15).
    if (files.length === 0 && SLASH_COMMAND.test(typed)) {
      onSendMessage(typed, undefined, { command: true, reuseAssistant: typed === "/retry" });
      onInput("");
      return;
    }
    // Relay requires non-empty text; attach-only sends carry a marker.
    onSendMessage(typed || `attached ${files.length} file${files.length === 1 ? "" : "s"}`, files.length ? files : undefined);
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

  const addFiles = async (picked: File[]) => {
    if (!picked.length) return;
    const next = await Promise.all(picked.map(readFile));
    setFiles((cur) => [...cur, ...next]);
  };

  // Clipboard images/files land as attachment chips; a text-only paste
  // stays on the default textarea path (klanker#163 U08).
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const picked = Array.from(e.clipboardData?.files || []);
    if (!picked.length) return;
    e.preventDefault();
    void addFiles(picked);
  };

  const [dragOver, setDragOver] = useState(false);
  const onDrop = (e: React.DragEvent<HTMLFormElement>) => {
    const picked = Array.from(e.dataTransfer?.files || []);
    if (!picked.length) return;
    e.preventDefault();
    setDragOver(false);
    void addFiles(picked);
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

  // Regenerate (klanker#163 U08): resend the user message preceding the
  // latest assistant answer. Hover control on that bubble only.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "klanker" && messages[i].content) {
      lastAssistantIdx = i;
      break;
    }
  }
  // /retry rewinds the trace server-side and re-completes — no duplicate
  // user bubble, the answer streams into the existing bubble
  // (klanker#169 U15; the old path resent the user text as a new turn).
  const regenerate = () => {
    onSendMessage("/retry", undefined, { command: true, reuseAssistant: true });
  };
  const [exportOpen, setExportOpen] = useState(false);
  const streamingBubble = isLoading && last?.role === "klanker";
  const displaySpeaker = speakerName || instance.name;
  const headlineTitle = title || instance.name;
  const sessionText = sessionLabel || "new";
  const exportSessionLabel = `${headlineTitle} · ${sessionText}`;

  return (
    <div className="flex-1 flex flex-col bg-[#000000] overflow-hidden font-mono text-xs">
      {/* Console Top Toolbar — right-side controls only. The workspace >
          persona · chat breadcrumb already lives in the app Header; a
          second left-side copy here was pure duplication (klanker#158 U03). */}
      <div className="min-h-11 bg-[#0a0a0a] border-b border-[#262626] flex items-center justify-end px-3 text-[#737373] select-none touch-none">
        <div className="flex items-center space-x-2">
          {messages.length > 0 && (
            <Popover
              open={exportOpen}
              onOpenChange={setExportOpen}
              widthClass="w-32"
              trigger={
                <button
                  type="button"
                  title="Export this chat"
                  className="bg-[#0a0a0a] border border-[#262626] hover:border-[#525252] rounded-md px-2 py-1.5 text-[11px] text-[#d4d4d4] hover:text-white outline-none cursor-pointer"
                >
                  export
                </button>
              }
            >
              <div className="flex flex-col py-1">
                {(["md", "json"] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => {
                      setExportOpen(false);
                      const doc = {
                        agent: headlineTitle,
                        speaker: displaySpeaker,
                        session: exportSessionLabel,
                        messages,
                      };
                      const stem = exportStem(exportSessionLabel || "chat");
                      if (fmt === "md") downloadText(`${stem}.md`, chatToMarkdown(doc), "text/markdown");
                      else downloadText(`${stem}.json`, chatToJson(doc), "application/json");
                    }}
                    aria-label={`Export as .${fmt}`}
                    className="px-3 py-1.5 text-left text-[#a3a3a3] hover:bg-[#181818] hover:text-white"
                  >
                    .{fmt}
                  </button>
                ))}
              </div>
            </Popover>
          )}
          {host && (
            <HostPicker
              rows={host.rows}
              binding={host.binding}
              switching={host.switching}
              note={host.note}
              onSwitch={host.onSwitch}
            />
          )}
          {onPick && (
            <ProviderModelPicker
              providers={providers}
              favorites={favorites}
              stale={providersStale}
              disabled={providersDisabled}
              pick={pick ?? { provider: "", model: "" }}
              onPick={onPick}
              onStar={(p, star) => onStar?.(p, star)}
            />
          )}
          {isLoading && (
            <button
              onClick={onStop}
              title="Stop this run"
              className="inline-flex items-center gap-1 px-2 py-1.5 border border-[#262626] rounded-md hover:border-white hover:text-white transition-colors"
            >
              <Square className="w-3 h-3" />
              <span>stop</span>
            </button>
          )}
        </div>
      </div>

      {pending && (
        <ApprovalReview
          pending={pending}
          deciding={deciding}
          decideError={decideError}
          remoteApprovalLabel={remoteApprovalLabel}
          onDecide={onDecide}
        />
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
          messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              name={displaySpeaker}
              thinking={streamingBubble && m.id === last?.id && !m.content}
              streaming={streamingBubble && m.id === last?.id}
              streamStatus={streamingBubble && m.id === last?.id ? streamStatus : undefined}
              onRegenerate={i === lastAssistantIdx && !isLoading ? regenerate : undefined}
            />
          ))
        )}

        {(isLoading || (remoteActive && last?.role === "user")) && !streamingBubble && (
          <div className="flex flex-col items-start">
            <div className="flex items-center space-x-1.5 mb-1 text-[10px] text-[#525252] px-1">
              <Bot className="w-3 h-3 text-white" />
              <span className="text-white font-semibold">{displaySpeaker}</span>
              <span>•</span>
              <span className="animate-pulse text-white">thinking...</span>
            </div>
            <div className="bg-[#0a0a0a] border border-[#262626] rounded p-3 text-[#737373] flex items-center space-x-2">
              <span className="w-2 h-2 bg-white rounded-full animate-ping"></span>
              <span>{streamStatus || "Working..."}</span>
            </div>
          </div>
        )}

      </div>

      {/* Input Area */}
      <div className="composer touch-none px-3 pt-3 bg-[#000000] border-t border-[#262626] md:min-h-[73px] md:p-3 md:flex md:items-center">
        <form
          onSubmit={handleSubmit}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
          }}
          onDrop={onDrop}
          className={`w-full flex flex-col min-h-12 bg-[#121212] border focus-within:border-[#525252] rounded transition-colors ${
            dragOver ? "border-white" : "border-[#262626]"
          }`}
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
              onPaste={onPaste}
              placeholder={`Message ${displaySpeaker}...`}
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

const MessageBubble = React.memo(function MessageBubble({
  message,
  name,
  thinking,
  streaming = false,
  streamStatus = null,
  onRegenerate,
}: {
  message: ChatMessage;
  name: string;
  thinking: boolean;
  /** This bubble is the live-streaming one — think timer keeps ticking. */
  streaming?: boolean;
  /** Live turn status ("searching…", tool names) — rendered inside the
   *  streaming bubble itself: as the indicator while content is empty,
   *  as a subtle activity line under streaming markdown (klanker#169
   *  U15 — the empty-bubble gate used to hide this entirely). */
  streamStatus?: string | null;
  /** Latest assistant answer only: hover control resends the preceding
   *  user message (klanker#163 U08). */
  onRegenerate?: () => void;
}) {
  const mine = message.role === "user";
  // <think> extraction: reasoning sits in a collapsible accordion above
  // the answer body; while streaming an unclosed trailing tag counts too.
  const thinkSplit = !mine && message.content ? splitThinking(message.content) : null;
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
          {onRegenerate ? (
            <button
              type="button"
              onClick={onRegenerate}
              title="Regenerate — resend the previous user message"
              aria-label="Regenerate response"
              className="inline-flex !h-5 !w-5 items-center justify-center text-[#525252] hover:text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity [@media(hover:none)]:!h-11 [@media(hover:none)]:!w-11 [@media(hover:none)]:-my-3.5 [@media(hover:none)]:opacity-100"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          ) : null}
        </div>
        <div
          className={`min-w-0 max-w-full rounded border p-3 leading-relaxed select-text ${
            mine
              ? "border-[#333333] bg-[#141414] text-white"
              : "border-[#262626] bg-[#0a0a0a] text-[#e5e5e5]"
          }`}
        >
          {message.attachments?.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {message.attachments.map((name, i) => (
                <span
                  key={`${name}-${i}`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[#1f1f1f] border border-[#2e2e2e] rounded text-[10px] text-[#a3a3a3]"
                >
                  <Paperclip className="w-3 h-3 shrink-0" />
                  <span className="max-w-[180px] truncate">{name}</span>
                </span>
              ))}
            </div>
          ) : null}
          {thinkSplit?.thinking ? (
            <ThinkingAccordion thinking={thinkSplit.thinking} streaming={streaming && thinkSplit.thinkingOpen} />
          ) : null}
          {message.role === "klanker" && message.content ? (
            thinkSplit?.thinking && !thinkSplit.body && thinkSplit.thinkingOpen ? null : (
              <MarkdownMessage text={thinkSplit ? thinkSplit.body : message.content} />
            )
          ) : (
            <div className="whitespace-pre-wrap break-words">
              {message.content || (thinking ? streamStatus || "thinking..." : "")}
            </div>
          )}
          {streaming && message.content && streamStatus ? (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[#525252] animate-pulse">
              <span className="w-1.5 h-1.5 bg-white rounded-full animate-ping shrink-0" />
              <span className="truncate">{streamStatus}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

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
