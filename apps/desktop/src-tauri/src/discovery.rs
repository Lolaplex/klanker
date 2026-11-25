//! Peer discovery: `tailscale status --json` is the tailnet roster; each
//! peer is probed for `klanker serve` on the well-known ports. The HTTP
//! probe decides liveness — tailscale's online flag is a last-contact guess.

use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Ports a `klanker serve` commonly binds (desktop default + suite default).
const DISCOVERY_PORTS: &[u16] = &[8787, 8000];
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPeer {
    pub hostname: String,
    pub ip: String,
    pub fqdn: Option<String>,
    pub endpoint: String,
    /// From `GET /health` — feeds a hub-connect suggestion (connectHub
    /// needs the hub URL + a ws invite code), not a raw HTTP mount.
    pub host_id: Option<String>,
    pub version: Option<String>,
}

fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// (hostname, ip, fqdn) for every tailnet peer — online or not.
fn tailscale_peers() -> Vec<(String, String, Option<String>)> {
    let Ok(out) = silent_command("tailscale")
        .args(["status", "--json"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let Ok(json) = serde_json::from_slice::<Value>(&out.stdout) else {
        return Vec::new();
    };
    let mut peers = Vec::new();
    let Some(map) = json.get("Peer").and_then(|p| p.as_object()) else {
        return peers;
    };
    for v in map.values() {
        let Some(ip) = v
            .get("TailscaleIPs")
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|i| i.as_str())
        else {
            continue;
        };
        let host = v
            .get("HostName")
            .and_then(|h| h.as_str())
            .unwrap_or(ip)
            .to_string();
        let fqdn = v
            .get("DNSName")
            .and_then(|d| d.as_str())
            .map(|s| s.trim_end_matches('.').to_string());
        peers.push((host, ip.to_string(), fqdn));
    }
    peers
}

/// `GET /health` on `ip:port` — parsed host_id/version when a klanker
/// serve answers, else None. The response body (not a bare 200) is what
/// upgrades a scan hit into a hub-connect suggestion.
fn probe_health(ip: &str, port: u16) -> Option<crate::serve::HealthProbe> {
    let Ok(mut addrs) = format!("{ip}:{port}").to_socket_addrs() else {
        return None;
    };
    let addr = addrs.next()?;
    let mut s = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    let _ = s.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = s.set_write_timeout(Some(PROBE_TIMEOUT));
    s.write_all(b"GET /health HTTP/1.1\r\nHost: klanker\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut out = Vec::with_capacity(512);
    let mut buf = [0u8; 512];
    loop {
        match s.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() >= 4096 {
                    break;
                }
            }
        }
    }
    crate::serve::parse_health_response(&String::from_utf8_lossy(&out))
}

fn discover_blocking() -> Vec<DiscoveredPeer> {
    let mut handles = Vec::new();
    for (hostname, ip, fqdn) in tailscale_peers() {
        for &port in DISCOVERY_PORTS {
            let (h, i, f) = (hostname.clone(), ip.clone(), fqdn.clone());
            handles.push(std::thread::spawn(move || {
                probe_health(&i, port).map(|health| DiscoveredPeer {
                    hostname: h,
                    endpoint: format!("http://{i}:{port}"),
                    ip: i,
                    fqdn: f,
                    host_id: health.host_id,
                    version: health.version,
                })
            }));
        }
    }
    handles
        .into_iter()
        .filter_map(|h| h.join().ok().flatten())
        .collect()
}

#[tauri::command]
pub async fn discover_peers() -> Result<Vec<DiscoveredPeer>, String> {
    tauri::async_runtime::spawn_blocking(discover_blocking)
        .await
        .map_err(|e| e.to_string())
}
