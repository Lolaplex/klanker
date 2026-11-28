import React, { useState, useRef, useEffect } from "react";
import { Bot, Copy, User, Paperclip, RotateCcw, GitFork, Volume2 } from "lucide-react";
import { shouldSubmitOnEnter, focusWithoutScroll } from "../chatUi";
import { splitThinking } from "../thinkingParse";
import { ChatMessage, KlankerInstance, ModelPick, PendingApproval, ProviderRow } from "../types/klanker";
import { CopyButton } from "./CopyButton";
import { ThinkingAccordion } from "./ThinkingAccordion";
import { ApprovalReview } from "./ApprovalReview";
import { MarkdownMessage } from "./MarkdownMessage";
import type { HostBinding, HostRow } from "../hostPicker";
import { api } from "../services/api";
import { injectSteer, speakText } from "../services/streamExtrasApi";
import { asSteerEvent, TURN_EVENT_NAME, type TurnEvent } from "../turnStream";
import { PowerComposer } from "./PowerComposer";
import { applyLiveTurnEvent, stepsFromSessionEvents, ToolTimeline, usageFromTurnEvent, type TimelineStep, type UsageStats } from "./ToolTimeline";
import { useContextMenu } from "./ui/ContextMenu";

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
  /** Explicit workspace/persona ids for power-composer and session-event
   *  wiring. When absent the legacy `title` format (`workspace · persona`)
   *  is parsed. */
  workspace?: string;
  persona?: string;
  providers?: ChatProviderRow[];
  pick?: ChatPick;
  acpMode?: string;
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
  /** Rich workspace-aware empty state rendered instead of the fallback. */
  emptyState?: React.ReactNode;
  /** FIFO approval queue position (`1/N`) for the visible row. */
  approvalQueue?: { index: number; total: number };
}

