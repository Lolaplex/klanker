import { Dialog } from "./ui/Dialog";

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest("input, textarea, select")) return true;
  const editable = target.closest("[contenteditable]") as HTMLElement | null;
  if (!editable) return false;
  const value = (editable.getAttribute("contenteditable") || "").toLowerCase();
  return editable.isContentEditable || value === "" || value === "true" || value === "plaintext-only";
}

export const SHORTCUT_GROUPS: { title: string; rows: { action: string; keys: string[] }[] }[] = [
  {
    title: "Navigation",
    rows: [
      { action: "Command palette", keys: ["⌘/Ctrl", "K"] },
      { action: "Toggle sidebar", keys: ["⌘/Ctrl", "B"] },
      { action: "Toggle workbench", keys: ["⌘/Ctrl", "J"] },
      { action: "Keyboard shortcuts", keys: ["?"] },
    ],
  },
  {
    title: "Chat",
    rows: [
      { action: "New chat", keys: ["⌘/Ctrl", "N"] },
      { action: "Send / Steer live turn", keys: ["Enter"] },
      { action: "New line", keys: ["Shift", "Enter"] },
      { action: "Slash commands", keys: ["/"] },
      { action: "Workspace mentions", keys: ["@"] },
      { action: "Stop streaming turn", keys: ["⌘/Ctrl", "."] },
    ],
  },
  {
    title: "Desktop",
    rows: [
      { action: "Quick-Ask overlay (configurable in Settings)", keys: ["Alt", "Space"] },
    ],
  },
];

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" wide>
      <div className="max-h-[70vh] overflow-y-auto px-4 py-3" data-testid="shortcuts-modal">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className="border-b border-subtle py-3 first:pt-1 last:border-b-0 last:pb-1">
            <h3 className="mb-2 text-[10px] uppercase tracking-[0.2em] text-ink-dim">{group.title}</h3>
            <div className="space-y-1">
              {group.rows.map((row) => (
                <div key={row.action} className="flex min-h-8 items-center justify-between gap-4 text-[12px]">
                  <span className="min-w-0 truncate text-ink-secondary">{row.action}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.keys.map((key, i) => (
                      <span key={`${row.action}-${key}-${i}`} className="flex items-center gap-1">
                        {i > 0 && <span className="text-[10px] text-ink-dim">+</span>}
                        <kbd className="rounded border border-subtle bg-elevated px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-primary shadow-none">
                          {key}
                        </kbd>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
