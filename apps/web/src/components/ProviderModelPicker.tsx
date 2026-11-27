import { useEffect, useRef, useState } from "react";
import { Check, Group, Star } from "lucide-react";
import type { ModelPick, ProviderRow } from "../types/klanker";
import { groupRows, isStarred, parseFreeId, pickerRows, picksEqual } from "../providerPicker";
import { Popover } from "./ui/Popover";

/**
 * The one provider/model picker — flat favorites + all host models.
 * Use-only surface: provider setup lives on the host's providers tab.
 * Free-id input accepts `provider:model` or a bare model id.
 */
export function ProviderModelPicker({
  providers,
  favorites,
  pick,
  stale = false,
  disabled = false,
  onPick,
  onStar,
}: {
  providers: ProviderRow[];
  favorites: ModelPick[];
  pick?: ModelPick;
  /** rows came from the offline cache — show the stale hint. */
  stale?: boolean;
  /** Bound host unreachable — picker stays read-only on cached rows
   *  (klanker#152: never pick a model the offline host can't serve). */
  disabled?: boolean;
  onPick: (p: ModelPick) => void;
  onStar: (p: ModelPick, star: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [grouped, setGrouped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setFilter("");
      inputRef.current?.focus();
    }
  }, [open]);

  const { favorites: favRows, rows } = pickerRows(providers, favorites, filter);
  const active = !!(pick?.provider || pick?.model);
  const label = pick?.provider
    ? `${pick.provider}${pick.model ? `:${pick.model}` : ""}`
    : pick?.model || "auto";

  const commit = (p: ModelPick) => {
    onPick(p);
    setOpen(false);
  };
  const commitFreeId = () => {
    const parsed = parseFreeId(filter, providers, pick?.provider || "");
    if (parsed) commit(parsed);
  };

  const renderRow = (row: (typeof rows)[number], showProvider: boolean) => {
    const selected = picksEqual(pick, row);
    const starred = isStarred(row, favorites);
    return (
      <div key={`${row.provider} ${row.model}`} className="group flex items-center">
        <button
          type="button"
          onClick={() => commit({ provider: row.provider, model: row.model })}
          className={`min-w-0 flex-1 flex items-center gap-2 min-h-9 px-2 py-1.5 text-left ${
            selected
              ? "bg-elevated text-ink-primary"
              : "text-ink-secondary hover:bg-hover hover:text-ink-primary"
          }`}
        >
          <span className="w-4 shrink-0 text-center">{selected && <Check className="w-3.5 h-3.5" />}</span>
          <span className="truncate">
            {showProvider ? (
              <>
                <span className="text-ink-muted">{row.provider}</span>
                {" · "}
                {row.label}
              </>
            ) : (
              row.label
            )}
          </span>
        </button>
        <button
          type="button"
          title={starred ? "unstar" : "star"}
          onClick={() => onStar({ provider: row.provider, model: row.model }, !starred)}
          className={`shrink-0 inline-flex h-9 w-7 items-center justify-center ${
            starred ? "text-ink-primary" : "text-ink-dim opacity-0 group-hover:opacity-100 hover:text-ink-primary"
          }`}
        >
          <Star className="w-3.5 h-3.5" fill={starred ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        if (disabled && v) return;
        setOpen(v);
      }}
      widthClass="w-80"
      trigger={
        <button
          type="button"
          disabled={disabled}
          title={disabled ? "host offline — cached provider list" : "Model for this chat"}
          className={`bg-surface border hover:border-strong rounded-md px-2 py-1.5 text-[11px] outline-none max-w-[190px] truncate ${
            disabled
              ? "border-strong text-ink-dim cursor-not-allowed"
              : active
                ? "border-strong text-ink-primary cursor-pointer"
                : "border-strong text-ink-secondary hover:text-ink-primary cursor-pointer"
          }`}
        >
          {stale && <span className="text-ink-muted">⟳ </span>}
          {label}
        </button>
      }
    >
          <div className="flex items-center gap-1 p-2 border-b border-subtle">
            <input
              ref={inputRef}
              value={filter}
              spellCheck={false}
              placeholder="provider:model or model id"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitFreeId();
                }
              }}
              className="w-full min-w-0 bg-elevated border border-strong focus:border-accent rounded-md px-2 py-1.5 text-ink-primary outline-none"
            />
            <button
              type="button"
              title={grouped ? "flat list" : "group by provider"}
              onClick={() => setGrouped((v) => !v)}
              className={`shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-md border ${
                grouped
                  ? "border-accent text-ink-primary"
                  : "border-strong text-ink-muted hover:text-ink-primary"
              }`}
            >
              <Group className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto">
            <button
              type="button"
              onClick={() => commit({ provider: "", model: "" })}
              className={`w-full flex items-center gap-2 min-h-9 px-2 py-1.5 text-left ${
                !active ? "bg-elevated text-ink-primary" : "text-ink-secondary hover:bg-hover hover:text-ink-primary"
              }`}
            >
              <span className="w-4 shrink-0 text-center">{!active && <Check className="w-3.5 h-3.5" />}</span>
              <span>workspace default</span>
            </button>

            {stale && (
              <div className="px-2 py-1 text-[10px] text-ink-muted">
                host offline — last known provider list
              </div>
            )}

            {favRows.length > 0 && (
              <>
                <div className="px-2 pt-2 text-[10px] uppercase tracking-wider text-ink-muted">
                  favorites
                </div>
                {favRows.map((r) => renderRow(r, true))}
              </>
            )}

            {grouped ? (
              groupRows(rows).map((g) => (
                <div key={g.provider}>
                  <div className="px-2 pt-2 text-[10px] uppercase tracking-wider text-ink-muted flex items-center gap-2">
                    <span className="truncate">{g.provider}</span>
                    {g.error && <span className="text-ink-secondary normal-case truncate">⚠ {g.error}</span>}
                  </div>
                  {g.rows.map((r) => renderRow(r, false))}
                </div>
              ))
            ) : (
              <>
                {rows.length > 0 && (
                  <div className="px-2 pt-2 text-[10px] uppercase tracking-wider text-ink-muted">
                    models
                  </div>
                )}
                {rows.map((r) => renderRow(r, true))}
              </>
            )}

            {rows.length === 0 && favRows.length === 0 && (
              <div className="px-2 py-3 text-ink-dim">
                {filter ? "no match — enter keeps it as a free id" : "no providers"}
              </div>
            )}
          </div>
    </Popover>
  );
}
