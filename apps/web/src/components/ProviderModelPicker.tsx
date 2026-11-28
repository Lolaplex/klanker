import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Group, RefreshCw, Star } from "lucide-react";
import type { ModelPick, ProviderRow } from "../types/klanker";
import { groupRows, isStarred, parseFreeId, pickerRows, picksEqual, type PickRow } from "../providerPicker";
import { modelDisplayName, providerDisplayName } from "../providerDisplay";
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
  placement = "header",
  onPick,
  onStar,
  onRefresh,
  onOpenSettings,
}: {
  providers: ProviderRow[];
  favorites: ModelPick[];
  pick?: ModelPick;
  /** rows came from the offline cache — show the stale hint. */
  stale?: boolean;
  /** Bound host unreachable — cached rows stay inspectable, but every
   *  model mutation is read-only until the host comes back (klanker#115). */
  disabled?: boolean;
  placement?: "header" | "composer";
  onPick: (p: ModelPick) => void;
  onStar: (p: ModelPick, star: boolean) => void;
  onRefresh?: () => void;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [grouped, setGrouped] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setFilter("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const { favorites: favRows, rows } = pickerRows(providers, favorites, filter);
  const active = !!(pick?.provider || pick?.model);
  const shortLabel = pick?.model
    ? modelDisplayName(pick.model, pick.provider).primary
    : pick?.provider
      ? providerDisplayName(pick.provider)
      : "Auto";
  const fullLabel = pick?.provider
    ? `${pick.provider}${pick.model ? `:${pick.model}` : ""}`
    : pick?.model || "workspace default";

  const commit = (p: ModelPick) => {
    if (disabled) return;
    onPick(p);
    setOpen(false);
  };
  const commitFreeId = () => {
    const parsed = parseFreeId(filter, providers, pick?.provider || "");
    if (parsed) commit(parsed);
  };

  const primaryFor = (row: PickRow): string => {
    if (row.isDefault && !row.displayModel) return providerDisplayName(row.provider);
    return modelDisplayName(row.displayModel || row.model, row.provider).primary;
  };

  const renderRow = (row: PickRow, showProvider: boolean) => {
    const selected = picksEqual(pick, row);
    const starred = isStarred(row, favorites);
    const rawId = `${row.provider}:${row.displayModel || row.model}`;
    return (
      <div key={`${row.provider} ${row.model}`} className="group flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => commit({ provider: row.provider, model: row.model })}
          disabled={disabled}
          title={disabled ? "Host offline — model switching is read-only" : rawId}
          className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left ${
            selected
              ? "bg-elevated text-ink-primary"
              : "text-ink-secondary hover:bg-hover hover:text-ink-primary"
          } ${disabled ? "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-ink-secondary" : ""}`}
        >
          <span className="w-3.5 shrink-0 text-center">{selected && <Check className="h-3.5 w-3.5" />}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-primary">{primaryFor(row)}</span>
          {showProvider ? (
            <span className="shrink-0 rounded border border-subtle bg-surface px-1.5 py-0.5 text-[10px] text-ink-muted">
              {providerDisplayName(row.provider)}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          title={disabled ? "Host offline — starring is read-only" : starred ? "unstar" : "star"}
          aria-label={starred ? `Unstar ${rawId}` : `Star ${rawId}`}
          disabled={disabled}
          onClick={() => onStar({ provider: row.provider, model: row.model }, !starred)}
          className={`inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-md ${
            starred ? "text-ink-primary" : "text-ink-dim opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-ink-primary"
          } ${disabled ? "cursor-not-allowed opacity-40 hover:text-ink-dim" : ""}`}
        >
          <Star className="h-3.5 w-3.5" fill={starred ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      widthClass="w-[380px] max-w-[92vw]"
      side={placement === "composer" ? "top" : "bottom"}
      align="end"
      trigger={
        <button
          type="button"
          aria-disabled={disabled || undefined}
          aria-label="Choose provider and model"
          title={disabled ? `Host offline — ${fullLabel} (read-only)` : fullLabel}
          className={`inline-flex h-8 max-w-[200px] items-center gap-1 rounded-full border px-2.5 text-[11px] outline-none transition-colors ${
            disabled
              ? "border-subtle text-ink-dim cursor-pointer"
              : active
                ? "border-subtle text-ink-primary cursor-pointer hover:border-strong hover:bg-hover"
                : "border-subtle text-ink-secondary cursor-pointer hover:border-strong hover:bg-hover hover:text-ink-primary"
          }`}
        >
          {stale ? <RefreshCw className="h-3 w-3 shrink-0 text-ink-dim" /> : null}
          <span className="min-w-0 truncate font-mono">{shortLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-dim" />
        </button>
      }
    >
      <div className="flex items-center gap-1 border-b border-subtle p-2">
        <input
          ref={inputRef}
          value={filter}
          spellCheck={false}
          placeholder="Search models or type provider:model…"
          aria-label="Search models"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitFreeId();
            }
          }}
          className="w-full min-w-0 rounded-md border border-subtle bg-elevated px-2 py-1.5 text-ink-primary outline-none hover:border-strong focus:border-strong"
        />
        {onRefresh ? (
          <button
            type="button"
            title="Refresh providers"
            aria-label="Refresh providers"
            disabled={disabled}
            onClick={onRefresh}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-strong text-ink-muted hover:text-ink-primary disabled:opacity-40"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          title={grouped ? "flat list" : "group by provider"}
          aria-label="Group by provider"
          aria-pressed={grouped}
          onClick={() => setGrouped((v) => !v)}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${
            grouped
              ? "border-accent text-ink-primary"
              : "border-strong text-ink-muted hover:text-ink-primary"
          }`}
        >
          <Group className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        <div className="px-1">
          <button
            type="button"
            onClick={() => commit({ provider: "", model: "" })}
            disabled={disabled}
            title={disabled ? "Host offline — model switching is read-only" : "workspace default"}
            className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
              !active ? "bg-elevated text-ink-primary" : "text-ink-secondary hover:bg-hover hover:text-ink-primary"
            } ${disabled ? "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-ink-secondary" : ""}`}
          >
            <span className="w-3.5 shrink-0 text-center">{!active && <Check className="h-3.5 w-3.5" />}</span>
            <span className="font-mono text-[12px]">workspace default</span>
          </button>
        </div>

        {(disabled || stale) && (
          <div className="mx-2 mt-2 rounded-md border border-subtle bg-elevated px-2 py-1.5 text-[10px] text-ink-secondary" data-testid="offline-provider-banner">
            <div>Host offline — {providers.length ? "showing cached models" : "no cached models"}</div>
            {disabled ? <div className="text-ink-muted">Read-only until the host reconnects.</div> : null}
          </div>
        )}

        {favRows.length > 0 && (
          <>
            <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-ink-muted">
              favorites
            </div>
            {favRows.map((r) => renderRow(r, true))}
          </>
        )}

        {grouped ? (
          groupRows(rows).map((g) => (
            <div key={g.provider}>
              <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-ink-muted">
                <span className="truncate">{providerDisplayName(g.provider)}</span>
                {g.error && <span className="truncate normal-case text-ink-secondary">⚠ {g.error}</span>}
              </div>
              {g.rows.map((r) => renderRow(r, false))}
            </div>
          ))
        ) : (
          <>
            {rows.length > 0 && (
              <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-ink-muted">
                models
              </div>
            )}
            {rows.map((r) => renderRow(r, true))}
          </>
        )}

        {rows.length === 0 && favRows.length === 0 && (
          <div className="px-3 py-3 text-ink-dim">
            {filter ? (disabled ? "no match — host offline, free ids are read-only" : "no match — enter keeps it as a free id") : disabled ? "host offline — no cached models" : "no providers"}
          </div>
        )}
      </div>

      <div className="border-t border-subtle p-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onOpenSettings?.();
          }}
          className="flex min-h-8 w-full items-center rounded-md px-2 text-left text-[11px] text-ink-secondary hover:bg-hover hover:text-ink-primary"
        >
          + Manage providers
        </button>
      </div>
    </Popover>
  );
}
