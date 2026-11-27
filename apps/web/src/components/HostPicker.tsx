import { useState } from "react";
import { Check, Monitor } from "lucide-react";
import type { HostBinding, HostRow } from "../hostPicker";
import { bindingText } from "../hostPicker";
import { Popover } from "./ui/Popover";

/**
 * Per-chat execution host chip (klanker#152): bound host + live presence
 * dot, member list for switching. Read-only while a run/lease is active —
 * the relay refuses mid-run switches anyway (409 lease_held).
 * Popover shell is @base-ui/react (klanker#162 U07): Esc/outside-click
 * close, focus management and aria wiring come from the primitive.
 */
export function HostPicker({
  rows,
  binding,
  switching = false,
  note = null,
  onSwitch,
}: {
  rows: HostRow[];
  binding: HostBinding;
  /** Checkpoint → rebind in flight. */
  switching?: boolean;
  /** Last switch result line (bound: x · klanker/s-…, refusal, kept). */
  note?: string | null;
  onSwitch: (deviceId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const locked = binding.kind === "locked" || switching;
  const text = bindingText(binding);

  return (
    <div className="relative">
      <Popover
        open={open}
        onOpenChange={(v) => {
          if (locked && v) return;
          setOpen(v);
        }}
        widthClass="w-64"
        trigger={
          <button
            type="button"
            disabled={locked}
            title={locked ? `${text} — switch after the run ends` : `chat host — ${text}`}
            aria-label={`Chat host — ${text}`}
            aria-busy={switching}
            className={`bg-surface border rounded-md px-2 py-1.5 text-[11px] outline-none max-w-[170px] truncate inline-flex items-center gap-1.5 ${
              locked
                ? "border-strong text-ink-dim cursor-not-allowed"
                : binding.kind === "bound"
                  ? "border-strong text-ink-primary hover:border-accent cursor-pointer"
                  : "border-strong text-ink-secondary hover:text-ink-primary hover:border-strong cursor-pointer"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                binding.online ? "bg-accent" : "bg-hover"
              }`}
              aria-hidden="true"
            />
            <Monitor className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {switching ? "switching…" : binding.label || "host"}
            </span>
          </button>
        }
      >
        <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-ink-muted">
          chat host · {text}
        </div>
        <div className="max-h-64 overflow-y-auto pb-1">
          {rows.map((r) => {
            const selected = binding.kind !== "unbound" && r.deviceId === binding.host;
            return (
              <button
                key={r.deviceId}
                type="button"
                disabled={r.deviceId === binding.host && binding.kind !== "unbound"}
                onClick={() => {
                  setOpen(false);
                  onSwitch(r.deviceId);
                }}
                aria-label={`Switch host to ${r.label}`}
                className={`w-full flex items-center gap-2 min-h-9 px-2 py-1.5 text-left ${
                  selected
                    ? "bg-elevated text-ink-primary"
                    : "text-ink-secondary hover:bg-hover hover:text-ink-primary disabled:opacity-60"
                }`}
              >
                <span className="w-4 shrink-0 text-center">
                  {selected && <Check className="w-3.5 h-3.5" />}
                </span>
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    r.online ? "bg-accent" : "bg-hover"
                  }`}
                  aria-hidden="true"
                />
                <span className="truncate flex-1">{r.label}</span>
                <span className="shrink-0 text-[9px] uppercase tracking-wider text-ink-dim">
                  {r.self ? "self" : r.online ? r.role : "offline"}
                  {r.leased ? " · run" : ""}
                </span>
              </button>
            );
          })}
          {rows.length === 0 && (
            <div className="px-2 py-3 text-ink-dim">no member hosts</div>
          )}
        </div>
        {note && (
          <div className="px-2 py-1.5 border-t border-subtle text-[10px] text-ink-muted break-words">
            {note}
          </div>
        )}
      </Popover>
      {/* Checkpoint progress / switch result — visible with the dropdown
          closed too (dropdown shows the same line inside its footer). */}
      {!open && note && (
        <div className="absolute right-0 top-full z-40 mt-1 w-64 px-2 py-1.5 border border-strong bg-surface rounded-md shadow-lg font-mono text-[10px] text-ink-secondary break-words">
          {note}
        </div>
      )}
    </div>
  );
}
