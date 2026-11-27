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

// FIFO queue (klanker#169 U15): a second confirm()/prompt() used to
// overwrite `pending` outright — the first promise hung unresolved
// forever and its dialog never rendered. Now overlapping calls line up
// and each resolves in order.
const queue: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function subscribeDialogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentDialog(): Pending | null {
  return queue[0] ?? null;
}

export function resolveDialog(value: string | boolean | null): void {
  const p = queue.shift();
  emit();
  p?.resolve(value);
}

/** Test/introspection helper — queued length including the visible one. */
export function pendingDialogCount(): number {
  return queue.length;
}

const enqueue = (req: DialogRequest): Promise<string | boolean | null> =>
  new Promise((resolve) => {
    queue.push({ req, resolve });
    emit();
  });

export const dialogs = {
  confirm(message: string, opts: DialogOptions = {}): Promise<boolean> {
    return enqueue({ kind: "confirm", message, ...opts }).then((v) => !!v);
  },
  prompt(message: string, opts: DialogOptions = {}): Promise<string | null> {
    return enqueue({ kind: "prompt", message, ...opts }).then((v) => (typeof v === "string" ? v : null));
  },
};
