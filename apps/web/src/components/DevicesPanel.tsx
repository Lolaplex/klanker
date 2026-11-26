import React, { useCallback, useEffect, useState } from "react";
import { Check, Pencil, RefreshCw, X } from "lucide-react";
import type {
  HostInfo,
  HubDevice,
  HubLease,
  HubLink,
  KlankerInstance,
  ProcessStatus,
} from "../types/klanker";
import { api, caps, localRelayBaseUrl } from "../services/api";
import { dialogs } from "../services/dialogs";
import { deviceBadge, deviceLeases, deviceWsPills, deviceRoleBadge, linkBadge } from "../wsShare";
import { friendlyHostName } from "../hostPicker";

interface DevicesPanelProps {
  instance: KlankerInstance;
  status: ProcessStatus | null;
  instances: KlankerInstance[];
  /** Open the legacy/advanced instance sheet for a row. */
  onEditInstance: (inst: KlankerInstance) => void;
  /** Open the connect sheet (NewKlankerModal — hub/ws invite + code).
   *  Required: the action bar is always visible (klanker#159 U04). */
  onConnect: () => void;
  /** Open the mint sheet (PairModal — single-use device/browser invite). */
  onPair: () => void;
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
  instances,
  onEditInstance,
  onConnect,
  onPair,
  onClose,
}) => {
  const [links, setLinks] = useState<HubLink[] | null>(null);
  const [devices, setDevices] = useState<HubDevice[] | null>(null);
  const [leases, setLeases] = useState<HubLease[] | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [labelEdit, setLabelEdit] = useState<string | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const [serveHost, setServeHost] = useState("");
  const [note, setNote] = useState<string | null>(null);
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
    void api.fetchHostInfo().then(setHostInfo).catch(() => {});
    if (caps.spawn) {
      void api.serveStatus().then((st) => setServeHost(st.host || "")).catch(() => {});
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(t);
  }, [load]);

  const disconnect = async (link: HubLink) => {
    if (!(await dialogs.confirm(`Disconnect from hub ${link.label || link.hub_id}?`, { danger: true }))) return;
    try {
      await api.disconnectHub(link.hub_id);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const saveLabel = async () => {
    const next = (labelEdit ?? "").trim();
    if (!next || labelBusy) return;
    setLabelBusy(true);
    try {
      const info = await api.setHostLabel(next);
      setHostInfo(info);
      setLabelEdit(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLabelBusy(false);
    }
  };

  const revoke = async (device: HubDevice) => {
    if (
      !(await dialogs.confirm(
        `Revoke ${device.label || device.id}? This removes its access and disconnects its channel.`,
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

  const hostId = hostInfo?.host_id || "";
  const hostLabel = hostInfo?.host_label || "";
  const opsRemotes = instances.filter((i) => i.kind === "remote" && i.via === "relay");
  const running = status?.state === "running";
  // The serve address peers actually reach: desktop = managed loopback
  // port; web = the origin this page was served from — never a hardcoded
  // 127.0.0.1:8787 on a VPS deployment (klanker#159 U04).
  const serveUrl = caps.spawn ? localRelayBaseUrl() : window.location.origin;

  return (
    <div className="fixed inset-0 z-[55] flex items-end md:items-stretch md:justify-end">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-card relative w-full md:w-[420px] md:max-h-none bg-[#0a0a0a] rounded-t-2xl md:rounded-none border-t md:border-t-0 md:border-l border-[#262626] flex flex-col font-mono text-xs shadow-2xl">
        <div className="md:hidden shrink-0 pt-2 pb-1 flex justify-center">
          <span className="w-10 h-1 rounded-full bg-[#2e2e2e]" />
        </div>
        <div className="shrink-0 px-4 py-3 border-b border-[#262626] flex items-center justify-between">
          <span className="text-white font-semibold tracking-wider truncate">Devices</span>
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

        {/* Layer-1 pairing lives here exactly once: pair a device to this
            host, or connect this host to a hub. Workspace access is never
            implied — that is layer 2 in workspace settings (klanker#159). */}
        <div className="shrink-0 px-4 py-2.5 border-b border-[#262626] flex items-center gap-2">
          <button
            type="button"
            onClick={onPair}
            className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-9 px-3 py-1.5 bg-white hover:bg-[#e5e5e5] text-black font-semibold rounded transition-colors"
          >
            + Pair device
          </button>
          <button
            type="button"
            onClick={onConnect}
            className="flex-1 inline-flex items-center justify-center gap-1.5 min-h-9 px-3 py-1.5 border border-[#262626] rounded bg-[#141414] hover:bg-[#1f1f1f] text-white transition-colors"
          >
            Connect to hub
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain p-4 pb-[max(1rem,var(--sab))] md:pb-4 space-y-4">
          {note && <div className="text-[11px] text-red-500 break-words">{note}</div>}

          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#737373]">this host</div>
            <div className="border border-[#1a1a1a] rounded p-2.5 space-y-1.5">
              {/* The friendly label is the identity peers see — prominent,
                  editable; the raw host id stays muted underneath. */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#737373]">name</span>
                {labelEdit !== null ? (
                  <span className="flex items-center gap-1 min-w-0">
                    <input
                      autoFocus
                      value={labelEdit}
                      onChange={(e) => setLabelEdit(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveLabel();
                        if (e.key === "Escape") setLabelEdit(null);
                      }}
                      className="w-36 bg-[#121212] border border-[#262626] focus:border-white rounded px-1.5 py-0.5 text-white outline-none text-right"
                    />
                    <button
                      type="button"
                      disabled={labelBusy}
                      onClick={() => void saveLabel()}
                      aria-label="Save host name"
                      className="inline-flex h-6 w-6 items-center justify-center text-[#a3a3a3] hover:text-white"
                    >
                      <Check className="w-3 h-3" />
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="text-white truncate">{hostLabel || friendlyHostName(hostId) || instance.name}</span>
                    <button
                      type="button"
                      onClick={() => setLabelEdit(hostLabel)}
                      aria-label="Rename this host"
                      title="Rename this host"
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[#525252] hover:text-white"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </span>
                )}
              </div>
              {hostId && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#737373]">id</span>
                  <span className="text-[#525252] truncate text-[10px]">{friendlyHostName(hostId)}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#737373]">serve</span>
                <span className={running ? "text-white" : "text-[#737373]"}>
                  {status?.state || "unknown"}
                  {status?.port ? ` · :${status.port}` : ""}
                  {serveHost ? ` · ${serveHost}` : ""}
                </span>
              </div>
              <div className="text-[#525252] text-[10px] truncate">{serveUrl}</div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-[#737373]">paired hub links</div>
            {links === null && <div className="text-[#525252] text-[11px]">…</div>}
            {links?.length === 0 && (
              <div className="text-[#525252] text-[11px]">
                not connected to any hub — use 'Connect to hub' above to join one.
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
                No devices paired yet — click '+ Pair device' above to link another machine.
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
                      {deviceRoleBadge(d.role)}
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
