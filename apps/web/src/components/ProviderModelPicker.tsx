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
  /** Bound host unreachable — cached rows stay inspectable, but every
   *  model mutation is read-only until the host comes back (klanker#115). */
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
    if (disabled) return;
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
          disabled={disabled}
          title={disabled ? "Host offline — model switching is read-only" : undefined}
          className={`min-w-0 flex-1 flex items-center gap-2 min-h-9 px-2 py-1.5 text-left ${
            selected
              ? "bg-elevated text-ink-primary"
              : "text-ink-secondary hover:bg-hover hover:text-ink-primary"
          } ${disabled ? "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-ink-secondary" : ""}`}
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
          title={disabled ? "Host offline — starring is read-only" : starred ? "unstar" : "star"}
          disabled={disabled}
          onClick={() => onStar({ provider: row.provider, model: row.model }, !starred)}
          className={`shrink-0 inline-flex h-9 w-7 items-center justify-center ${
            starred ? "text-ink-primary" : "text-ink-dim opacity-0 group-hover:opacity-100 hover:text-ink-primary"
          } ${disabled ? "cursor-not-allowed opacity-40 hover:text-ink-dim" : ""}`}
        >
          <Star className="w-3.5 h-3.5" fill={starred ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      widthClass="w-80"
      trigger={
        <button
          type="button"
          aria-disabled={disabled || undefined}
          title={disabled ? "Host offline — inspect cached models (read-only)" : "Model for this chat"}
          className={`bg-transparent border hover:border-strong rounded-md px-2 py-1.5 text-[11px] outline-none max-w-[190px] truncate ${
            disabled
              ? "border-subtle text-ink-dim cursor-pointer"
              : active
                ? "border-subtle text-ink-primary cursor-pointer"
                : "border-subtle text-ink-secondary hover:text-ink-primary cursor-pointer"
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
              className="w-full min-w-0 bg-elevated border border-subtle hover:border-strong focus:border-strong rounded-md px-2 py-1.5 text-ink-primary outline-none"
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
              disabled={disabled}
              title={disabled ? "Host offline — model switching is read-only" : undefined}
              className={`w-full flex items-center gap-2 min-h-9 px-2 py-1.5 text-left ${
                !active ? "bg-elevated text-ink-primary" : "text-ink-secondary hover:bg-hover hover:text-ink-primary"
              } ${disabled ? "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-ink-secondary" : ""}`}
            >
              <span className="w-4 shrink-0 text-center">{!active && <Check className="w-3.5 h-3.5" />}</span>
              <span>workspace default</span>
            </button>

            {(disabled || stale) && (
              <div className="mx-2 mt-2 rounded-md border border-subtle bg-elevated px-2 py-1.5 text-[10px] text-ink-secondary" data-testid="offline-provider-banner">
                <div>Host offline — {providers.length ? "showing cached models" : "no cached models"}</div>
                {disabled ? <div className="text-ink-muted">Read-only until the host reconnects.</div> : null}
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
                {filter ? (disabled ? "no match — host offline, free ids are read-only" : "no match — enter keeps it as a free id") : disabled ? "host offline — no cached models" : "no providers"}
              </div>
            )}
          </div>
    </Popover>
  );
}
