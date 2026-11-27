import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, RotateCcw, X } from "lucide-react";
import { api, caps, desktopLocalInstance, localInstance } from "../services/api";
import { DESKTOP_EVENTS, hideQuickAsk, listenDesktopEvent, openMainSession } from "../services/desktopApi";
import type { KlankerInstance, WorkspaceRow } from "../types/klanker";
import { mintSessionId } from "../chatBuckets";
import { KlankerMark } from "./KlankerMark";
import { MarkdownMessage } from "./MarkdownMessage";
import { CopyButton } from "./CopyButton";
import { Select } from "./ui/Select";

const DEFAULT_WS = "default";
const DEFAULT_PERSONA = "default";
const LS_WS = "klanker.quickask.workspace";
const LS_PERSONA = "klanker.quickask.persona";

function stored(key: string): string {
  try {
    return (localStorage.getItem(key) || "").trim();
  } catch {
    return "";
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function QuickAskApp() {
  const [inst, setInst] = useState<KlankerInstance>(() => (caps.spawn ? desktopLocalInstance() : localInstance()));
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([{ id: DEFAULT_WS, label: DEFAULT_WS }]);
  const [personas, setPersonas] = useState<{ id: string; name?: string; role?: string }[]>([{ id: DEFAULT_PERSONA }]);
  const [workspace, setWorkspace] = useState(DEFAULT_WS);
  const [persona, setPersona] = useState(DEFAULT_PERSONA);
  const [session, setSession] = useState("");
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeRunRef = useRef("");

  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, []);

  useEffect(() => {
    resizeInput();
  }, [input, resizeInput]);

  useEffect(() => {
    focusInput();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenDesktopEvent(DESKTOP_EVENTS.quickAskOpen, () => {
      window.setTimeout(focusInput, 0);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [focusInput]);

  const loadPersonas = useCallback(async (active: KlankerInstance, ws: string, preferred = "") => {
    try {
      const rows = await api.listPersonas(active, ws);
      const next = rows.length ? rows : [{ id: DEFAULT_PERSONA }];
      setPersonas(next);
      const pick = next.find((p) => p.id === preferred)?.id || next.find((p) => p.id === DEFAULT_PERSONA)?.id || next[0].id;
      setPersona(pick);
    } catch {
      setPersonas([{ id: DEFAULT_PERSONA }]);
      setPersona(DEFAULT_PERSONA);
    }
  }, []);

  useEffect(() => {
    let dead = false;
    void (async () => {
      let active = inst;
      try {
        if (caps.spawn) {
          const boot = await api.desktopBootstrap();
          active = boot.instance;
          if (dead) return;
          setInst(active);
        }
        const rows = await api.listWorkspaces(active);
        if (dead) return;
        const next = rows.length ? rows : [{ id: DEFAULT_WS, label: DEFAULT_WS }];
        setWorkspaces(next);
        const preferred = stored(LS_WS);
        const ws = next.find((w) => w.id === preferred)?.id || next.find((w) => w.id === DEFAULT_WS)?.id || next[0].id;
        setWorkspace(ws);
        await loadPersonas(active, ws, stored(LS_PERSONA));
      } catch (e) {
        if (!dead) setError(errorText(e));
      }
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetConversation = useCallback(() => {
    activeRunRef.current = "";
    setSession("");
    setQuestion("");
    setAnswer("");
    setStatus(null);
    setError(null);
    setStreaming(false);
  }, []);

  const chooseWorkspace = (id: string) => {
    setWorkspace(id);
    store(LS_WS, id);
    resetConversation();
    setInput("");
    void loadPersonas(inst, id);
  };

  const choosePersona = (id: string) => {
    setPersona(id);
    store(LS_PERSONA, id);
    resetConversation();
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const targetSession = session || mintSessionId();
    const run = crypto.randomUUID().replace(/-/g, "");
    activeRunRef.current = run;
    setSession(targetSession);
    setQuestion(text);
    setInput("");
    setAnswer("");
    setStatus(null);
    setError(null);
    setStreaming(true);
    try {
      for await (const ev of api.streamChat(inst, {
        text,
        run,
        session: targetSession,
        workspace: workspace || undefined,
        persona: persona || undefined,
      })) {
        if (activeRunRef.current !== run) return;
        if (ev.type === "delta" && ev.text) {
          setAnswer((cur) => cur + ev.text);
        } else if (ev.type === "status" && ev.text) {
          setStatus(ev.text);
        } else if (ev.type === "error") {
          setError(ev.text || "turn failed");
        } else if (ev.type === "trailer") {
          if (ev.session) setSession(ev.session);
          if (ev.returncode && ev.returncode !== 0) setError(`turn exited ${ev.returncode}`);
        }
      }
    } catch (e) {
      if (activeRunRef.current === run) setError(errorText(e));
    } finally {
      if (activeRunRef.current === run) {
        activeRunRef.current = "";
        setStreaming(false);
        setStatus(null);
      }
    }
  };

  const newConversation = () => {
    resetConversation();
    setInput("");
    focusInput();
  };

  const openInMain = () => {
    if (!session) return;
    void openMainSession({ workspace, persona, session });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (input) setInput("");
      else void hideQuickAsk();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);

  const hasTranscript = !!(question || answer || error);
  const busyLabel = streaming ? status || "thinking…" : null;

  return (
    <div className="h-screen w-screen overflow-hidden bg-main text-ink-primary">
      <div className="flex h-full flex-col overflow-hidden border border-strong bg-surface shadow-2xl">
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle px-3">
          <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
            <KlankerMark size={18} />
            <span data-tauri-drag-region className="text-[10px] uppercase tracking-[0.18em] text-ink-muted">quick ask</span>
          </div>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
            <div className="w-28 max-w-32">
              <Select
                value={workspace}
                onChange={chooseWorkspace}
                options={workspaces.map((w) => ({ value: w.id, label: w.label || w.id }))}
                ariaLabel="Workspace"
                className="h-8 min-h-0 px-2 py-1 text-[11px]"
              />
            </div>
            <div className="w-28 max-w-32">
              <Select
                value={persona}
                onChange={choosePersona}
                options={personas.map((p) => ({ value: p.id, label: p.name || p.id }))}
                ariaLabel="Persona"
                className="h-8 min-h-0 px-2 py-1 text-[11px]"
              />
            </div>
            <button
              type="button"
              onClick={openInMain}
              disabled={!session}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-subtle bg-elevated px-2 text-[11px] text-ink-secondary hover:border-strong hover:text-ink-primary disabled:opacity-40"
              aria-label="Open in main"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
              Open in main
            </button>
            <button
              type="button"
              onClick={() => void hideQuickAsk()}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-subtle bg-elevated px-2 text-[11px] text-ink-muted hover:border-strong hover:text-ink-primary"
              aria-label="Close quick ask"
              title="Esc"
            >
              <X className="h-3.5 w-3.5" />
              Esc
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {hasTranscript ? (
            <div className="space-y-4">
              {question && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-dim">you</div>
                  <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-primary">{question}</div>
                </div>
              )}
              <div>
                <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-ink-dim">
                  <span>klanker</span>
                  {busyLabel && <span className="normal-case tracking-normal text-ink-muted">{busyLabel}</span>}
                </div>
                {answer ? (
                  <MarkdownMessage text={answer} />
                ) : error ? null : (
                  <div className="text-[13px] text-ink-muted">{busyLabel || "thinking…"}</div>
                )}
                {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
              </div>
              {!streaming && (answer || session) && (
                <div className="flex items-center gap-2 border-t border-subtle pt-3">
                  <CopyButton text={answer} label="Copy answer" borderless />
                  <button
                    type="button"
                    onClick={openInMain}
                    disabled={!session}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-subtle bg-elevated px-2.5 text-[11px] text-ink-secondary hover:border-strong hover:text-ink-primary disabled:opacity-40"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                    Open in full app
                  </button>
                  <button
                    type="button"
                    onClick={newConversation}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-subtle bg-elevated px-2.5 text-[11px] text-ink-secondary hover:border-strong hover:text-ink-primary"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    New
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="text-[13px] text-ink-secondary">Ask klanker anything.</div>
                <div className="mt-1 text-[11px] text-ink-dim">enter send · esc close</div>
                {error && <div className="mt-2 text-[11px] text-danger">{error}</div>}
              </div>
            </div>
          )}
        </div>

        <form
          className="shrink-0 border-t border-subtle p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={1}
            placeholder="Ask klanker…"
            aria-label="Quick ask prompt"
            className="max-h-32 w-full resize-none rounded-md border border-subtle bg-elevated px-3 py-2 text-[13px] text-ink-primary outline-none placeholder:text-ink-dim hover:border-strong focus:border-strong"
          />
        </form>
      </div>
    </div>
  );
}
