import { useState } from "react";

interface SecretFieldProps {
  label: string;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
  help?: string;
  quiet?: boolean;
}

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-white rounded px-2.5 py-1.5 text-white outline-none";

export function SecretField({ label, stored, value, onChange, help, quiet }: SecretFieldProps) {
  const [replacing, setReplacing] = useState(false);
  const labelClass = quiet
    ? "text-[10px] text-[#525252] uppercase tracking-wider"
    : "text-[10px] text-[#737373] uppercase tracking-wider";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={labelClass}>{label}</span>
        {stored && !replacing ? <span className="text-[10px] text-[#a3a3a3]">Key set</span> : null}
      </div>
      {stored && !replacing ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            setReplacing(true);
          }}
          className="px-2.5 py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white"
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
      {help ? <p className="mt-1 text-[10px] text-[#525252] leading-snug">{help}</p> : null}
    </div>
  );
}
