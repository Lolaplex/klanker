import React, { useEffect, useState } from "react";
import type { KlankerInstance } from "../types/klanker";
import { api } from "../services/api";
import { inputClass, labelClass } from "./ui/inputClass";
import { Dialog } from "./ui/Dialog";
import { Switch } from "./ui/Switch";


interface Props {
  instance: KlankerInstance;
  workspace: string;
  persona: string;
  /** Saved manifest — the sidebar tree refetches so names/roles update. */
  onSaved: () => void;
  onClose: () => void;
}

/** Persona manifest editor (klanker#161 U06): name, role and the system
 *  prompt fragment, persisted through the relay workspace persona endpoint.
 *  The save verifies the read-back — a relay that cannot update manifests
 *  fails loudly instead of pretending success. */
export const PersonaEditorModal: React.FC<Props> = ({ instance, workspace, persona, onSaved, onClose }) => {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [systemAppend, setSystemAppend] = useState("");
  // Team-mesh flags (klanker#169 U15): whether peers/user can hand tasks
  // to this persona and free-text operator notes — already honored by the
  // relay manifest contract, never exposed in the UI before.
  const [notes, setNotes] = useState("");
  const [acceptsMessages, setAcceptsMessages] = useState(true);
  const [allowPeers, setAllowPeers] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listPersonas(instance, workspace)
      .then((rows) => {
        const row = rows.find((r) => r.id === persona);
        if (row) {
          setName(row.name && row.name !== row.id ? row.name : "");
          setRole(row.role || "");
          setSystemAppend(row.system_append || "");
          setNotes(row.notes || "");
          if (row.accepts_messages !== undefined) setAcceptsMessages(row.accepts_messages);
          if (row.allow_peers !== undefined) setAllowPeers(row.allow_peers);
        }
        setLoaded(true);
      })
      .catch((e) => setNote(e instanceof Error ? e.message : String(e)));
  }, [instance, workspace, persona]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await api.savePersona(instance, workspace, persona, {
        name: name.trim(),
        role: role.trim(),
        system_append: systemAppend.trim(),
        notes: notes.trim(),
        accepts_messages: acceptsMessages,
        allow_peers: allowPeers,
      });
      onSaved();
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={<>persona · {persona}</>}>
        <div className="p-4 flex flex-col gap-3 overflow-y-auto">
          {!loaded && !note && <p className="text-[10px] text-ink-dim">loading manifest…</p>}
          <label className="flex flex-col gap-1">
            <span className={labelClass}>name</span>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={persona}
              aria-label="persona name"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>role</span>
            <input
              className={inputClass}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. reviewer, researcher"
              aria-label="persona role"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>system prompt</span>
            <textarea
              className={`${inputClass} resize-y min-h-28`}
              value={systemAppend}
              onChange={(e) => setSystemAppend(e.target.value)}
              placeholder="appended to the system prompt for every turn of this persona"
              aria-label="persona system prompt"
            />
          </label>
          <div className="flex gap-4">
            <label className="inline-flex items-center gap-2 text-[11px] text-ink-secondary cursor-pointer">
              <Switch checked={acceptsMessages} onCheckedChange={setAcceptsMessages} ariaLabel="accepts messages" />
              accepts messages
            </label>
            <label className="inline-flex items-center gap-2 text-[11px] text-ink-secondary cursor-pointer">
              <Switch checked={allowPeers} onCheckedChange={setAllowPeers} ariaLabel="allow peer handoffs" />
              allow peer handoffs
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className={labelClass}>notes</span>
            <textarea
              className={`${inputClass} resize-y min-h-14`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="operator notes — not part of the prompt"
              aria-label="persona notes"
            />
          </label>
          {note && <div className="text-red-500 break-words">{note}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 border border-strong rounded-md text-ink-secondary hover:text-ink-primary hover:bg-elevated"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !loaded}
              className="px-3 py-1.5 border border-accent rounded-md bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "saving…" : "save"}
            </button>
          </div>
        </div>
    </Dialog>
  );
};
