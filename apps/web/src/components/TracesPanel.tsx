import React, { useState, useEffect } from "react";
import { Layers, RefreshCw } from "lucide-react";
import { api } from "../services/api";
import { KlankerInstance } from "../types/klanker";

interface TracesPanelProps {
  instance: KlankerInstance | null;
  /** Active workspace id — never instance.workspace (that is a workdir). */
  workspace?: string;
}

export const TracesPanel: React.FC<TracesPanelProps> = ({ instance, workspace = "" }) => {
  const [traces, setTraces] = useState<string[]>([]);
  const [note, setNote] = useState("No instance selected.");
  const [loading, setLoading] = useState(false);

  const loadTraces = async (target: KlankerInstance) => {
    setLoading(true);
    try {
      const page = await api.readRecentTraces(target, workspace, 40);
      setTraces(page.lines);
      setNote(page.note || "traces");
    } catch (e) {
      setTraces([]);
      setNote(e instanceof Error ? e.message : "traces unavailable");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTraces([]);
    if (!instance) {
      setNote("No instance selected.");
      return;
    }
    setNote("This relay's traces");
    void loadTraces(instance);
  }, [instance?.id, instance?.updated_at, workspace]);

  return (
    <div className="h-full flex flex-col bg-[#0a0a0a] font-mono text-xs overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[#262626] flex items-center justify-between">
        <div>
          <div className="font-semibold text-white tracking-wider uppercase">Live Traces & JSONL</div>
          <div className="text-[10px] text-[#525252]">{note}</div>
        </div>
        <button
          onClick={() => instance && void loadTraces(instance)}
          disabled={loading || !instance}
          className="flex min-h-9 items-center space-x-1 px-2.5 py-1 bg-[#141414] hover:bg-[#1f1f1f] border border-[#262626] rounded text-[#a3a3a3] hover:text-white transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Traces Stream */}
      <div className="flex-1 overflow-y-auto overscroll-y-contain p-4 space-y-2">
        {traces.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[#525252] text-center">
            <Layers className="w-8 h-8 text-[#333333] mb-2" />
            <div>{note}</div>
          </div>
        ) : (
          traces.map((traceStr, idx) => {
            let parsed: Record<string, unknown> | null = null;
            try {
              const value: unknown = JSON.parse(traceStr);
              parsed = value !== null && typeof value === "object" && !Array.isArray(value)
                ? value as Record<string, unknown>
                : null;
            } catch {
              parsed = null;
            }

            return (
              <div
                key={idx}
                className="p-2.5 bg-[#121212] border border-[#262626] rounded hover:border-[#404040] transition-colors"
              >
                {parsed ? (
                  <div>
                    <div className="flex items-center justify-between text-[10px] text-[#737373] mb-1">
                      <span className="font-semibold text-white uppercase">{String(parsed.type || parsed.event || "TRACE")}</span>
                      <span>{String(parsed.timestamp || parsed.ts || "now")}</span>
                    </div>
                    <pre className="text-[11px] text-[#a3a3a3] whitespace-pre-wrap overflow-x-auto">
                      {JSON.stringify(parsed, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <pre className="text-[11px] text-[#a3a3a3] whitespace-pre-wrap">{traceStr}</pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
