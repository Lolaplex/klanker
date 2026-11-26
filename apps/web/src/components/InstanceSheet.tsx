import React, { useEffect, useRef, useState } from "react";
import { Trash2, FolderOpen, LogIn, LogOut, X } from "lucide-react";
import { KlankerInstance, ProcessStatus } from "../types/klanker";
import { SecretField } from "./SecretField";
import { api } from "../services/api";
import { dialogs } from "../services/dialogs";

interface InstanceSheetProps {
  instance: KlankerInstance;
  status: ProcessStatus | null;
  onSave: (updated: KlankerInstance) => void | Promise<void>;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const inputClass =
  "w-full bg-[#121212] border border-[#262626] focus:border-[#525252] rounded-xl px-3 py-3 md:py-2.5 text-white outline-none text-base md:text-sm";

export const InstanceSheet: React.FC<InstanceSheetProps> = ({
  instance,
  status,
  onSave,
  onDelete,
  onClose,
}) => {
  const [formData, setFormData] = useState<KlankerInstance>(instance);
  const draftRef = useRef(instance);
  const [loginToken, setLoginToken] = useState("");
  const [loginNote, setLoginNote] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setFormData(instance);
    draftRef.current = instance;
    setLoginNote(null);
    setAuthed(null);
    void api.authStatus(instance).then((s) => setAuthed(s.authenticated)).catch(() => setAuthed(null));
  }, [instance.id, instance.updated_at]);

  const writeForm = (next: KlankerInstance) => {
    draftRef.current = next;
    setFormData(next);
  };

  const [saveNote, setSaveNote] = useState<string | null>(null);

  const save = (next?: KlankerInstance) => {
    const inst = next ?? draftRef.current;
    void Promise.resolve(
      onSave({
        ...inst,
        name: inst.name.trim(),
        secret: inst.secret?.trim() || undefined,
        endpoint: { base_url: (inst.endpoint?.base_url || "").trim().replace(/\/+$/, "") },
        workspace: inst.workspace.trim(),
        persona: (inst.persona || "").trim() || undefined,
        kind: inst.kind || instance.kind,
      })
    )
      .then(() => setSaveNote("saved"))
      .catch((e) => setSaveNote(`save: ${e instanceof Error ? e.message : e}`));
  };

  const doLogin = async () => {
    const token = loginToken.trim();
    if (!token) return;
    setLoginBusy(true);
    setLoginNote(null);
    try {
      await api.login(instance, token);
      setAuthed(true);
      setLoginNote("logged in — cookie set for 30d");
      setLoginToken("");
    } catch (e) {
      setLoginNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
    }
  };

  const doLogout = async () => {
    setLoginBusy(true);
    try {
      await api.logout(instance);
      setAuthed(false);
      setLoginNote("logged out");
    } catch (e) {
      setLoginNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
    }
  };

  // Managed/spawned locals: endpoint is derived, bearer secret lives in the
  // keyring — the remote-only fields (URL, cookie login) stay hidden.
  const local = instance.kind === "local";
  const desktop = typeof window !== "undefined" && "__TAURI__" in window;

  const pickWorkdir = async () => {
    const dir = await (window as unknown as { __TAURI__: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<string | null> } } })
      .__TAURI__.core.invoke("plugin:dialog|open", { options: { directory: true, title: "Choose workdir" } })
      .catch(() => null);
    if (dir) {
      const next = { ...draftRef.current, workspace: dir };
      writeForm(next);
      save(next);
    }
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-end md:items-stretch md:justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-card relative w-full md:w-[420px] md:max-h-none bg-[#0a0a0a] rounded-t-2xl md:rounded-none border-t md:border-t-0 md:border-l border-[#262626] flex flex-col font-mono text-xs shadow-2xl">
        <div className="md:hidden shrink-0 pt-2 pb-1 flex justify-center">
          <span className="w-10 h-1 rounded-full bg-[#2e2e2e]" />
        </div>
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider truncate">
            {instance.name || "instance"}
          </span>
          <div className="flex items-center gap-2">
            {instance.id !== "local" && (
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    if (await dialogs.confirm(`Remove ${instance.name || instance.id}?`, { danger: true })) onDelete(instance.id);
                  })();
                }}
                className="inline-flex h-11 w-11 md:h-9 md:w-9 items-center justify-center text-[#737373] hover:text-white transition-colors"
                title="Remove this instance"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button type="button" onClick={onClose} className="inline-flex h-11 w-11 md:h-9 md:w-9 items-center justify-center text-[#737373] hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="shrink-0 px-4 py-2 border-b border-[#262626] flex items-center justify-between text-[11px]">
          <span className="text-[#737373]">
            {status?.state === "running" ? "up" : "down"}
            {!local && !desktop && authed !== null && <span className="ml-2">{authed ? "· authed" : "· not authed"}</span>}
          </span>

        </div>
        {saveNote && (
          <div className="shrink-0 px-4 py-1 border-b border-[#262626] text-[10px] text-[#737373] truncate">
            {saveNote}
          </div>
        )}

        {(
          <div className="flex-1 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => writeForm({ ...draftRef.current, name: e.target.value })}
                  onBlur={() => save()}
                  className={inputClass}
                />
              </div>
              {!local && (
                <div>
                  <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">Instance URL</label>
                  <input
                    type="text"
                    value={formData.endpoint?.base_url || ""}
                    onChange={(e) => writeForm({ ...draftRef.current, endpoint: { base_url: e.target.value } })}
                    onBlur={() => save()}
                    placeholder="https://klanker.example.com (empty = this origin)"
                    className={inputClass}
                  />
                </div>
              )}
            </div>

            <div onBlur={() => save()}>
              <SecretField
                label="Instance secret"
                stored={Boolean(instance.has_secret || instance.secret)}
                value={formData.secret || ""}
                onChange={(value) => writeForm({ ...draftRef.current, secret: value || undefined })}
                help="RELAY_SECRET — sent as Authorization: Bearer on every call. Needed unless cookie login or open relay."
              />
              {status?.detail === "unauthorized" && (
                <p className="mt-1.5 text-[10px] text-red-400">
                  relay rejected the stored secret — re-enter and it saves on blur
                </p>
              )}
            </div>

            {!local && !desktop && (
            <div>
              <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                Browser dashboard login (optional)
              </label>
              <p className="text-[10px] text-[#525252] mb-1.5">
                RELAY_WEB_TOKEN cookie — only for the web UI served by the relay itself. This app uses the instance secret above; you can skip this.
              </p>
              <div className="flex items-center gap-1">
                <input
                  type="password"
                  value={loginToken}
                  onChange={(e) => setLoginToken(e.target.value)}
                  placeholder="RELAY_WEB_TOKEN"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => void doLogin()}
                  disabled={loginBusy || !loginToken.trim()}
                  className="shrink-0 flex items-center gap-1 px-3 py-3 md:py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>login</span>
                </button>
                <button
                  type="button"
                  onClick={() => void doLogout()}
                  disabled={loginBusy || !authed}
                  className="shrink-0 flex items-center gap-1 px-3 py-3 md:py-1.5 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white disabled:opacity-40"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
              {loginNote && <p className="mt-1 text-[11px] text-[#737373]">{loginNote}</p>}
            </div>
            )}

            {local && (
              <div>
                <label className="text-[10px] text-[#737373] uppercase tracking-wider block mb-1">
                  Workdir
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={formData.workspace}
                    onChange={(e) => writeForm({ ...draftRef.current, workspace: e.target.value })}
                    onBlur={() => save()}
                    placeholder="tool confinement dir (empty = workspace work dir)"
                    className={inputClass}
                  />
                  {desktop && (
                    <button
                      type="button"
                      title="Browse…"
                      onClick={() => void pickWorkdir()}
                      className="shrink-0 p-2 bg-[#0a0a0a] hover:bg-[#141414] border border-[#262626] rounded text-[#a3a3a3] hover:text-white"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => save()}
              className="w-full px-4 py-3 md:py-2.5 bg-white hover:bg-[#e5e5e5] text-black rounded-xl text-[11px] transition-colors"
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