export const ChatConsole: React.FC<ChatConsoleProps> = ({
  instance,
  title,
  speakerName,
  messages,
  input,
  onInput,
  onSendMessage,
  isLoading,
  remoteActive,
  sendHold,
  streamStatus,
  sessionLabel,
  workspace,
  persona,
  providers = [],
  pick,
  acpMode = "",
  remoteApprovalLabel = null,
  pending,
  deciding,
  decideError,
  onDecide,
  emptyState,
  approvalQueue,
}) => {
  const [files, setFiles] = useState<OutAttachment[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageCacheRef = useRef(new Map<string, string>());
  const [timelineSteps, setTimelineSteps] = useState<TimelineStep[]>([]);
  const [timelineScope, setTimelineScope] = useState<"latest turn" | "session total">("latest turn");
  const [usage, setUsage] = useState<UsageStats>({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  const [liveThought, setLiveThought] = useState("");
  const [steerNote, setSteerNote] = useState("");
  const [steerEvents, setSteerEvents] = useState<{ id: string; text: string }[]>([]);
  const [showJump, setShowJump] = useState(false);
  const liveQueueRef = useRef<TurnEvent[]>([]);
  const liveRafRef = useRef(0);
  const steerSeenRef = useRef(new Set<string>());
  const activeSessionRef = useRef("");
  const liveTimelineRef = useRef(false);
  const wasLoadingRef = useRef(false);

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

  const activeSession = sessionLabel && sessionLabel !== "new" ? sessionLabel : "";
  activeSessionRef.current = activeSession;
  const titleParts = (title || instance.name).split(" · ");
  const wsId = workspace || titleParts[0]?.trim() || "default";
  const personaId = persona || titleParts[1]?.trim() || "default";

  useEffect(() => {
    setTimelineSteps([]);
    setTimelineScope("latest turn");
    setUsage({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    setLiveThought("");
    setSteerEvents([]);
    liveTimelineRef.current = false;
    steerSeenRef.current.clear();
  }, [activeSession, workspace, persona, instance.id]);

  useEffect(() => {
    if (isLoading && !wasLoadingRef.current) {
      setTimelineSteps([]);
      setTimelineScope("latest turn");
      setUsage({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
      setLiveThought("");
      liveTimelineRef.current = false;
    }
    if (!isLoading && wasLoadingRef.current) setLiveThought("");
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    const flush = () => {
      liveRafRef.current = 0;
      const batch = liveQueueRef.current.splice(0);
      for (const ev of batch) {
        const steerEv = asSteerEvent(ev);
        if (steerEv) {
          const evSession = String(steerEv.session || "");
          const currentSession = activeSessionRef.current;
          if (!evSession || !currentSession || evSession === currentSession) {
            const key = `${evSession}\n${steerEv.text.trim()}`;
            if (!steerSeenRef.current.has(key)) {
              steerSeenRef.current.add(key);
              const text = steerEv.text.trim();
              const id = `steer-${steerSeenRef.current.size}`;
              setSteerEvents((cur) => [...cur.slice(-5), { id, text }]);
            }
          }
        }
        if (["tool_start", "tool_end", "error", "usage"].includes(ev.type)) {
          liveTimelineRef.current = true;
          setTimelineScope("latest turn");
        }
        setTimelineSteps((cur) => applyLiveTurnEvent(cur, ev));
        setUsage((cur) => usageFromTurnEvent(cur, ev));
        if (ev.type === "thought" && ev.text) setLiveThought((cur) => `${cur}${ev.text}`);
      }
    };
    const listener = (event: Event) => {
      liveQueueRef.current.push((event as CustomEvent<TurnEvent>).detail);
      if (!liveRafRef.current) liveRafRef.current = requestAnimationFrame(flush);
    };
    window.addEventListener(TURN_EVENT_NAME, listener);
    return () => {
      window.removeEventListener(TURN_EVENT_NAME, listener);
      if (liveRafRef.current) cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = 0;
    };
  }, []);

  useEffect(() => {
    if (!activeSession) return;
    let dead = false;
    void api.sessionEvents(instance, wsId, personaId, activeSession).then((events) => {
      if (!dead && events && !liveTimelineRef.current) {
        setTimelineScope("session total");
        setTimelineSteps(stepsFromSessionEvents(events));
      }
    });
    return () => { dead = true; };
  }, [instance, activeSession, wsId, personaId]);

  useEffect(() => {
    if (!steerNote) return;
    const t = setTimeout(() => setSteerNote(""), 4000);
    return () => clearTimeout(t);
  }, [steerNote]);

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

  const steer = async () => {
    const text = input.trim();
    if (!text || !activeSession) return;
    try {
      await injectSteer(instance, { session: activeSession, text, workspace: wsId });
      onInput("");
      setSteerNote("steered");
    } catch (e) {
      setSteerNote(e instanceof Error ? e.message : "steer failed");
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!input.trim() && files.length === 0) || sendHold) return;
    if (isLoading) {
      if (input.trim()) void steer();
      return;
    }
    stickRef.current = true;
    scrollToBottom();
    const typed = input.trim();
    if (files.length === 0 && typed === "/fork" && sessionLabel) {
      window.dispatchEvent(new CustomEvent("klanker:fork-session", { detail: { workspace: wsId, persona: personaId, session: sessionLabel } }));
      onInput("");
      return;
    }
    if (files.length === 0 && typed === "/clear") {
      window.dispatchEvent(new CustomEvent("klanker:clear-chat", { detail: { session: sessionLabel || "" } }));
      onInput("");
      return;
    }
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
        const data = raw.includes(",") ? raw.split(",", 2)[1] : raw;
        if ((f.type || "").startsWith("image/") && f.name) imageCacheRef.current.set(f.name, raw);
        resolve({ data, mime: f.type || undefined, name: f.name });
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

  const onDrop = (e: React.DragEvent<HTMLFormElement>) => {
    const picked = Array.from(e.dataTransfer?.files || []);
    if (!picked.length) return;
    e.preventDefault();
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
  const streamingBubble = isLoading && last?.role === "klanker";
  const displaySpeaker = speakerName || instance.name;
  const timelineTargetId = streamingBubble && last ? last.id : lastAssistantIdx >= 0 ? messages[lastAssistantIdx].id : "";
  const messageOrdinals = new Map<string, number>();
  let ordinal = 0;
  for (const m of messages) {
    if (m.content && (m.role === "user" || m.role === "klanker")) messageOrdinals.set(m.id, ++ordinal);
  }
  const forkFrom = (m: ChatMessage) => {
    const messageIndex = messageOrdinals.get(m.id) || 0;
    if (!activeSession || !messageIndex) return undefined;
    return () => window.dispatchEvent(new CustomEvent("klanker:fork-session", {
      detail: { workspace: wsId, persona: personaId, session: activeSession, message_index: messageIndex },
    }));
  };
  const timelineNode = <ToolTimeline steps={timelineSteps} usage={usage} defaultOpen={isLoading} scopeLabel={timelineScope} />;

  return (
    <div className="relative flex-1 flex flex-col bg-main overflow-hidden font-mono text-xs">
      {pending && approvalQueue && approvalQueue.total > 1 && (
        <div className="border-b border-subtle bg-surface px-3 py-1 text-center text-[10px] uppercase tracking-wider text-ink-muted">
          approval {approvalQueue.index} of {approvalQueue.total}
        </div>
      )}
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
          setShowJump(!stickRef.current);
        }}
        className="flex-1 overflow-y-auto overscroll-y-contain p-4 space-y-4 select-text"
      >
        <div className="mx-auto w-full max-w-3xl space-y-4">
        {steerEvents.length ? (
          <div className="flex flex-col gap-1" data-testid="steer-events">
            {steerEvents.map((s) => (
              <div key={s.id} className="flex items-start gap-2 rounded-md border border-subtle bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary">
                <span className="shrink-0 pt-px text-[9px] uppercase tracking-wider text-ink-muted">steer</span>
                <span className="min-w-0 whitespace-pre-wrap break-words">{s.text}</span>
              </div>
            ))}
          </div>
        ) : null}
        {messages.length === 0 && emptyState ? (
          emptyState
        ) : messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-ink-dim">
            <div className="w-12 h-12 border border-subtle rounded-full flex items-center justify-center mb-3">
              <Bot className="w-6 h-6 text-ink-muted" />
            </div>
            <div className="text-ink-primary font-medium mb-1">Klanker is standby.</div>
            <p className="max-w-md text-[11px] text-ink-muted">
              Send a message. The reply streams back here.
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <React.Fragment key={m.id}>
              {m.id === timelineTargetId ? timelineNode : null}
              <MessageBubble
                instance={instance}
                message={m}
                name={displaySpeaker}
                thinking={streamingBubble && m.id === last?.id && !m.content}
                streaming={streamingBubble && m.id === last?.id}
                streamStatus={streamingBubble && m.id === last?.id ? streamStatus : undefined}
                liveThought={streamingBubble && m.id === last?.id ? liveThought : ""}
                imageFor={(name) => imageCacheRef.current.get(name) || null}
                onRegenerate={i === lastAssistantIdx && !isLoading ? regenerate : undefined}
                onFork={forkFrom(m)}
              />
            </React.Fragment>
          ))
        )}

        {!timelineTargetId && messages.length > 0 ? timelineNode : null}
        {(isLoading || (remoteActive && last?.role === "user")) && !streamingBubble && (
          <div className="flex flex-col items-start">
            <div className="flex items-center space-x-1.5 mb-1 text-[10px] text-ink-dim px-1">
              <Bot className="w-3 h-3 text-ink-primary" />
              <span className="text-ink-primary font-semibold">{displaySpeaker}</span>
              <span>•</span>
              <span className="animate-pulse text-ink-primary">thinking...</span>
            </div>
            <div className="bg-surface border border-subtle rounded-md p-3 text-ink-muted">
              <TurnStatusInline status={streamStatus} />
            </div>
          </div>
        )}

        </div>
      </div>

      {showJump ? (
        <button type="button" onClick={() => { stickRef.current = true; scrollToBottom(); setShowJump(false); }} className="absolute bottom-24 right-5 z-30 rounded-full border border-subtle bg-elevated px-3 py-1.5 text-[10px] text-ink-secondary shadow-lg hover:bg-hover hover:text-ink-primary">
          jump to latest
        </button>
      ) : null}
      <PowerComposer
        instance={instance}
        input={input}
        onInput={onInput}
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        onPickFiles={onPickFiles}
        onDrop={onDrop}
        onSteer={steer}
        steerNote={steerNote}
        files={files}
        setFiles={setFiles}
        textareaRef={textareaRef}
        fileRef={fileRef}
        isLoading={isLoading}
        sendHold={sendHold}
        displaySpeaker={displaySpeaker}
        session={activeSession}
        workspace={wsId}
        persona={personaId}
        usage={usage}
        providers={providers}
        pickProvider={pick?.provider}
        acpMode={acpMode}
      />
    </div>
  );
};

function TurnStatusInline({ status }: { status?: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[11px] text-ink-secondary" data-testid="turn-start-status">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent animate-pulse" />
      <span className="shrink-0">{status || "Connecting…"}</span>
      <span className="relative h-1 w-28 max-w-40 flex-1 overflow-hidden rounded-full bg-hover" aria-hidden="true">
        <span className="turn-status-scan absolute inset-y-0 w-1/3 rounded-full bg-accent/50" />
      </span>
    </div>
  );
}

const MessageBubble = React.memo(function MessageBubble({
  instance,
  message,
  name,
  thinking,
  streaming = false,
  streamStatus = null,
  liveThought = "",
  imageFor,
  onRegenerate,
  onFork,
}: {
  instance: KlankerInstance;
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
  liveThought?: string;
  imageFor?: (name: string) => string | null;
  /** Latest assistant answer only: hover control resends the preceding
   *  user message (klanker#163 U08). */
  onRegenerate?: () => void;
  onFork?: () => void;
}) {
  const mine = message.role === "user";
  const [speaking, setSpeaking] = useState(false);
  const { openMenu } = useContextMenu();
  // <think> extraction: reasoning sits in a collapsible accordion above
  // the answer body; while streaming an unclosed trailing tag counts too.
  const thinkSplit = !mine && message.content ? splitThinking(message.content) : null;
  const spokenText = mine ? message.content : thinkSplit ? thinkSplit.body : message.content;
  const speak = async () => {
    if (!spokenText.trim() || speaking) return;
    setSpeaking(true);
    try {
      await speakText(instance, spokenText);
    } finally {
      setSpeaking(false);
    }
  };
  const copyMarkdown = () => {
    void navigator.clipboard?.writeText(message.content || "");
  };
  const openMessageMenu = (e: React.MouseEvent) => {
    openMenu(e, [
      { id: "copy-markdown", label: "Copy Markdown", icon: <Copy className="h-3 w-3" />, disabled: !message.content, onSelect: copyMarkdown },
      { id: "fork-from-here", label: "Fork from here", icon: <GitFork className="h-3 w-3" />, disabled: !onFork, onSelect: () => onFork?.() },
      { id: "regenerate", label: "Regenerate", icon: <RotateCcw className="h-3 w-3" />, disabled: !onRegenerate, onSelect: () => onRegenerate?.() },
      { id: "read-aloud", label: "Read aloud", icon: <Volume2 className="h-3 w-3" />, disabled: !spokenText.trim(), onSelect: () => void speak() },
    ]);
  };
  return (
    <div onContextMenu={openMessageMenu} className={`group flex w-full ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`flex min-w-0 flex-col ${mine ? "max-w-[85%] items-end" : "w-full max-w-full items-start"}`}>
        <div className="mb-1 flex select-none items-center space-x-1.5 px-1 text-[10px] text-ink-dim">
          {mine ? (
            <>
              <span>USER</span>
              <User className="h-3 w-3" />
            </>
          ) : (
            <>
              <Bot className="h-3 w-3 text-ink-primary" />
              <span className="font-semibold text-ink-primary">{name}</span>
            </>
          )}
          <span>•</span>
          <span>{new Date(message.timestamp).toLocaleTimeString()}</span>
          {message.elapsed_ms ? (
            <>
              <span>•</span>
              <span className="text-ink-muted">{message.elapsed_ms}ms</span>
            </>
          ) : null}
          {!mine && message.tier ? (
            <>
              <span>•</span>
              <span data-testid="turn-tier" title={message.turn_mode ? `turn mode: ${message.turn_mode}` : "turn tier"} className="rounded-full border border-subtle px-1 py-px font-mono text-[8px] uppercase tracking-wide text-ink-dim">
                {message.tier}
              </span>
            </>
          ) : null}
          {(message.content || onRegenerate || onFork) ? (
            <div data-testid="message-actions" className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded-md border border-subtle bg-surface px-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              {message.content ? (
                <CopyButton
                  text={message.content}
                  label="Copy message"
                  borderless
                  className="!h-6 !w-6 text-ink-dim [@media(hover:none)]:!h-8 [@media(hover:none)]:!w-8"
                />
              ) : null}
              {onRegenerate ? (
                <button
                  type="button"
                  onClick={onRegenerate}
                  title="Regenerate — resend the previous user message"
                  aria-label="Regenerate response"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-dim hover:bg-hover hover:text-ink-primary [@media(hover:none)]:h-8 [@media(hover:none)]:w-8"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              ) : null}
              {onFork ? (
                <button
                  type="button"
                  onClick={onFork}
                  title="Fork from here"
                  aria-label="Fork from here"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-dim hover:bg-hover hover:text-ink-primary [@media(hover:none)]:h-8 [@media(hover:none)]:w-8"
                >
                  <GitFork className="w-3 h-3" />
                </button>
              ) : null}
              {spokenText.trim() ? (
                <button
                  type="button"
                  onClick={() => void speak()}
                  disabled={speaking}
                  title="Speak message"
                  aria-label="Speak message"
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-dim hover:bg-hover hover:text-ink-primary disabled:opacity-40 [@media(hover:none)]:h-8 [@media(hover:none)]:w-8"
                >
                  <Volume2 className={`w-3 h-3 ${speaking ? "animate-pulse" : ""}`} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          className={`min-w-0 max-w-full rounded-md border p-3 leading-relaxed select-text ${
            mine
              ? "border-subtle bg-elevated text-ink-primary"
              : `${message.error ? "border-danger/50" : "border-subtle"} bg-surface text-ink-primary`
          }`}
        >
          {message.attachments?.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {message.attachments.map((name, i) => (
                <span
                  key={`${name}-${i}`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-hover border border-subtle rounded-md text-[10px] text-ink-secondary"
                >
                  {imageFor?.(name) ? <img src={imageFor(name) || ""} alt={name} className="h-8 w-8 rounded border border-subtle object-cover" /> : <Paperclip className="w-3 h-3 shrink-0" />}
                  <span className="max-w-[180px] truncate">{name}</span>
                </span>
              ))}
            </div>
          ) : null}
          {thinkSplit?.thinking || message.thinking || liveThought ? (
            <ThinkingAccordion thinking={[thinkSplit?.thinking, message.thinking, liveThought].filter(Boolean).join(String.fromCharCode(10))} streaming={streaming && (thinkSplit?.thinkingOpen || !!liveThought)} />
          ) : null}
          {message.error ? (
            <div className="rounded-md border border-danger/50 bg-main px-2.5 py-2 text-[12px] leading-relaxed text-danger" data-testid="turn-error-message">
              {message.content}
            </div>
          ) : streaming && !message.content ? (
            <TurnStatusInline status={streamStatus} />
          ) : message.role === "klanker" && message.content ? (
            thinkSplit?.thinking && !thinkSplit.body && thinkSplit.thinkingOpen ? null : (
              <MarkdownMessage text={thinkSplit ? thinkSplit.body : message.content} />
            )
          ) : (
            <div className="whitespace-pre-wrap break-words font-sans text-[14px] leading-[1.65]">
              {message.content || (thinking ? streamStatus || "Connecting…" : "")}
            </div>
          )}
          {streaming && message.content && streamStatus ? (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-dim animate-pulse">
              <span className="w-1.5 h-1.5 bg-accent rounded-full animate-ping shrink-0" />
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
