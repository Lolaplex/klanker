import { useEffect, useRef, useState } from "react";
import { Check, Group, Star } from "lucide-react";
import type { ModelPick, ProviderRow } from "../types/klanker";
import { groupRows, isStarred, parseFreeId, pickerRows, picksEqual } from "../providerPicker";

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
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
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
              ? "bg-[#141414] text-white"
              : "text-[#a3a3a3] hover:bg-[#181818] hover:text-white"
          }`}
        >
          <span className="w-4 shrink-0 text-center">{selected && <Check className="w-3.5 h-3.5" />}</span>
          <span className="truncate">
            {showProvider ? (
              <>
                <span className="text-[#737373]">{row.provider}</span>
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
            starred ? "text-white" : "text-[#3f3f3f] opacity-0 group-hover:opacity-100 hover:text-white"
          }`}
        >
          <Star className="w-3.5 h-3.5" fill={starred ? "currentColor" : "none"} />
        </button>
      </div>
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={disabled ? "host offline — cached provider list" : "Model for this chat"}
        className={`bg-[#0a0a0a] border hover:border-[#525252] rounded-md px-2 py-1.5 text-[11px] outline-none max-w-[190px] truncate ${
          disabled
            ? "border-[#262626] text-[#525252] cursor-not-allowed"
            : active
              ? "border-[#525252] text-white cursor-pointer"
              : "border-[#262626] text-[#a3a3a3] hover:text-white cursor-pointer"
        }`}
      >
        {stale && <span className="text-[#737373]">⟳ </span>}
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 border border-[#262626] bg-[#0a0a0a] rounded-md shadow-lg font-mono text-xs">
          <div className="flex items-center gap-1 p-2 border-b border-[#1f1f1f]">
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
              className="w-full min-w-0 bg-[#121212] border border-[#262626] focus:border-white rounded px-2 py-1.5 text-white outline-none"
            />
            <button
              type="button"
              title={grouped ? "flat list" : "group by provider"}
              onClick={() => setGrouped((v) => !v)}
              className={`shrink-0 inline-flex h-8 w-8 items-center justify-center rounded border ${
                grouped
                  ? "border-white text-white"
                  : "border-[#262626] text-[#737373] hover:text-white"
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
                !active ? "bg-[#141414] text-white" : "text-[#a3a3a3] hover:bg-[#181818] hover:text-white"
              }`}
            >
              <span className="w-4 shrink-0 text-center">{!active && <Check className="w-3.5 h-3.5" />}</span>
              <span>workspace default</span>
            </button>

            {stale && (
              <div className="px-2 py-1 text-[10px] text-[#737373]">
                host offline — last known provider list
              </div>
            )}

            {favRows.length > 0 && (
              <>
                <div className="px-2 pt-2 text-[10px] uppercase tracking-wider text-[#737373]">
                  favorites
                </div>
                {favRows.map((r) => renderRow(r, true))}
              </>
            )}

            {grouped ? (
              groupRows(rows).map((g) => (
                <div key={g.provider}>
                  <div className="px-2 pt-2 text-[10px] uppercase tracking-wider text-[#737373] flex items-center gap-2">
                    <span className="truncate">{g.provider}</span>
                    {g.error && <span className="text-[#a3a3a3] normal-case truncate">⚠ {g.error}</span>}
                  </div>
                  {g.rows.map((r) => renderRow(r, false))}
                </div>
              ))
            ) : (
              <>
                {rows.length > 0 && (
                  <div className="px-2 pt-2 text-[10px] uppercase tracking-wider text-[#737373]">
                    models
                  </div>
                )}
                {rows.map((r) => renderRow(r, true))}
              </>
            )}

            {rows.length === 0 && favRows.length === 0 && (
              <div className="px-2 py-3 text-[#525252]">
                {filter ? "no match — enter keeps it as a free id" : "no providers"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
