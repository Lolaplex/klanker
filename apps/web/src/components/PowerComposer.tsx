import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Mic, Paperclip, Square, X } from "lucide-react";
import type { KlankerInstance, ModelPick, ProviderRow } from "../types/klanker";
import { api } from "../services/api";
import {
  readAcpPref,
  readReasoningLevel,
  readTurnMode,
  writeAcpPref,
  writeReasoningLevel,
  writeTurnMode,
  type ReasoningLevel,
  type TurnMode,
} from "../services/turnMode";
import { listWorkspaceFiles, transcribeVoice } from "../services/streamExtrasApi";
import type { OutAttachment } from "./ChatConsole";
import type { UsageStats } from "./ToolTimeline";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { Select } from "./ui/Select";

export const SLASH_COMMANDS = [
  { cmd: "/retry", help: "regenerate the last answer" },
  { cmd: "/undo", help: "cover the last turn" },
  { cmd: "/compress", help: "compact older context" },
  { cmd: "/plan", help: "ask for a stepwise plan" },
  { cmd: "/fork", help: "fork this session" },
  { cmd: "/clear", help: "start a clean chat" },
];

type Mention = { kind: "file" | "memory" | "skill"; label: string; insert: string };

export function slashMatches(input: string): typeof SLASH_COMMANDS {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const q = input.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
}

export function mentionQuery(input: string): string | null {
  const m = /(?:^|\s)@([\w./:-]*)$/.exec(input);
  return m ? m[1] : null;
}

function imageSrc(a: OutAttachment): string | null {
  return a.mime?.startsWith("image/") && a.data ? `data:${a.mime};base64,${a.data}` : null;
}

