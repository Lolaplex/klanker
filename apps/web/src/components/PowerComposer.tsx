import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Mic, Paperclip, Volume2, X } from "lucide-react";
import type { KlankerInstance, ProviderRow } from "../types/klanker";
import { api } from "../services/api";
import { listWorkspaceFiles, speakText, transcribeVoice } from "../services/streamExtrasApi";
import type { OutAttachment } from "./ChatConsole";
import type { UsageStats } from "./ToolTimeline";

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
  pickProvider?: string;
}) {
  const {
    instance, input, onInput, onSubmit, onKeyDown, onPaste, onPickFiles, onDrop,
    files, setFiles, textareaRef, fileRef, isLoading, sendHold, displaySpeaker,
    session, workspace, usage, providers = [], pickProvider, onSteer, steerNote, acpMode = "",
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
  const modes = useMemo(() => providers.find((p) => p.name === pickProvider)?.modes || [], [providers, pickProvider]);

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

  const speakLast = async () => {
    const text = [...document.querySelectorAll(".klanker-md")].pop()?.textContent || "";
    if (!text) return;
    const ok = await speakText(instance, text);
    if (!ok) setNote("voice unavailable");
  };

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
        className={`mx-auto flex w-full max-w-3xl flex-col min-h-12 bg-elevated border focus-within:border-strong rounded-md transition-colors ${dragOver ? "border-accent" : "border-subtle"}`}
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
        <div className="relative flex items-stretch gap-0.5 pl-1 pr-[5px] min-h-[46px]">
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
          <button type="button" onClick={() => fileRef.current?.click()} title="Attach files" aria-label="Attach files" className="inline-flex w-11 min-h-0 min-w-0 shrink-0 items-center justify-center text-ink-muted hover:text-ink-primary transition-colors">
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => { onInput(e.target.value); setMenuIndex(0); }}
            onKeyDown={keyDown}
            onPaste={onPaste}
            placeholder={`Message ${displaySpeaker}...`}
            className="w-full min-w-0 flex-1 self-center bg-transparent border-0 py-2 text-ink-primary outline-none resize-none overscroll-y-contain font-mono text-base leading-snug placeholder-ink-dim md:text-sm"
          />
          <button type="submit" disabled={(!input.trim() && files.length === 0) || (!isLoading && sendHold)} title={isLoading ? "Steer turn" : "Send"} aria-label={isLoading ? "Steer turn" : "Send message"} className="self-center inline-flex h-11 w-11 md:h-9 md:w-9 shrink-0 items-center justify-center rounded-md bg-accent hover:bg-accent-hover disabled:bg-hover disabled:text-ink-dim text-accent-ink transition-colors">
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
        <div className="flex min-h-7 items-center gap-1 border-t border-subtle px-2 text-[10px] text-ink-muted">
          <button type="button" onClick={recording ? stopRecording : () => void startRecording()} className="rounded p-1 hover:bg-hover hover:text-ink-primary" aria-label="Voice input" title="Voice input">
            <Mic className={`h-3.5 w-3.5 ${recording ? "animate-pulse text-ink-primary" : ""}`} />
          </button>
          <button type="button" onClick={() => void speakLast()} className="rounded p-1 hover:bg-hover hover:text-ink-primary" aria-label="Read latest reply" title="Read latest reply">
            <Volume2 className="h-3.5 w-3.5" />
          </button>
          {usage && (usage.tokensIn || usage.tokensOut) ? <span>{usage.tokensIn + usage.tokensOut} tok{usage.costUsd ? ` · $${usage.costUsd.toFixed(6)}` : ""}</span> : null}
          {modes.length ? (
            <select aria-label="ACP mode" value={acpMode || modes[0] || ""} className="bg-transparent text-ink-secondary outline-none" onChange={(e) => window.dispatchEvent(new CustomEvent("klanker:acp-mode", { detail: { mode: e.target.value, provider: pickProvider } }))}>
              {modes.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : null}
          <span className="flex-1 min-w-0" aria-hidden="true" />
          {note || steerNote ? (
            <span className="min-w-0 max-w-56 truncate" title={note || steerNote}>{note || steerNote}</span>
          ) : null}
          <span className="hidden md:inline shrink-0 text-[10px] font-mono text-ink-dim">{isLoading ? "enter steer · shift+enter newline" : "enter send · / commands · @ mention"}</span>
        </div>
      </form>
    </div>
  );
}
