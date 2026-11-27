import React, { useEffect, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import type { KlankerInstance, StoreItem, StorePaneResult } from "../types/klanker";
import { api } from "../services/api";

type TabKind = "event" | "task" | "note" | "decision";
const TABS: readonly { id: TabKind; label: string }[] = [
  { id: "event", label: "Calendar" },
  { id: "task", label: "Tasks" },
  { id: "note", label: "Notes" },
  { id: "decision", label: "Decisions" },
];

interface WorkspacePaneProps {
  instance: KlankerInstance;
  workspaceId: string;
  revision: number;
  onUnsupported: () => void;
  onClose: () => void;
}

export const WorkspacePane: React.FC<WorkspacePaneProps> = ({
  instance,
  workspaceId,
  revision,
  onUnsupported,
  onClose,
}) => {
  const [tab, setTab] = useState<TabKind>("event");
  const [items, setItems] = useState<StoreItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<StorePaneResult | null>(null);
  const [previewTarget, setPreviewTarget] = useState<"markdown" | "ical" | "html">("markdown");

  const loadItems = async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listStoreItems(instance, workspaceId, tab);
      if (!res.supported) {
        onUnsupported();
        return;
      }
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPreview(null);
    void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id, workspaceId, tab, revision]);

  const inspectItem = async (entityId: string, target: "markdown" | "ical" | "html") => {
    setPreviewTarget(target);
    setError(null);
    try {
      const res = await api.renderStorePane(instance, workspaceId, entityId, target);
      setPreview(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const quickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !title.trim() || saving || tab === "decision") return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { kind: tab, title: title.trim() };
      if (tab === "event") payload.when = when.trim() || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      if (tab === "task") payload.status = "open";
      if (tab === "note" || bodyText.trim()) payload.body = bodyText.trim() || title.trim();
      await api.appendStoreItem(instance, workspaceId, "records", payload);
      setTitle("");
      setWhen("");
      setBodyText("");
      await loadItems();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="fixed inset-0 z-50 md:static md:z-auto w-full md:w-96 shrink-0 border-l border-[#262626] bg-[#0a0a0a] flex flex-col font-mono text-xs min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#262626]">
        <span className="text-white uppercase tracking-wider truncate">
          store · {workspaceId || "default"}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void loadItems()}
            className="p-1 text-[#737373] hover:text-white"
            aria-label="Refresh store"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[#737373] hover:text-white"
            aria-label="Close workspace pane"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 border-b border-[#262626] bg-[#000000]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`py-2 text-[11px] border-b-2 transition-colors ${
              tab === t.id ? "border-white text-white" : "border-transparent text-[#737373] hover:text-[#d4d4d4]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "decision" && (
        <form onSubmit={(e) => void quickAdd(e)} className="p-2.5 border-b border-[#262626] flex flex-col gap-1.5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`new ${tab} title…`}
            className="bg-[#121212] border border-[#262626] rounded px-2 py-1 text-white outline-none focus:border-[#525252]"
          />
          {tab === "event" && (
            <input
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              placeholder="2026-12-01T09:00:00Z (optional)"
              className="bg-[#121212] border border-[#262626] rounded px-2 py-1 text-white outline-none focus:border-[#525252]"
            />
          )}
          {tab === "note" && (
            <input
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder="note body…"
              className="bg-[#121212] border border-[#262626] rounded px-2 py-1 text-white outline-none focus:border-[#525252]"
            />
          )}
          <button
            type="submit"
            disabled={saving || !title.trim()}
            className="inline-flex items-center justify-center gap-1 py-1 bg-[#141414] hover:bg-[#1f1f1f] border border-[#262626] rounded text-white disabled:opacity-40"
          >
            <Plus className="w-3 h-3" />
            add {tab}
          </button>
        </form>
      )}

      {error && <div className="px-3 py-1.5 text-red-500 border-b border-[#262626]">{error}</div>}

      <div className="flex-1 overflow-y-auto divide-y divide-[#171717]">
        {loading && items.length === 0 ? (
          <div className="p-4 text-[#525252]">loading…</div>
        ) : items.length === 0 ? (
          <div className="p-4 text-[#525252]">no {tab} records</div>
        ) : (
          items.map((item) => {
            const label = String(item.attrs?.title || item.attrs?.name || item.attrs?.body || item.id);
            const meta = String(item.attrs?.when || item.attrs?.status || item.ts || "");
            return (
              <div key={item.id} className="p-2.5 flex flex-col gap-1 hover:bg-[#111111]">
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void inspectItem(item.id, tab === "event" || tab === "task" ? "ical" : "markdown")}
                    className="text-left text-white hover:underline truncate flex-1"
                  >
                    {label}
                  </button>
                  <div className="flex gap-1 shrink-0">
                    {(["markdown", "ical", "html"] as const).map((fmt) => (
                      <button
                        key={fmt}
                        type="button"
                        onClick={() => void inspectItem(item.id, fmt)}
                        className="px-1 py-0.5 text-[10px] border border-[#262626] rounded text-[#737373] hover:text-white"
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </div>
                {meta && <div className="text-[11px] text-[#737373] truncate">{meta}</div>}
              </div>
            );
          })
        )}
      </div>

      {preview && (
        <div className="border-t border-[#262626] bg-[#000000] p-2.5 flex flex-col gap-1.5 max-h-60">
          <div className="flex items-center justify-between text-[11px] text-[#a3a3a3]">
            <span className="truncate">
              {preview.entity} · {previewTarget}
            </span>
            <button type="button" onClick={() => setPreview(null)} className="text-[#525252] hover:text-white">
              close
            </button>
          </div>
          {previewTarget === "html" ? (
            <iframe
              sandbox=""
              srcDoc={preview.content}
              title="Store HTML projection preview"
              className="w-full h-40 bg-white border border-[#262626] rounded"
            />
          ) : (
            <pre className="text-[11px] text-[#d4d4d4] whitespace-pre-wrap overflow-y-auto max-h-40">
              {preview.content}
            </pre>
          )}
        </div>
      )}
    </aside>
  );
};
