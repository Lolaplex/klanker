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

/// True when `ip:port` answers `GET /health` with an HTTP 200 line.
fn probe_health(ip: &str, port: u16) -> bool {
    let Ok(mut addrs) = format!("{ip}:{port}").to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = s.set_write_timeout(Some(PROBE_TIMEOUT));
    if s
        .write_all(b"GET /health HTTP/1.1\r\nHost: klanker\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = s.read(&mut buf) else { return false };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200")
        || String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.0 200")
}

fn discover_blocking() -> Vec<DiscoveredPeer> {
    let mut handles = Vec::new();
    for (hostname, ip, fqdn) in tailscale_peers() {
        for &port in DISCOVERY_PORTS {
            let (h, i, f) = (hostname.clone(), ip.clone(), fqdn.clone());
            handles.push(std::thread::spawn(move || {
                probe_health(&i, port).then(|| DiscoveredPeer {
                    hostname: h,
                    endpoint: format!("http://{i}:{port}"),
                    ip: i,
                    fqdn: f,
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
