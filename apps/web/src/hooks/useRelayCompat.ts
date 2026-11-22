import { useEffect, useRef, useState } from "react";
import type { KlankerInstance, ProcessStatus } from "../types/klanker";
import { api, caps } from "../services/api";
import { RelayCompat, compatOf } from "../relayCompat";

/**
 * Relay version compat (klanker#106): probes each running instance's
 * /health once, then maps the reported version against the bundled
 * MIN_RELAY. Local (managed) + stale → upgrade affordance through the
 * `klanker_upgrade` invoke (caps.spawn gated). Remote + stale → warning,
 * keep working. No version reported → a single hint for the whole app
 * lifetime, never a nag.
 */
export function useRelayCompat(args: {
  activeInstance: KlankerInstance | null;
  managedId: string | null;
  herd: Record<string, ProcessStatus>;
}): {
  note: { compat: RelayCompat; instance: KlankerInstance } | null;
  upgrading: boolean;
  upgrade: () => Promise<void>;
} {
  const { activeInstance, managedId, herd } = args;
  const [probes, setProbes] = useState<Record<string, { version?: string } | null>>({});
  const probed = useRef(new Set<string>());
  const hintShown = useRef(false);
  const [upgrading, setUpgrading] = useState(false);

  const instId = activeInstance?.id;
  const running = instId ? herd[instId]?.state === "running" : false;
  useEffect(() => {
    const inst = activeInstance;
    if (!inst || !running || probed.current.has(inst.id)) return;
    probed.current.add(inst.id);
    void api.relayVersion(inst).then((info) => {
      setProbes((prev) => ({ ...prev, [inst.id]: info }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId, running]);

  let note: { compat: RelayCompat; instance: KlankerInstance } | null = null;
  if (activeInstance && running && instId && instId in probes) {
    const info = probes[instId];
    const compat = compatOf(info?.version ?? null, instId === managedId);
    if (compat && (compat.kind !== "unknown" || !hintShown.current)) {
      if (compat?.kind === "unknown") hintShown.current = true;
      note = { compat, instance: activeInstance };
    }
  }

  const upgrade = async () => {
    if (!caps.spawn || upgrading) return;
    setUpgrading(true);
    try {
      await api.klankerUpgrade();
      // The running serve still reports the old version until restarted —
      // re-probe so the banner stays truthful.
      if (activeInstance) {
        const info = await api.relayVersion(activeInstance);
        setProbes((prev) => ({ ...prev, [activeInstance.id]: info }));
      }
    } finally {
      setUpgrading(false);
    }
  };

  return { note, upgrading, upgrade };
}
