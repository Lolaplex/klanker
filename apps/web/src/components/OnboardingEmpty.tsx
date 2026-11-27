import { Check, FolderPlus, MessageSquarePlus, TerminalSquare } from "lucide-react";

const STARTERS = [
  "Inspect this workspace and summarize what changed recently.",
  "Find the next small bug in this repo and propose a fix.",
  "Create a focused implementation plan for the next task.",
  "Run the project checks and explain any failures.",
];

export function OnboardingEmpty({
  workspace,
  persona,
  hasWorkspace,
  hasPersona,
  onPrompt,
  onNewWorkspace,
}: {
  workspace: string;
  persona: string;
  hasWorkspace: boolean;
  hasPersona: boolean;
  onPrompt: (text: string) => void;
  onNewWorkspace: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-10 font-mono">
      <div>
        <div className="text-[10px] uppercase tracking-[0.24em] text-ink-dim">klanker workbench</div>
        <h2 className="mt-2 text-xl font-semibold text-ink-primary">Start a focused session</h2>
        <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
          {hasWorkspace
            ? `Workspace ${workspace || "default"}${persona ? ` · ${persona}` : ""}. Pick a starter prompt or write your own below.`
            : "Create or select a workspace, then start a session. Klanker keeps chats, files, approvals and traces in that workspace context."}
        </p>
      </div>

      <div className="grid gap-2 rounded-lg border border-subtle bg-surface p-3 sm:grid-cols-3">
        <SetupRow done={hasWorkspace} label="workspace" detail={hasWorkspace ? workspace || "default" : "missing"} />
        <SetupRow done={hasPersona} label="persona" detail={hasPersona ? persona || "default" : "select one"} />
        <SetupRow done label="local shell" detail="ready" />
      </div>

      {!hasWorkspace && (
        <button
          type="button"
          onClick={onNewWorkspace}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-strong bg-accent px-3 py-2 text-xs font-semibold text-accent-ink"
        >
          <FolderPlus className="h-3.5 w-3.5" /> Create workspace
        </button>
      )}

      {hasWorkspace && (
        <div className="grid gap-2">
          {STARTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPrompt(s)}
              className="inline-flex min-h-11 w-full items-center justify-start gap-2 rounded-md border border-subtle bg-surface px-3 py-2 text-left font-mono text-xs text-ink-secondary hover:border-strong hover:bg-hover hover:text-ink-primary"
            >
              <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
              <span>{s}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-ink-dim">
        <TerminalSquare className="h-3 w-3" /> ctrl/cmd+k commands · ctrl/cmd+b sidebar · ctrl/cmd+j workbench
      </div>
    </div>
  );
}

function SetupRow({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-subtle bg-main px-2 py-2">
      <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${done ? "border-strong bg-accent text-accent-ink" : "border-subtle text-transparent"}`}>
        <Check className="h-2.5 w-2.5" />
      </span>
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-wider text-ink-dim">{label}</div>
        <div className="truncate text-[10px] text-ink-primary">{detail}</div>
      </div>
    </div>
  );
}
