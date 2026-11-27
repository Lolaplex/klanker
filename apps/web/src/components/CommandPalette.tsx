import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CornerDownLeft } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { inputClass } from "./ui/inputClass";

export interface PaletteItem {
  id: string;
  label: string;
  section: string;
  hint?: string;
  shortcut?: string;
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

/** Lightweight zero-dependency command palette on the shared Dialog shell. */
export function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: PaletteItem[] }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.label} ${i.section} ${i.keywords || ""}`.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    setActive((v) => Math.min(v, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const invoke = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    onClose();
    item.run();
  };

  const grouped = useMemo(() => {
    const rows: { section: string; items: { item: PaletteItem; index: number }[] }[] = [];
    filtered.forEach((item, index) => {
      let g = rows[rows.length - 1];
      if (!g || g.section !== item.section) {
        g = { section: item.section, items: [] };
        rows.push(g);
      }
      g.items.push({ item, index });
    });
    return rows;
  }, [filtered]);

  return (
    <Dialog open={open} onClose={onClose} title="Command palette" wide>
      <div className="border-b border-subtle p-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((v) => Math.min(v + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((v) => Math.max(v - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              invoke(filtered[active]);
            }
          }}
          className={inputClass}
          placeholder="Type a command or search chats…"
          aria-label="Command search"
        />
      </div>
      <div className="max-h-[26rem] overflow-y-auto py-1 pb-2" role="listbox" aria-label="Commands">
        {filtered.length === 0 && <div className="px-4 py-8 text-center text-ink-dim">no matching command</div>}
        {grouped.map((g) => (
          <div key={g.section}>
            <div className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-wider text-ink-dim">{g.section}</div>
            {g.items.map(({ item, index }) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === active}
                disabled={item.disabled}
                onMouseEnter={() => setActive(index)}
                onClick={() => invoke(item)}
                className={`flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs disabled:opacity-45 ${
                  index === active ? "bg-hover text-ink-primary" : "text-ink-secondary"
                }`}
              >
                <ArrowRight className="h-3 w-3 shrink-0 text-ink-dim" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && <span className="max-w-44 truncate text-[10px] text-ink-dim">{item.hint}</span>}
                {item.shortcut && (
                  <kbd className="shrink-0 rounded border border-subtle bg-elevated px-1 py-0.5 text-[9px] uppercase text-ink-muted">
                    {item.shortcut}
                  </kbd>
                )}
                {index === active && <CornerDownLeft className="h-3 w-3 shrink-0 text-ink-dim" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
