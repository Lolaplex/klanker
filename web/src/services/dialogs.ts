// Tiny promise-based dialog queue — replaces window.prompt/confirm so the
// same UI renders on desktop webview, browser and PWA.

export interface DialogOptions {
  okLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
  value?: string;
  danger?: boolean;
}

type DialogRequest =
  | ({ kind: "confirm"; message: string } & DialogOptions)
  | ({ kind: "prompt"; message: string } & DialogOptions);

interface Pending {
  req: DialogRequest;
  resolve: (value: string | boolean | null) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function subscribeDialogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentDialog(): Pending | null {
  return pending;
}

export function resolveDialog(value: string | boolean | null): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(value);
}

export const dialogs = {
  confirm(message: string, opts: DialogOptions = {}): Promise<boolean> {
    return new Promise((resolve) => {
      pending = { req: { kind: "confirm", message, ...opts }, resolve: (v) => resolve(!!v) };
      emit();
    });
  },
  prompt(message: string, opts: DialogOptions = {}): Promise<string | null> {
    return new Promise((resolve) => {
      pending = { req: { kind: "prompt", message, ...opts }, resolve: (v) => resolve(typeof v === "string" ? v : null) };
      emit();
    });
  },
};