export function PowerComposer(props: {
  instance: KlankerInstance;
  input: string;
  onInput: (v: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onPickFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (e: React.DragEvent<HTMLFormElement>) => void;
  onSteer: () => Promise<void>;
  onStop?: () => void;
  steerNote?: string;
  acpMode?: string;
  files: OutAttachment[];
  setFiles: React.Dispatch<React.SetStateAction<OutAttachment[]>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileRef: React.RefObject<HTMLInputElement | null>;
  isLoading: boolean;
  sendHold: boolean;
  displaySpeaker: string;
  session: string;
  workspace: string;
  persona: string;
  usage?: UsageStats;
  providers?: ProviderRow[];
  favorites?: ModelPick[];
  pick?: ModelPick;
  providersStale?: boolean;
  providersDisabled?: boolean;
  onPick?: (p: ModelPick) => void;
  onStar?: (p: ModelPick, star: boolean) => void;
  onRefreshProviders?: () => void;
  onOpenProviderSettings?: () => void;
  pickProvider?: string;
}) {
  const {
    instance, input, onInput, onSubmit, onKeyDown, onPaste, onPickFiles, onDrop,
    files, setFiles, textareaRef, fileRef, isLoading, sendHold, displaySpeaker,
    session, workspace, usage, providers = [], pickProvider, onSteer, onStop, steerNote, acpMode = "",
    favorites = [], pick, providersStale = false, providersDisabled = false,
    onPick, onStar, onRefreshProviders, onOpenProviderSettings,
  } = props;
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const inputRef = useRef(input);
  const onInputRef = useRef(onInput);
  inputRef.current = input;
  onInputRef.current = onInput;
  const [menuIndex, setMenuIndex] = useState(0);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [note, setNote] = useState("");
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const slashes = useMemo(() => slashMatches(input), [input]);
  const mquery = useMemo(() => mentionQuery(input), [input]);
  const activeProvider = pick?.provider || pickProvider || "";
  const isAcp = activeProvider.toLowerCase().startsWith("acp.");
  const providerRow = useMemo(() => providers.find((p) => p.name === activeProvider), [providers, activeProvider]);
  const modes = useMemo(() => providerRow?.modes || [], [providerRow]);
  const thoughtLevels = useMemo(() => providerRow?.thought_levels || [], [providerRow]);
  const speeds = useMemo(() => providerRow?.speeds || [], [providerRow]);
  const [turnMode, setTurnMode] = useState<TurnMode>(() => readTurnMode());
  const [reasoning, setReasoning] = useState<ReasoningLevel>(() => readReasoningLevel());
  const [acpPrefTick, setAcpPrefTick] = useState(0);
  void acpPrefTick;
  const acpPref = isAcp ? readAcpPref(activeProvider) : {};
  const setAcpField = (field: "mode" | "thought_level" | "speed", value: string) => {
    writeAcpPref(activeProvider, { [field]: value });
    setAcpPrefTick((v) => v + 1);
    if (field === "mode") {
      window.dispatchEvent(new CustomEvent("klanker:acp-mode", { detail: { mode: value, provider: activeProvider } }));
    }
  };

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(""), 4000);
    return () => clearTimeout(t);
  }, [note]);

  useEffect(() => {
    const insertMention = (event: Event) => {
      const detail = ((event as CustomEvent<Record<string, unknown>>).detail || {}) as Record<string, unknown>;
      const raw = typeof detail.mention === "string"
        ? detail.mention
        : typeof detail.path === "string"
          ? `@${detail.path}`
          : "";
      if (!raw.trim()) return;
      const mention = raw.trim().startsWith("@") ? raw.trim() : `@${raw.trim()}`;
      const cur = inputRef.current;
      onInputRef.current(`${cur}${cur.endsWith(" ") || !cur ? "" : " "}${mention} `);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    };
    window.addEventListener("klanker:insert-mention", insertMention);
    return () => window.removeEventListener("klanker:insert-mention", insertMention);
  }, [textareaRef]);

  useEffect(() => {
    if (mquery === null) {
      setMentions([]);
      return;
    }
    let dead = false;
    const q = mquery.toLowerCase();
    void Promise.allSettled([
      listWorkspaceFiles(instance, workspace),
      api.listMemory(instance, workspace, mquery),
      api.listSkills(instance, workspace),
    ]).then(([filesR, memR, skillR]) => {
      if (dead) return;
      const out: Mention[] = [];
      if (filesR.status === "fulfilled") {
        for (const f of filesR.value) {
          if (!q || f.path.toLowerCase().includes(q)) out.push({ kind: "file", label: f.path, insert: `@${f.path}` });
        }
      }
      if (memR.status === "fulfilled") {
        for (const m of memR.value) out.push({ kind: "memory", label: m.path, insert: `@memory:${m.path}` });
      }
      if (skillR.status === "fulfilled") {
        for (const s of skillR.value) {
          if (!q || s.name.toLowerCase().includes(q)) out.push({ kind: "skill", label: s.name, insert: `@skill:${s.name}` });
        }
      }
      setMentions(out.slice(0, 8));
    });
    return () => { dead = true; };
  }, [instance, workspace, mquery]);

  const chooseSlash = (cmd: string) => {
    onInput(cmd === "/compress" ? "/compress " : cmd);
    setMenuIndex(0);
    textareaRef.current?.focus();
  };

  const chooseMention = (m: Mention) => {
    onInput(input.replace(/(?:^|\s)@([\w./:-]*)$/, (all) => `${all.startsWith(" ") ? " " : ""}${m.insert} `));
    setMentions([]);
    textareaRef.current?.focus();
  };

  const keyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const rows = slashes.length ? slashes : mentions;
    if (rows.length && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Tab" || e.key === "Escape")) {
      if (e.key === "Escape") {
        setMentions([]);
        onInput(input.startsWith("/") && !input.includes(" ") ? "" : input);
        e.preventDefault();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        setMenuIndex((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        e.preventDefault();
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && (slashes.length || mentions.length)) {
        const row = rows[Math.min(menuIndex, rows.length - 1)] as { cmd?: string } | Mention;
        if ("cmd" in row && row.cmd) chooseSlash(row.cmd);
        else chooseMention(row as Mention);
        e.preventDefault();
        return;
      }
    }
    onKeyDown(e);
  };

  const steer = async () => {
    if (!input.trim() || !session) return;
    await onSteer();
  };

  const submit = (e?: React.FormEvent) => {
    if (isLoading) {
      e?.preventDefault();
      void steer();
      return;
    }
    onSubmit(e);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        void transcribeVoice(instance, blob).then((r) => {
          if (r.ok) onInput(`${input}${input.endsWith(" ") || !input ? "" : " "}${r.text}`);
          else setNote(r.unavailable ? "voice transcription unavailable" : r.error);
        });
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setNote("recording…");
    } catch {
      setNote("microphone unavailable");
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
    setNote("");
  };

  const hasDraft = !!input.trim() || files.length > 0;
  const sendButton = isLoading && !input.trim() ? (
    <button
      type="button"
      onClick={onStop}
      disabled={!onStop}
      aria-label="Stop current turn"
      title="Stop (Ctrl/⌘ .)"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-all hover:bg-accent-hover disabled:opacity-40"
    >
      <Square className="h-3 w-3 fill-current" />
    </button>
  ) : isLoading ? (
    <button
      type="submit"
      aria-label="Steer turn"
      title="Steer turn"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-all hover:bg-accent-hover"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  ) : hasDraft ? (
    <button
      type="submit"
      disabled={sendHold}
      aria-label="Send message"
      title="Send"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-all hover:bg-accent-hover disabled:bg-hover disabled:text-ink-dim"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  ) : (
    <button
      type="button"
      disabled
      aria-label="Send message"
      title="Send"
      className="inline-flex h-8 w-8 shrink-0 cursor-default items-center justify-center rounded-full border border-subtle bg-hover/70 text-ink-dim/60"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  );

  return (
    <div className="composer touch-none px-3 pt-3 bg-main border-t border-subtle md:min-h-[73px] md:p-3 md:flex md:items-center">
      <form
        onSubmit={submit}
        onDragEnter={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            dragDepthRef.current += 1;
            setDragOver(true);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
          dragDepthRef.current = 0;
          setDragOver(false);
          onDrop(e);
        }}
        className={`mx-auto flex w-full max-w-3xl flex-col min-h-12 rounded-xl border bg-elevated transition-colors focus-within:border-strong ${dragOver ? "border-accent" : "border-subtle"}`}
      >
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
            {files.map((f, i) => {
              const img = imageSrc(f);
              return (
                <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 pl-1.5 pr-1 py-1 bg-hover border border-subtle rounded-md text-[11px] text-ink-secondary">
                  {img ? <img src={img} alt={f.name || "image attachment"} className="h-9 w-9 rounded border border-subtle object-cover" /> : <Paperclip className="w-3.5 h-3.5 shrink-0" />}
                  <span className="max-w-[160px] truncate">{f.name || "file"}</span>
                  <button type="button" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} className="inline-flex h-5 w-5 min-h-0 min-w-0 items-center justify-center rounded-md hover:bg-hover hover:text-ink-primary" aria-label={`Remove ${f.name || "attachment"}`}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="relative flex min-h-[46px] items-stretch">
          {(slashes.length > 0 || mentions.length > 0) && (
            <div className="absolute bottom-full left-2 z-20 mb-1 max-h-56 min-w-56 overflow-y-auto rounded-md border border-strong bg-elevated shadow-lg" data-testid="composer-popup">
              {slashes.map((c, i) => (
                <button key={c.cmd} type="button" onMouseDown={(e) => { e.preventDefault(); chooseSlash(c.cmd); }} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] ${i === menuIndex ? "bg-hover text-ink-primary" : "text-ink-secondary"}`}>
                  <span className="font-semibold">{c.cmd}</span><span className="text-ink-muted">{c.help}</span>
                </button>
              ))}
              {mentions.map((m, i) => (
                <button key={`${m.kind}:${m.label}`} type="button" onMouseDown={(e) => { e.preventDefault(); chooseMention(m); }} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] ${i === menuIndex ? "bg-hover text-ink-primary" : "text-ink-secondary"}`}>
                  <span className="uppercase text-[9px] text-ink-muted">{m.kind}</span><span className="truncate">{m.label}</span>
                </button>
              ))}
            </div>
          )}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={onPickFiles} />
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => { onInput(e.target.value); setMenuIndex(0); }}
            onKeyDown={keyDown}
            onPaste={onPaste}
            placeholder={`Message ${displaySpeaker}...`}
            className="w-full min-w-0 flex-1 resize-none self-center overflow-hidden border-0 bg-transparent px-3.5 py-3 font-mono text-sm leading-snug text-ink-primary outline-none placeholder-ink-dim"
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-subtle px-2.5 pb-2 pt-1 text-[10px] text-ink-muted">
          <div className="flex min-w-0 items-center gap-1.5">
            <button type="button" onClick={() => fileRef.current?.click()} title="Attach files" aria-label="Attach files" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-hover hover:text-ink-primary">
              <Paperclip className="h-3.5 w-3.5" />
            </button>
            {!isAcp ? (
              <>
              <div role="radiogroup" aria-label="Turn mode" data-testid="turn-mode-selector" className="inline-flex shrink-0 items-center rounded-full border border-subtle bg-surface p-0.5 font-mono leading-none">
                {([
                  ["auto", "Auto", "Auto — fast-path smalltalk, full tools for tasks"],
                  ["fast", "Fast", "Fast — instant conversational reply, reasoning off"],
                  ["agent", "Agent", "Agent — full workspace tool context"],
                ] as const).map(([mode, label, title]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={turnMode === mode}
                    title={title}
                    data-turn-mode={mode}
                    onClick={() => { writeTurnMode(mode); setTurnMode(mode); }}
                    className={`rounded-full px-1.5 py-1 text-[9px] uppercase tracking-wide transition-colors ${turnMode === mode ? "bg-accent text-accent-ink" : "text-ink-dim hover:bg-hover hover:text-ink-primary"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Select
                ariaLabel="Thinking effort"
                testId="reasoning-selector"
                value={reasoning}
                className="h-7 min-h-7 w-28 shrink-0 whitespace-nowrap border-subtle bg-surface px-2 py-0.5 text-[10px] text-ink-secondary"
                options={[
                  { value: "auto", label: "Think: Auto" },
                  { value: "off", label: "Think: Off" },
                  { value: "low", label: "Think: Low" },
                  { value: "medium", label: "Think: Med" },
                  { value: "high", label: "Think: High" },
                ]}
                onChange={(level) => {
                  const next = level as ReasoningLevel;
                  writeReasoningLevel(next);
                  setReasoning(next);
                }}
              />
              </>
            ) : (
              <div className="flex shrink-0 items-center gap-1" data-testid="acp-mode-controls">
                <span className="inline-flex h-7 items-center rounded-full border border-subtle bg-surface px-2 text-[9px] uppercase tracking-wide text-ink-muted">ACP</span>
                {modes.length ? (
                  <Select
                    ariaLabel="ACP mode"
                    value={acpPref.mode || acpMode || modes[0] || ""}
                    className="h-7 min-h-7 w-28 border-subtle bg-surface px-1.5 py-0.5 text-[10px] text-ink-secondary"
                    options={modes.map((m) => ({ value: m, label: m }))}
                    onChange={(mode) => setAcpField("mode", mode)}
                  />
                ) : null}
                {thoughtLevels.length ? (
                  <Select
                    ariaLabel="ACP thinking"
                    testId="acp-thought-select"
                    value={acpPref.thought_level || providerRow?.thought_level || thoughtLevels[0] || ""}
                    className="h-7 min-h-7 w-24 border-subtle bg-surface px-1.5 py-0.5 text-[10px] text-ink-secondary"
                    options={thoughtLevels.map((m) => ({ value: m, label: m }))}
                    onChange={(level) => setAcpField("thought_level", level)}
                  />
                ) : null}
                {speeds.length ? (
                  <Select
                    ariaLabel="ACP speed"
                    testId="acp-speed-select"
                    value={acpPref.speed || providerRow?.speed || speeds[0] || ""}
                    className="h-7 min-h-7 w-24 border-subtle bg-surface px-1.5 py-0.5 text-[10px] text-ink-secondary"
                    options={speeds.map((m) => ({ value: m, label: m }))}
                    onChange={(speed) => setAcpField("speed", speed)}
                  />
                ) : null}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {usage && (usage.tokensIn || usage.tokensOut) ? <span className="hidden text-[10px] text-ink-dim sm:inline">{usage.tokensIn + usage.tokensOut} tok{usage.costUsd ? ` · $${usage.costUsd.toFixed(6)}` : ""}</span> : null}
            {note || steerNote ? (
              <span className="hidden min-w-0 max-w-40 truncate text-[10px] text-ink-muted md:inline" title={note || steerNote}>{note || steerNote}</span>
            ) : null}
            <ProviderModelPicker
              placement="composer"
              providers={providers}
              favorites={favorites}
              pick={pick ?? { provider: pickProvider || "", model: "" }}
              stale={providersStale}
              disabled={providersDisabled}
              onPick={onPick ?? (() => {})}
              onStar={onStar ?? (() => {})}
              onRefresh={onRefreshProviders}
              onOpenSettings={onOpenProviderSettings}
            />
            <button type="button" onClick={recording ? stopRecording : () => void startRecording()} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-hover hover:text-ink-primary" aria-label="Voice input" title="Voice input">
              <Mic className={`h-3.5 w-3.5 ${recording ? "animate-pulse text-ink-primary" : ""}`} />
            </button>
            {sendButton}
          </div>
        </div>
      </form>
    </div>
  );
}
