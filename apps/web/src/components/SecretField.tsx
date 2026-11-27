import { useState } from "react";
import { inputClass } from "./ui/inputClass";

interface SecretFieldProps {
  label: string;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  quiet?: boolean;
}


export function SecretField({ label, stored, value, onChange, help, quiet }: SecretFieldProps) {
  const [replacing, setReplacing] = useState(false);
  const labelClass = quiet
    ? "text-[10px] text-ink-dim uppercase tracking-wider"
    : "text-[10px] text-ink-muted uppercase tracking-wider";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={labelClass}>{label}</span>
        {stored && !replacing ? <span className="text-[10px] text-ink-secondary">Key set</span> : null}
      </div>
      {stored && !replacing ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            setReplacing(true);
          }}
          className="px-2.5 py-1.5 bg-surface hover:bg-elevated border border-strong rounded-md text-ink-secondary hover:text-ink-primary"
        >
          Replace
        </button>
      ) : (
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
      )}
      {help ? <p className="mt-1 text-[10px] text-ink-dim leading-snug">{help}</p> : null}
    </div>
  );
}
