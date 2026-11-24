import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type {
  DesktopSettings,
  HubDevice,
  HubLease,
  HubLink,
  KlankerInstance,
  ProcessStatus,
  ProviderRow,
} from "../types/klanker";
import { api, caps, localRelayBaseUrl, pinnedHostId } from "../services/api";
import { dialogs } from "../services/dialogs";
import { deviceBadge, deviceLeases, deviceWsPills, linkBadge } from "../wsShare";

interface DevicesPanelProps {
  instance: KlankerInstance;
  status: ProcessStatus | null;
  settings: DesktopSettings;
  instances: KlankerInstance[];
  /** Flip DesktopSettings.hub_mode + restart the managed serve. */
  onToggleHubMode: (on: boolean) => void;
  /** Open the legacy/advanced instance sheet for a row. */
  onEditInstance: (inst: KlankerInstance) => void;
  /** Open the connect sheet (NewKlankerModal — hub/ws invite + code). */
  onConnect?: () => void;
  onClose: () => void;
}

const badgeClass = (on: boolean) =>
  `shrink-0 px-1.5 py-0.5 rounded-full border text-[9px] uppercase tracking-wider ${
    on ? "border-white text-white" : "border-[#262626] text-[#737373]"
  }`;

/** Devices & presence panel (klanker#151): the operator view of THIS
 *  host's hub surface — self state, paired hub links (spoke side),
 *  paired devices (hub side), active leases. The legacy per-remote ops
 *  sheet stays reachable under "advanced / ops remotes". */
