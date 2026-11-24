import { useEffect, useRef, useState } from "react";
import type { KlankerInstance, ProcessStatus } from "../types/klanker";
import { api, caps, ensureLocalServePort, localInstance, rememberSecret, secretAccount, serveToProcess, setLocalServePort } from "../services/api";
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
  // row accurate across Tray restarts and port changes.
  useEffect(() => {
    if (!caps.spawn) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        // Runtime global only — no @tauri-apps dependency, PWA-safe.
        const listen = (window as any).__TAURI__?.event?.listen;
        if (typeof listen !== "function") return;
        unlisten = await listen(
          "klanker:serve-state",
          (ev: { payload?: { port?: number; pid?: number; state?: string } }) => {
            const p = ev.payload?.port;
            if (p) setLocalServePort(p);
            setHerd((prev) => ({
              ...prev,
              local: {
                is_running: true,
                pid: ev.payload?.pid,
                port: p || 0,
                state: (ev.payload?.state as ProcessStatus["state"]) || "running",
              },
            }));
          }
        );
      } catch {
        // No Tauri runtime (PWA) — polling below still covers state.
      }
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
      unlisten?.();
      window.clearInterval(timer);
    };
  }, []);

  // Health poll every 8s — first repoint the managed serve silently when
  // the last-known port answers with a foreign host_id or nothing at all.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const hasLocal = instancesRef.current.some((i) => i.kind === "local");
      if (hasLocal) {
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
