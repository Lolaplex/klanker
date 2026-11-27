import { useEffect, useRef, useState } from "react";
import type { KlankerInstance, ProcessStatus } from "../types/klanker";
import { api, caps, ensureLocalServePort, localInstance, rememberSecret, secretAccount, serveToProcess, setAuthExpiredHandler, setLocalServePort } from "../services/api";
import { DESKTOP_EVENTS } from "../services/desktopApi";
import type { AuthState } from "../components/AuthGate";

/**
 * Instance registry + auth + health. Boot: desktop spawns/attaches its
 * local relay in the background (token never asked); web does the
 * same-origin auth check, then loads instances + settings. The 8s health
 * poll rewrites the herd status map for every registered instance.
 */
export function useInstances(args: {
  onSelectInstance: (inst: KlankerInstance | null) => void;
  loadSettings: () => Promise<void>;
  setWsNote: (note: string | null) => void;
}): {
  auth: AuthState;
  setAuth: (s: AuthState) => void;
  instances: KlankerInstance[];
  setInstances: React.Dispatch<React.SetStateAction<KlankerInstance[]>>;
  managedId: string | null;
  setManagedId: (id: string | null) => void;
  herd: Record<string, ProcessStatus>;
  setHerd: React.Dispatch<React.SetStateAction<Record<string, ProcessStatus>>>;
  instancesRef: React.MutableRefObject<KlankerInstance[]>;
  herdKey: string;
  refreshInstances: () => Promise<void>;
} {
  const { onSelectInstance, loadSettings, setWsNote } = args;
  const [auth, setAuth] = useState<AuthState>("checking");
  const [instances, setInstances] = useState<KlankerInstance[]>([]);
  const [managedId, setManagedId] = useState<string | null>(null);
  const [herd, setHerd] = useState<Record<string, ProcessStatus>>({});
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  const selectRef = useRef(onSelectInstance);
  selectRef.current = onSelectInstance;
  const loadSettingsRef = useRef(loadSettings);
  loadSettingsRef.current = loadSettings;
  const wsNoteRef = useRef(setWsNote);
  wsNoteRef.current = setWsNote;

  const herdKey = instances
    .map((inst) => `${inst.id}|${inst.updated_at}|${inst.endpoint?.base_url ?? inst.base_url ?? ""}|${inst.secret ? 1 : 0}`)
    .join("\n");

  // Boot: desktop spawns/attaches its local relay (token never asked); web
  // does the same-origin auth check, then instances + settings.
  useEffect(() => {
    void (async () => {
      if (caps.spawn) {
        // Desktop: never gate the UI on the local serve. The dashboard
        // renders immediately (registry/remotes still usable); the managed
        // serve spawns in the background and the health poll picks it up.
        setAuth("ok");
        void (async () => {
          try {
            const boot = await api.desktopBootstrap();
            boot.instance.secret = boot.secret;
            rememberSecret(secretAccount(boot.instance), boot.secret);
            setManagedId(boot.instance.id);
            setHerd((prev) => ({ ...prev, [boot.instance.id]: boot.status }));
            // localRelayRemotes() could not race the serve spawn above —
            // now that bootstrap resolved, reload instances so relay
            // remotes merged in by endpoint host are accurate.
            const list = await api.listKlankers();
            setInstances(list);
          } catch (e) {
            wsNoteRef.current(
              `local relay unavailable: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        })();
      } else {
        try {
          const st = await api.authStatus(localInstance());
          if (st.enabled && !st.authenticated) {
            setAuth("needed");
            return;
          }
        } catch {
          // Relay unreachable or older relay without /v1/auth/*: proceed anyway.
        }
        setAuth("ok");
      }
      try {
        const list = await api.listKlankers();
        setInstances(list);
        // Workspace-first (klanker#150): the endpoint is always the local
        // `klanker serve` / browser origin — it fronts every local, synced
        // and shared workspace. Remotes stay manageable through the devices
        // panel; they are never a chat endpoint.
        const initial =
          list.find((i) => i.id === "local" || i.kind === "local") ??
          (caps.spawn ? null : localInstance());
        if (initial) selectRef.current(initial);
      } catch (e) {
        console.error("Failed to load instances:", e);
      }
      void loadSettingsRef.current();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Serve lifecycle sync (desktop): "klanker:serve-state" Tauri event +
  // a 10s serveStatus() poll keep localServePort and the managed health
  // row accurate across Tray restarts and port changes. Native quick-ask
  // intents are re-dispatched onto window because Tauri events never become
  // DOM events by themselves.
  useEffect(() => {
    if (!caps.spawn) return;
    const unlisteners: (() => void)[] = [];
    let cancelled = false;
    void (async () => {
      // Runtime global only — no @tauri-apps dependency, PWA-safe.
      const listen = (window as {
        __TAURI__?: {
          event?: {
            listen?: (
              name: string,
              cb: (ev: { payload?: unknown }) => void
            ) => Promise<() => void>;
          };
        };
      }).__TAURI__?.event?.listen;
      if (typeof listen !== "function") return;
      const add = async (name: string, cb: (ev: { payload?: unknown }) => void) => {
        try {
          const off = await listen(name, cb);
          if (cancelled) off();
          else unlisteners.push(off);
        } catch {
          // One missing event name must not disarm the rest of the bridge.
        }
      };
      await add("klanker:serve-state", (ev) => {
        const payload = ev.payload as { port?: number; pid?: number; state?: string } | undefined;
        const p = payload?.port;
        if (p) setLocalServePort(p);
        setHerd((prev) => ({
          ...prev,
          local: {
            is_running: true,
            pid: payload?.pid,
            port: p || 0,
            state: (payload?.state as ProcessStatus["state"]) || "running",
          },
        }));
      });
      await add(DESKTOP_EVENTS.focusComposer, () => {
        window.dispatchEvent(new Event(DESKTOP_EVENTS.focusComposer));
      });
      await add(DESKTOP_EVENTS.openSession, (ev) => {
        window.dispatchEvent(new CustomEvent(DESKTOP_EVENTS.openSession, { detail: ev.payload }));
      });
    })();
    const poll = () => {
      void api
        .serveStatus()
        .then((st) => {
          if (st.port) setLocalServePort(st.port);
          setHerd((prev) => ({ ...prev, local: serveToProcess(st) }));
        })
        .catch(() => {});
    };
    const timer = window.setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      for (const off of unlisteners.splice(0)) off();
      window.clearInterval(timer);
    };
  }, []);

  // A dead session cookie in a browser context drops the whole UI back to
  // the AuthGate — detected inside api.ts on any same-origin 401.
  useEffect(() => {
    setAuthExpiredHandler(() => setAuth("needed"));
    return () => setAuthExpiredHandler(null);
  }, []);

  // Health poll every 8s — first repoint the managed serve silently when
  // the last-known port answers with a foreign host_id or nothing at all.
  // The repoint probe is desktop-only: a browser has no managed serve —
  // its local instance is the same-origin relay, probed per-instance below.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const hasLocal = instancesRef.current.some((i) => i.kind === "local");
      if (caps.spawn && hasLocal) {
        const port = await ensureLocalServePort();
        if (stop) return;
        if (port === null) {
          setHerd((prev) => ({
            ...prev,
            local: { ...(prev.local || {}), is_running: false, state: "lost" },
          }));
        }
      }
      for (const inst of instancesRef.current) {
        const st = await api.getGatewayStatus(inst);
        if (stop) return;
        setHerd((prev) => ({ ...prev, [inst.id]: st }));
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 8_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [herdKey]);

  const refreshInstances = async () => {
    try {
      const list = await api.listKlankers();
      setInstances(list);
    } catch {}
  };

  return {
    auth, setAuth, instances, setInstances, managedId, setManagedId,
    herd, setHerd, instancesRef, herdKey, refreshInstances,
  };
}