export const DevicesPanel: React.FC<DevicesPanelProps> = ({
  instance,
  status,
  settings,
  instances,
  onToggleHubMode,
  onEditInstance,
  onConnect,
  onClose,
}) => {
  const [links, setLinks] = useState<HubLink[] | null>(null);
  const [devices, setDevices] = useState<HubDevice[] | null>(null);
  const [leases, setLeases] = useState<HubLease[] | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [serveHost, setServeHost] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async () => {
    setNote(null);
    const [l, d, s] = await Promise.all([
      api.fetchHubLinks().catch((e) => {
        setNote(e instanceof Error ? e.message : String(e));
        return null;
      }),
      api.fetchHubDevices().catch(() => null),
      api.fetchHubLeases().catch(() => null),
    ]);
    setLinks(l);
    setDevices(d);
    setLeases(s);
    if (caps.spawn) {
      void api.serveStatus().then((st) => setServeHost(st.host || "")).catch(() => {});
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    void api.listProviders(instance).then((r) => setProviders(r.rows)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance.id]);

  const toggleHub = async (on: boolean) => {
    if (hubBusy) return;
    setHubBusy(true);
    try {
      await Promise.resolve(onToggleHubMode(on));
    } finally {
      setHubBusy(false);
    }
  };

  const disconnect = async (link: HubLink) => {
    if (!(await dialogs.confirm(`Disconnect from hub ${link.label || link.hub_id}?`, { danger: true }))) return;
    try {
      await api.disconnectHub(link.hub_id);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const revoke = async (device: HubDevice) => {
    if (
      !(await dialogs.confirm(
        `Revoke ${device.label || device.id}? Its live channel, leases and dev-${device.id} mount all drop.`,
        { danger: true }
      ))
    )
      return;
    try {
      await api.revokeHubDevice(device.id);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const hostId = pinnedHostId();
  const opsRemotes = instances.filter((i) => i.kind === "remote" && i.via === "relay");
  const running = status?.state === "running";

  return (
    <div className="fixed inset-0 z-[55] flex items-end md:items-stretch md:justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-card relative w-full md:w-[420px] md:max-h-none bg-[#0a0a0a] rounded-t-2xl md:rounded-none border-t md:border-t-0 md:border-l border-[#262626] flex flex-col font-mono text-xs shadow-2xl">
        <div className="md:hidden shrink-0 pt-2 pb-1 flex justify-center">
          <span className="w-10 h-1 rounded-full bg-[#2e2e2e]" />
        </div>
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider truncate">devices · {instance.name}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-11 w-11 md:h-9 md:w-9 items-center justify-center text-[#737373] hover:text-white transition-colors"
              aria-label="Refresh devices"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={onClose} className="inline-flex h-11 w-11 md:h-9 md:w-9 items-center justify-center text-[#737373] hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-4">
          {note && <div className="text-[11px] text-red-500 break-words">{note}</div>}

          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#737373]">this host</div>
            <div className="border border-[#1a1a1a] rounded p-2.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#737373]">host</span>
                <span className="text-white truncate">{hostId || instance.id}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#737373]">serve</span>
                <span className={running ? "text-white" : "text-[#737373]"}>
                  {status?.state || "unknown"}
                  {status?.port ? ` · :${status.port}` : ""}
                  {serveHost ? ` · ${serveHost}` : ""}
                </span>
              </div>
              {caps.spawn && (
                <label className="flex items-center gap-2 pt-1 cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-white"
                    checked={!!settings.hub_mode}
                    disabled={hubBusy}
                    onChange={(e) => void toggleHub(e.target.checked)}
                    aria-label="Hub LAN mode"
                  />
                  <span className="text-[#a3a3a3]">hub on LAN — bind 0.0.0.0 so peers can reach this relay</span>
                </label>
              )}
              <div className="text-[#525252] text-[10px]">{localRelayBaseUrl()}</div>
            </div>
            {providers.length > 0 && (
              <div className="border border-[#1a1a1a] rounded p-2.5 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-[#525252]">providers &amp; acp agents</div>
                {providers.map((p) => (
                  <div key={p.name} className="flex items-center justify-between gap-2">
                    <span className="text-white truncate">{p.name}</span>
                    <span className="text-[#525252] shrink-0 text-[10px]">
                      {p.name.startsWith("acp.") || p.kind === "acp-agent" ? "acp agent" : p.kind || "provider"}
                      {p.error ? " · error" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#737373]">paired hub links</div>
            {links === null && <div className="text-[#525252] text-[11px]">…</div>}
            {links?.length === 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[#525252] text-[11px]">no hub links —</span>
                {onConnect && (
                  <button
                    type="button"
                    onClick={onConnect}
                    className="px-2 py-0.5 border border-[#262626] rounded text-[10px] text-white hover:bg-[#141414]"
                  >
                    connect to a hub
                  </button>
                )}
              </div>
            )}
            {links?.map((link) => (
              <div key={link.hub_id} className="border border-[#1a1a1a] rounded p-2.5 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-white truncate">{link.label || link.hub_id}</span>
                  <span className={badgeClass(linkBadge(link) === "connected")}>{linkBadge(link)}</span>
                  <button
                    type="button"
                    onClick={() => void disconnect(link)}
                    className="ml-auto shrink-0 px-2 py-0.5 border border-[#262626] rounded text-[10px] text-[#a3a3a3] hover:text-white"
                    aria-label={`disconnect ${link.label || link.hub_id}`}
                  >
                    disconnect
                  </button>
                </div>
                <div className="text-[#525252] text-[10px] truncate">
                  {link.hub_url} · as {link.device_id || "—"}
                </div>
              </div>
            ))}
          </section>

          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#737373]">connected &amp; paired devices</div>
            {devices === null && <div className="text-[#525252] text-[11px]">…</div>}
            {devices?.length === 0 && (
              <div className="text-[#525252] text-[11px]">
                no devices paired — mint an invite from a workspace's share sheet (workspace settings → invite device).
              </div>
            )}
            {devices?.map((d) => {
              const pills = deviceWsPills(d, leases || []);
              const held = deviceLeases(d, leases || []);
              return (
                <div key={d.id} className="border border-[#1a1a1a] rounded p-2.5 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-white truncate">{d.label || d.id}</span>
                    <span className={badgeClass(deviceBadge(d) === "online")}>{deviceBadge(d)}</span>
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full border border-[#262626] text-[9px] uppercase tracking-wider text-[#737373]">
                      {d.role || "device"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void revoke(d)}
                      className="ml-auto shrink-0 px-2 py-0.5 border border-[#262626] rounded text-[10px] text-red-400 hover:text-white"
                      aria-label={`revoke ${d.label || d.id}`}
                    >
                      revoke
                    </button>
                  </div>
                  <div className="text-[#525252] text-[10px] truncate">{d.id}{d.host_id ? ` · ${d.host_id}` : ""}</div>
                  {pills.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {pills.map((ws) => (
                        <span key={ws} className="px-1.5 py-0.5 rounded-full bg-[#171717] border border-[#262626] text-[9px] text-[#a3a3a3]">
                          {ws}
                        </span>
                      ))}
                    </div>
                  )}
                  {held.map((l) => (
                    <div key={`${l.ws}:${l.session}`} className="text-[10px] text-[#737373] truncate">
                      lease {l.ws}:{l.session} · run {l.run_id || "—"} · {Math.max(0, Math.round(l.expires_in))}s
                    </div>
                  ))}
                </div>
              );
            })}
          </section>

          <section className="space-y-2 border-t border-[#1a1a1a] pt-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="text-[10px] text-[#525252] hover:text-[#a3a3a3] uppercase tracking-wider"
            >
              {advancedOpen ? "− hide advanced / ops remotes" : "+ advanced / ops remotes"}
            </button>
            {advancedOpen && (
              <div className="space-y-1">
                <p className="text-[10px] text-[#525252]">
                  legacy direct remote mounts (via relay proxy) — kept for relays without hub channel support.
                </p>
                <button
                  type="button"
                  onClick={() => onEditInstance(instance)}
                  className="w-full text-left min-h-9 px-2 py-1.5 rounded border border-[#262626] text-[#a3a3a3] hover:bg-[#141414] hover:text-white"
                >
                  {instance.name} <span className="text-[#525252]">local instance settings</span>
                </button>
                {opsRemotes.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => onEditInstance(i)}
                    className="w-full text-left min-h-9 px-2 py-1.5 rounded border border-[#262626] text-[#a3a3a3] hover:bg-[#141414] hover:text-white"
                  >
                    {i.name}
                    <span className="text-[#525252]"> {(i.endpoint?.base_url || "").replace(/^https?:\/\//, "")}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
