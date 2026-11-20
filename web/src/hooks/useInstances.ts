import { useEffect, useRef, useState } from "react";
import type { KlankerInstance, ProcessStatus } from "../types/klanker";
import { api, caps, localInstance, rememberSecret, secretAccount } from "../services/api";
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
        const remembered = api.loadActiveId();
        const initial =
          list.find((i) => i.id === remembered) ??
          list[0] ??
          null;
        if (initial) selectRef.current(initial);
      } catch (e) {
        console.error("Failed to load instances:", e);
      }
      void loadSettingsRef.current();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Health poll every 8s
  useEffect(() => {
    let stop = false;
    const tick = async () => {
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

  return {
    auth, setAuth, instances, setInstances, managedId, setManagedId,
    herd, setHerd, instancesRef, herdKey,
  };
}
