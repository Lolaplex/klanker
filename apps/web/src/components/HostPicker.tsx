import { useEffect, useRef, useState } from "react";
import { Check, Monitor } from "lucide-react";
import type { HostBinding, HostRow } from "../hostPicker";
import { bindingText } from "../hostPicker";

/**
 * Per-chat execution host chip (klanker#152): bound host + live presence
 * dot, member list for switching. Read-only while a run/lease is active —
 * the relay refuses mid-run switches anyway (409 lease_held).
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
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const locked = binding.kind === "locked" || switching;
  const text = bindingText(binding);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={locked}
        onClick={() => setOpen((v) => !v)}
        title={locked ? `${text} — switch after the run ends` : `chat host — ${text}`}
        aria-label={`Chat host — ${text}`}
        aria-busy={switching}
        className={`bg-[#0a0a0a] border rounded-md px-2 py-1.5 text-[11px] outline-none max-w-[170px] truncate inline-flex items-center gap-1.5 ${
          locked
            ? "border-[#262626] text-[#525252] cursor-not-allowed"
            : binding.kind === "bound"
              ? "border-[#525252] text-white hover:border-white cursor-pointer"
              : "border-[#262626] text-[#a3a3a3] hover:text-white hover:border-[#525252] cursor-pointer"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            binding.online ? "bg-white" : "bg-[#404040]"
          }`}
          aria-hidden="true"
        />
        <Monitor className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {switching ? "switching…" : binding.label || "host"}
        </span>
      </button>
      {/* Checkpoint progress / switch result — visible with the dropdown
          closed too (dropdown shows the same line inside its footer). */}
      {!open && note && (
        <div className="absolute right-0 top-full z-40 mt-1 w-64 px-2 py-1.5 border border-[#262626] bg-[#0a0a0a] rounded-md shadow-lg font-mono text-[10px] text-[#a3a3a3] break-words">
          {note}
        </div>
      )}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 border border-[#262626] bg-[#0a0a0a] rounded-md shadow-lg font-mono text-xs">
          <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[#737373]">
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
                      ? "bg-[#141414] text-white"
                      : "text-[#a3a3a3] hover:bg-[#181818] hover:text-white disabled:opacity-60"
                  }`}
                >
                  <span className="w-4 shrink-0 text-center">
                    {selected && <Check className="w-3.5 h-3.5" />}
                  </span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      r.online ? "bg-white" : "bg-[#404040]"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="truncate flex-1">{r.label}</span>
                  <span className="shrink-0 text-[9px] uppercase tracking-wider text-[#525252]">
                    {r.self ? "self" : r.online ? r.role : "offline"}
                    {r.leased ? " · run" : ""}
                  </span>
                </button>
              );
            })}
            {rows.length === 0 && (
              <div className="px-2 py-3 text-[#525252]">no member hosts</div>
            )}
          </div>
          {note && (
            <div className="px-2 py-1.5 border-t border-[#1f1f1f] text-[10px] text-[#737373] break-words">
              {note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
