//! Local `klanker serve` lifecycle — LM-Studio model.
//!
//! The app owns at most one user-visible child: `klanker serve` on
//! 127.0.0.1. An already-running serve (CLI, Docker, whatever) is
//! adopted, never killed. A serve spawned by us is PID-tracked in
//! `~/.agents/run/serve.json` and killed on tray-quit. Logs land in
//! `~/.agents/logs/serve.log`. The web side drives the lifecycle through
//! two commands: `serve_ensure_local` (spawn if dead, bounded respawn)
//! and `serve_restart` (manual retry that resets the respawn budget).
//!
//! Token bootstrap: every app-spawned serve gets `RELAY_WEB_TOKEN` via
//! env — never argv, never logged — synced between the OS keyring
//! (`relay.local`) and `~/.agents/secrets/host.json` (`RELAY_WEB_TOKEN`).

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(not(target_os = "windows"))]
use std::os::unix::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

pub const DEFAULT_PORT: u16 = 8787;
const MAX_RESPAWNS: u8 = 2;
const RESPAWN_WINDOW_SECS: u64 = 300;

#[derive(Clone, Debug, Serialize)]
pub struct ServeStatus {
    /// running | starting | stopped | lost | not_found
    pub state: String,
    pub pid: Option<u32>,
    pub owned: bool,
    pub port: u16,
    /// Bind host the app spawned (or would spawn) with: 127.0.0.1 or
    /// 0.0.0.0 in hub/LAN mode.
    pub host: String,
    pub klanker_version: Option<String>,
    pub detail: Option<String>,
}

impl ServeStatus {
    fn of(state: &Serve) -> Self {
        Self {
            state: state.state.clone(),
            pid: state.pid,
            owned: state.owned,
            port: state.port,
            host: state.host.clone(),
            klanker_version: state.klanker_version.clone(),
            detail: state.detail.clone(),
        }
    }
}

pub struct Serve {
    state: String,
    pid: Option<u32>,
    owned: bool,
    port: u16,
    host: String,
    klanker_version: Option<String>,
    detail: Option<String>,
    failed_spawns: u8,
    last_spawn: Option<Instant>,
}

impl Default for Serve {
    fn default() -> Self {
        Self {
            state: "stopped".into(),
            pid: None,
            owned: false,
            port: DEFAULT_PORT,
            host: "127.0.0.1".into(),
            klanker_version: None,
            detail: None,
            failed_spawns: 0,
            last_spawn: None,
        }
    }
}

pub struct ServeState(pub Mutex<Serve>);

// --- filesystem ---------------------------------------------------------

fn state_path() -> Result<PathBuf, String> {
    let dir = crate::desktop_host_dir()?.join("run");
    fs::create_dir_all(&dir).map_err(|e| format!("create run dir: {e}"))?;
    Ok(dir.join("serve.json"))
}

fn legacy_pid_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("serve.pid"))
}

pub fn log_path(_app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::desktop_host_dir()?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("create logs dir: {e}"))?;
    Ok(dir.join("serve.log"))
}

// --- health / process ----------------------------------------------------

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct HealthProbe {
    pub port: Option<u16>,
    pub host_id: Option<String>,
    pub version: Option<String>,
}

fn probe(port: u16, request: &str) -> Option<String> {
    let addr = format!("127.0.0.1:{port}");
    let mut s = TcpStream::connect(&addr).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(3)));
    s.write_all(request.as_bytes()).ok()?;
    let mut out = Vec::with_capacity(1024);
    let mut buf = [0u8; 512];
    loop {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() >= 4096 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    (!out.is_empty()).then(|| String::from_utf8_lossy(&out).into_owned())
}

pub(crate) fn parse_health_response(raw: &str) -> Option<HealthProbe> {
    let status_line = raw.lines().next()?;
    if !(status_line.starts_with("HTTP/") && status_line.contains(" 200")) {
        return None;
    }
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .or_else(|| raw.split_once("\n\n").map(|(_, b)| b))
        .unwrap_or("")
        .trim();
    let mut parsed = HealthProbe::default();
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(obj) = val.as_object() {
            parsed.host_id = obj
                .get("host_id")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            parsed.port = obj
                .get("port")
                .and_then(|v| v.as_u64())
                .and_then(|n| u16::try_from(n).ok());
            parsed.version = obj
                .get("version")
                .or_else(|| obj.get("klanker_version"))
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
        }
    }
    Some(parsed)
}

pub(crate) fn probe_health(port: u16) -> Option<HealthProbe> {
    let raw = probe(port, "GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
    parse_health_response(&raw)
}

pub fn health_ok(port: u16) -> bool {
    probe_health(port).is_some()
}

pub(crate) fn host_id_matches(health: &HealthProbe, expected_host_id: &str) -> bool {
    match health.host_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(actual) => actual == expected_host_id,
        None => true,
    }
}

/// Port-scan fallback reclaim is destructive (`kill_tree`), so unlike passive
/// health matching it requires an explicit non-empty matching `host_id`.
pub(crate) fn can_reclaim_by_port(health: &HealthProbe, expected_host_id: Option<&str>) -> bool {
    let Some(expected) = expected_host_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    health
        .host_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some_and(|actual| actual == expected)
}

fn auth_ok(port: u16, token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    // Probe `/v1/workspaces` (bearer-protected) rather than `/v1/auth/status`,
    // which returns 200 even without a valid bearer token.
    let req = format!(
        "GET /v1/workspaces HTTP/1.0\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n"
    );
    probe(port, &req)
        .and_then(|raw| raw.lines().next().map(|l| l.starts_with("HTTP/") && l.contains(" 200")))
        .unwrap_or(false)
}

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub(crate) fn parse_netstat_listen_pid(text: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 5
            && cols[0].eq_ignore_ascii_case("TCP")
            && cols[1].ends_with(&suffix)
            && (cols[2] == "0.0.0.0:0" || cols[2] == "[::]:0")
        {
            if let Ok(pid) = cols[4].parse::<u32>() {
                if pid > 0 {
                    return Some(pid);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn netstat_listen() -> Option<String> {
    let out = Command::new("netstat")
        .args(["-ano", "-p", "tcp"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn pid_on_port(port: u16) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        netstat_listen().and_then(|text| parse_netstat_listen_pid(&text, port))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("lsof")
            .args(["-nP", "-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
            .next()
    }
}

/// Exact-match PID column in `tasklist /FO CSV` output. Every field is
/// `"..."`-quoted; image names can never contain `"` on Windows, so
/// splitting on `","` is safe — column 2 is the bare PID. A substring
/// match would alias 123 onto 1234/9123.
pub(crate) fn tasklist_csv_has_pid(text: &str, pid: u32) -> bool {
    let quoted = format!("\"{pid}\"");
    text.lines().any(|line| {
        let mut fields = line.split("\",\"");
        fields.next(); // image name
        fields
            .next()
            .map(|pid_field| format!("\"{pid_field}\"") == quoted)
            .unwrap_or(false)
    })
}

/// Local-address column of the netstat LISTENING row for `port` — the
/// bind host of an already-running (adopted) serve: "127.0.0.1",
/// "0.0.0.0", "::", or a specific LAN IP. Same locale-independent
/// LISTENING detection as `parse_netstat_listen_pid` (foreign 0.0.0.0:0).
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
pub(crate) fn parse_netstat_listen_addr(text: &str, port: u16) -> Option<String> {
    let suffix = format!(":{port}");
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 5
            && cols[0].eq_ignore_ascii_case("TCP")
            && cols[1].ends_with(&suffix)
            && (cols[2] == "0.0.0.0:0" || cols[2] == "[::]:0")
        {
            let host = cols[1][..cols[1].len() - suffix.len()]
                .trim_matches(|c| c == '[' || c == ']');
            if !host.is_empty() {
                return Some(host.to_string());
            }
        }
    }
    None
}

/// `lsof -Fn` name-field parse for the LISTEN row of `port` — the
/// non-Windows `port_bind_addr` leg: `n127.0.0.1:8787`, `n*:8787`
/// (wildcard → "0.0.0.0"), `n[::1]:8787`. Same answer shape as
/// `parse_netstat_listen_addr` so `ServeStatus.host` is real on every OS.
#[cfg_attr(not(any(unix, test)), allow(dead_code))]
pub(crate) fn parse_lsof_listen_addr(text: &str, port: u16) -> Option<String> {
    let want = port.to_string();
    for line in text.lines() {
        let Some(name) = line.strip_prefix('n') else {
            continue;
        };
        let Some((host, p)) = name.rsplit_once(':') else {
            continue;
        };
        if p != want {
            continue;
        }
        let host = host.trim_matches(|c| c == '[' || c == ']');
        let host = if host == "*" { "0.0.0.0" } else { host };
        if !host.is_empty() {
            return Some(host.to_string());
        }
    }
    None
}

fn port_bind_addr(port: u16) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        netstat_listen().and_then(|text| parse_netstat_listen_addr(&text, port))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("lsof")
            .args(["-nP", "-sTCP:LISTEN", "-Fn"])
            .arg(format!("-iTCP:{port}"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|out| parse_lsof_listen_addr(&String::from_utf8_lossy(&out.stdout), port))
    }
}

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| tasklist_csv_has_pid(&String::from_utf8_lossy(&o.stdout), pid))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// PID reuse is real — a live PID from our pid file is only "ours" when
/// the process image looks like a klanker/python interpreter.
fn pid_is_ours(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| {
                let out = String::from_utf8_lossy(&o.stdout).to_lowercase();
                out.contains("python") || out.contains("klanker") || out.contains("uv")
            })
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::read_to_string(format!("/proc/{pid}/cmdline"))
            .map(|c| c.contains("klanker") || c.contains("python") || c.contains("uv"))
            .unwrap_or_else(|_| pid_alive(pid))
    }
}

fn parse_serve_json(raw: &str) -> Option<(u32, u16)> {
    let val: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let obj = val.as_object()?;
    let pid = obj
        .get("pid")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())?;
    if pid == 0 {
        return None;
    }
    let port = obj
        .get("port")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .unwrap_or(DEFAULT_PORT);
    Some((pid, port))
}

fn parse_legacy_pid(raw: &str) -> Option<(u32, u16)> {
    let trimmed = raw.trim();
    if let Ok(pid) = trimmed.parse::<u32>() {
        return (pid > 0).then_some((pid, DEFAULT_PORT));
    }
    let mut pid = None;
    let mut port = None;
    for line in raw.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k.trim() {
            "pid" => pid = v.trim().parse::<u32>().ok(),
            "port" => port = v.trim().parse::<u16>().ok(),
            _ => {}
        }
    }
    pid.filter(|&p| p > 0)
        .map(|p| (p, port.unwrap_or(DEFAULT_PORT)))
}

pub(crate) fn read_serve_state_at(
    state_file: &Path,
    legacy_pid: Option<&Path>,
) -> Option<(u32, u16)> {
    if state_file.exists() {
        return fs::read_to_string(state_file)
            .ok()
            .and_then(|raw| parse_serve_json(&raw));
    }
    legacy_pid
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| parse_legacy_pid(&raw))
}

pub(crate) fn write_serve_state_with_host_at(
    state_file: &Path,
    pid: u32,
    port: u16,
    host_id: Option<&str>,
) -> Result<(), String> {
    let parent = state_file
        .parent()
        .ok_or_else(|| "invalid serve state path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create run dir: {e}"))?;
    let mut obj = serde_json::Map::new();
    obj.insert("pid".into(), serde_json::json!(pid));
    obj.insert("port".into(), serde_json::json!(port));
    obj.insert(
        "url".into(),
        serde_json::json!(format!("http://127.0.0.1:{port}")),
    );
    if let Some(hid) = host_id.map(str::trim).filter(|s| !s.is_empty()) {
        obj.insert("host_id".into(), serde_json::json!(hid));
    }
    let mut payload = serde_json::to_string_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| e.to_string())?;
    payload.push('\n');

    let name = state_file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("serve.json");
    let tmp = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(err) = fs::write(&tmp, payload.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write serve state temp: {err}"));
    }
    if let Err(err) = fs::rename(&tmp, state_file) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename serve state: {err}"));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn write_serve_state_at(state_file: &Path, pid: u32, port: u16) -> Result<(), String> {
    write_serve_state_with_host_at(state_file, pid, port, None)
}

pub(crate) fn remove_serve_state_at(
    state_file: &Path,
    legacy_pid: Option<&Path>,
    expected_pid: Option<u32>,
) {
    if state_file.exists() {
        let should_remove = match expected_pid {
            Some(pid) => fs::read_to_string(state_file)
                .ok()
                .and_then(|raw| parse_serve_json(&raw))
                .map(|(p, _)| p == pid)
                .unwrap_or(false),
            None => true,
        };
        if should_remove {
            let _ = fs::remove_file(state_file);
        }
    }
    if let Some(lp) = legacy_pid {
        if lp.exists() {
            let should_remove = match expected_pid {
                Some(pid) => fs::read_to_string(lp)
                    .ok()
                    .and_then(|raw| parse_legacy_pid(&raw))
                    .map(|(p, _)| p == pid)
                    .unwrap_or(false),
                None => true,
            };
            if should_remove {
                let _ = fs::remove_file(lp);
            }
        }
    }
}

fn read_pid_file(app: &AppHandle) -> Option<(u32, u16)> {
    let state = state_path().ok()?;
    let legacy = legacy_pid_path(app);
    read_serve_state_at(&state, legacy.as_deref())
}

fn write_pid_file(_app: &AppHandle, pid: u32, port: u16, host_id: Option<&str>) {
    if let Ok(path) = state_path() {
        let _ = write_serve_state_with_host_at(&path, pid, port, host_id);
    }
}

fn remove_pid_file(app: &AppHandle, expected_pid: Option<u32>) {
    if let Ok(path) = state_path() {
        let legacy = legacy_pid_path(app);
        remove_serve_state_at(&path, legacy.as_deref(), expected_pid);
    }
}

// --- interpreter ---------------------------------------------------------

/// Probe whether an argv prefix launches klanker at all. `--version`
/// yields the version string when supported; `--help` only proves the
/// interpreter exists (klanker has no --version flag today).
fn try_probe(argv: &[&str]) -> Option<Option<String>> {
    for flag in ["--version", "--help"] {
        let mut cmd = Command::new(argv[0]);
        cmd.args(&argv[1..]).arg(flag);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let Ok(out) = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).output() else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Some(if flag == "--version" && !text.is_empty() {
            Some(text)
        } else {
            None
        });
    }
    None
}

/// Resolve how to run `klanker`. Probe order: `py -m klanker`,
/// `python -m klanker`, `klanker` on PATH, `uv tool run klanker`.
/// Interpreter forms come first: the `klanker.exe` entry-point shim is a
/// console launcher that dies silently (exit 0, no output) when spawned
/// from a console-less GUI parent under CREATE_NO_WINDOW.
/// Returns (argv_prefix, version).
fn find_klanker(app: &AppHandle) -> Option<(Vec<String>, Option<String>)> {
    for prog in ["py", "python"] {
        if let Some(v) = try_probe(&[prog, "-m", "klanker"]) {
            return Some((vec![prog.into(), "-m".into(), "klanker".into()], v));
        }
    }
    if let Some(v) = try_probe(&["klanker"]) {
        return Some((vec!["klanker".into()], v));
    }
    if let Some(uv) = crate::provision::uv_bin(app) {
        if let Some(v) = try_probe(&[&uv.to_string_lossy(), "tool", "run", "klanker"]) {
            return Some((
                vec![
                    uv.to_string_lossy().into_owned(),
                    "tool".into(),
                    "run".into(),
                    "klanker".into(),
                ],
                v,
            ));
        }
    }
    None
}

fn spawn_klanker(
    argv: &[String],
    port: u16,
    token: &str,
    log: &Path,
    host_dir: &Path,
    relay_host: &str,
) -> Result<u32, String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("open serve.log: {e}"))?;
    let err = file.try_clone().map_err(|e| e.to_string())?;

    {
        let mut f = OpenOptions::new()
            .append(true)
            .open(log)
            .map_err(|e| e.to_string())?;
        let _ = writeln!(f, "[shell] spawn: {}", argv.join(" "));
    }
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .arg("serve")
        .env("RELAY_HOST", relay_host)
        .env("RELAY_PORT", port.to_string())
        // Bearer/API gate (checked by every /v1/* route) plus the cookie
        // login token for the web surface — same minted secret.
        .env("RELAY_SECRET", token)
        .env("RELAY_WEB_TOKEN", token)
        .env("AGENTS_NO_UPDATE_CHECK", "1")
        // Data lives under the host root (~/.agents by default, or AGENTS_HOST_DIR).
        .env("AGENTS_HOST_DIR", host_dir)
        .env("PYTHONUTF8", "1")
        // The bundled webview fetches cross-origin; relay CORS is opt-in
        // via RELAY_CORS_ORIGINS. tauri.localhost covers the packaged app,
        // localhost:1420 covers `tauri dev`.
        .env(
            "RELAY_CORS_ORIGINS",
            "http://tauri.localhost,https://tauri.localhost,tauri://localhost,http://localhost:1420",
        )
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(err));
    // `klanker serve` needs an entry workspace and refuses to guess once the
    // host holds several. Always pin it: an ambient AGENTS_WORKSPACE leaked
    // from a terminal session would silently pick a different entry ws than
    // a desktop-spawned serve on the same host.
    match entry_workspace(host_dir) {
        Some(ws) => {
            cmd.env("AGENTS_WORKSPACE", ws);
        }
        None => {
            cmd.env_remove("AGENTS_WORKSPACE");
        }
    }
    // No DETACHED_PROCESS: the python entry-point shim dies instantly
    // without a console. CREATE_NO_WINDOW hides it for our GUI parent.
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    #[cfg(not(target_os = "windows"))]
    cmd.process_group(0);

    // Diagnose spawn failures in the same log the child would write to —
    // a silent death otherwise leaves only "respawned" markers behind.
    let log_err = |msg: &str| {
        if let Ok(mut f) = OpenOptions::new().append(true).open(log) {
            let _ = writeln!(f, "[shell] spawn failed: {msg}");
        }
    };
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn klanker serve: {e}");
            log_err(&msg);
            return Err(msg);
        }
    };
    let pid = child.id();
    let mut child = child;
    // Surface early exit: a child that dies within the first seconds is a
    // spawn failure, not a running serve.
    std::thread::sleep(Duration::from_secs(3));
    match child.try_wait() {
        Ok(Some(status)) => {
            let msg = format!("klanker serve exited early ({status})");
            log_err(&msg);
            Err(msg)
        }
        Ok(None) => Ok(pid),
        Err(e) => {
            let msg = format!("wait klanker serve: {e}");
            log_err(&msg);
            Err(msg)
        }
    }
}

// --- lifecycle -----------------------------------------------------------

fn emit_serve_state(app: &AppHandle, st: &ServeStatus) {
    crate::tray::update_tray_tooltip(app, st);
    let _ = app.emit("klanker:serve-state", st);
}

fn sync_vault_to_keyring() {
    let vault_tok = crate::secrets::read_host_vault_secret("RELAY_WEB_TOKEN")
        .or_else(|| crate::secrets::read_host_vault_secret("RELAY_SECRET"));
    if let Some(tok) = vault_tok {
        let account = crate::secrets::relay_account("local");
        if crate::secrets::get(&account).as_deref() != Some(tok.as_str()) {
            let _ = crate::secrets::set(&account, &tok);
        }
    }
}

fn resolved_token() -> (String, Option<String>, Option<String>) {
    let vault_tok = crate::secrets::read_host_vault_secret("RELAY_WEB_TOKEN")
        .or_else(|| crate::secrets::read_host_vault_secret("RELAY_SECRET"));
    let keyring_tok = crate::secrets::get(&crate::secrets::relay_account("local"));
    let legacy_pin = dirs::home_dir().map(|h| h.join(".klanker").join("relay-secret"));
    let token = resolve_serve_token(
        vault_tok.clone(),
        keyring_tok.clone(),
        legacy_pin.as_deref(),
    );
    (token, vault_tok, keyring_tok)
}

/// Write the resolved token back to keyring + host vault. Write failures
/// propagate — a silently skipped persist leaves keyring and vault
/// diverged and the next spawn 401s forever.
fn persist_token(token: &str, vault_tok: Option<&str>, keyring_tok: Option<&str>) -> Result<(), String> {
    if keyring_tok != Some(token) {
        crate::secrets::set(&crate::secrets::relay_account("local"), token)?;
    }
    if vault_tok != Some(token)
        || crate::secrets::read_host_vault_secret("RELAY_SECRET").as_deref() != Some(token)
    {
        crate::secrets::write_host_vault_secrets(&[
            ("RELAY_WEB_TOKEN", token),
            ("RELAY_SECRET", token),
        ])?;
    }
    Ok(())
}

/// Blocking half of adopt — pid-file read, `pid_is_ours` (tasklist/proc
/// spawn) and the keyring sync all take real time, so they run BEFORE the
/// ServeState mutex is taken. Returns the recorded PID when our spawned
/// child is still alive, else None (external serve we must not kill).
fn adopt_probe(app: &AppHandle) -> Option<u32> {
    let mut ours = None;
    if let Some((pid, _)) = read_pid_file(app) {
        if pid_is_ours(pid) {
            ours = Some(pid);
        } else {
            remove_pid_file(app, Some(pid));
        }
    }
    sync_vault_to_keyring();
    ours
}

/// Locked half of adopt — a short commit under the ServeState mutex.
fn adopt_commit(s: &mut Serve, live_port: u16, owned_pid: Option<u32>) {
    s.state = "running".into();
    s.pid = owned_pid;
    s.port = live_port;
    s.owned = owned_pid.is_some();
    s.failed_spawns = 0;
    s.detail = if owned_pid.is_some() {
        None
    } else {
        Some("external serve (not app-managed)".into())
    };
}

/// Port the child can actually bind. `bind` is the RELAY_HOST the child
/// will get: a wildcard (0.0.0.0) test fails against services bound to a
/// specific LAN IP that a loopback test would miss.
fn pick_port_excluding(avoid: &[u16], bind: &str) -> u16 {
    if !avoid.contains(&DEFAULT_PORT) && TcpListener::bind((bind, DEFAULT_PORT)).is_ok() {
        return DEFAULT_PORT;
    }
    for _ in 0..8 {
        if let Ok(listener) = TcpListener::bind((bind, 0)) {
            if let Ok(addr) = listener.local_addr() {
                let p = addr.port();
                if !avoid.contains(&p) {
                    return p;
                }
            }
        }
    }
    DEFAULT_PORT
}

fn candidate_ports(s: &Serve, app: &AppHandle) -> Vec<u16> {
    let mut out = Vec::new();
    if let Some((_, file_port)) = read_pid_file(app) {
        if !out.contains(&file_port) {
            out.push(file_port);
        }
    }
    if s.port > 0 && !out.contains(&s.port) {
        out.push(s.port);
    }
    if !out.contains(&DEFAULT_PORT) {
        out.push(DEFAULT_PORT);
    }
    out
}

fn valid_ws_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && !name.contains("..")
}

/// Entry workspace for `klanker serve`:
/// 1. `<host>/agents.json -> default_workspace` (if present under `<host>/workspaces/`),
/// 2. `"default"`,
/// 3. first workspace directory under `<host>/workspaces/`.
/// None when the host has no workspaces yet — serve still boots.
pub(crate) fn entry_workspace(host_dir: &Path) -> Option<String> {
    let ws_root = host_dir.join("workspaces");
    if let Ok(raw) = fs::read_to_string(host_dir.join("agents.json")) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(configured) = val.get("default_workspace").and_then(|v| v.as_str()) {
                let configured = configured.trim();
                if valid_ws_name(configured) && ws_root.join(configured).is_dir() {
                    return Some(configured.to_string());
                }
            }
        }
    }
    if ws_root.join("default").is_dir() {
        return Some("default".into());
    }
    let mut dirs_found: Vec<String> = fs::read_dir(&ws_root)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            (e.path().is_dir() && valid_ws_name(&name)).then_some(name)
        })
        .collect();
    dirs_found.sort();
    dirs_found.into_iter().next()
}

fn read_legacy_pin(pin_path: Option<&Path>) -> Option<String> {
    let path = pin_path?;
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Resolve the shared host bearer token without writing `~/.klanker/relay-secret`:
/// `<home>/.agents/secrets/host.json` (`RELAY_WEB_TOKEN`) <-> OS Keyring (`relay.local`),
/// 1-release read-only fallback to `~/.klanker/relay-secret`, else mint a fresh UUID.
pub(crate) fn resolve_serve_token(
    vault_token: Option<String>,
    keyring_token: Option<String>,
    legacy_pin: Option<&Path>,
) -> String {
    vault_token
        .or(keyring_token)
        .or_else(|| read_legacy_pin(legacy_pin))
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string())
}

fn do_ensure(app: &AppHandle, hub_mode: bool, force_own: bool) -> Result<ServeStatus, String> {
    let host_dir = crate::desktop_host_dir()?;
    fs::create_dir_all(&host_dir).map_err(|e| format!("create host dir: {e}"))?;
    let expected_host_id = crate::desktop_host_id_at(&host_dir).ok();
    let relay_host = if hub_mode { "0.0.0.0" } else { "127.0.0.1" };
    let serve_state = app.state::<ServeState>();

    // Every ServeState critical section below is a snapshot or a short
    // commit — TCP probes, process spawns, kill waits and sleep polling
    // all run unlocked inside the spawn_blocking worker.
    let candidates = {
        let s = serve_lock(&serve_state)?;
        candidate_ports(&s, app)
    };
    let mut foreign_ports: Vec<u16> = Vec::new();

    for port in candidates {
        let Some(health) = probe_health(port) else {
            continue;
        };
        if let Some(ref hid) = expected_host_id {
            if !host_id_matches(&health, hid) {
                foreign_ports.push(port);
                continue;
            }
        }
        let (token, vault_tok, keyring_tok) = resolved_token();
        if !force_own && auth_ok(port, &token) {
            persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref())?;
            let bind = port_bind_addr(port);
            let owned_pid = adopt_probe(app);
            let st = {
                let mut s = serve_lock(&serve_state)?;
                adopt_commit(&mut s, port, owned_pid);
                s.host = bind.unwrap_or_else(|| "127.0.0.1".into());
                ServeStatus::of(&s)
            };
            emit_serve_state(app, &st);
            return Ok(st);
        }

        // Strict 1-serve-per-device: same-host serve on `port` (force_own restart
        // or token mismatch). Reclaim cleanly instead of spawning a 2nd instance.
        let target_pid = read_pid_file(app)
            .filter(|(pid, fport)| *fport == port && pid_alive(*pid))
            .map(|(pid, _)| pid)
            .or_else(|| {
                can_reclaim_by_port(&health, expected_host_id.as_deref())
                    .then(|| pid_on_port(port))
                    .flatten()
            });
        if let Some(pid) = target_pid {
            if pid_is_ours(pid) {
                kill_tree(pid);
                for _ in 0..40 {
                    if !pid_alive(pid) && !health_ok(port) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                remove_pid_file(app, Some(pid));
                let mut s = serve_lock(&serve_state)?;
                s.pid = None;
                s.owned = false;
            } else {
                foreign_ports.push(port);
            }
        } else {
            // Live same-host serve without discoverable PID — refuse duplicate spawn.
            let st = {
                let mut s = serve_lock(&serve_state)?;
                s.state = "lost".into();
                s.owned = false;
                s.port = port;
                s.detail = Some("cannot reclaim same-host serve without PID".into());
                ServeStatus::of(&s)
            };
            emit_serve_state(app, &st);
            return Ok(st);
        }
    }

    // A booting child needs grace — python imports take seconds. Only
    // reap it once the boot window passed without health, or it died.
    {
        let (state_name, pid, last_spawn) = {
            let s = serve_lock(&serve_state)?;
            (s.state.clone(), s.pid, s.last_spawn)
        };
        if state_name == "starting" {
            let booted_long = last_spawn
                .map(|t| t.elapsed() > Duration::from_secs(60))
                .unwrap_or(false);
            if let Some(pid) = pid {
                if pid_alive(pid) && !booted_long {
                    let st = {
                        let s = serve_lock(&serve_state)?;
                        ServeStatus::of(&s)
                    };
                    crate::tray::update_tray_tooltip(app, &st);
                    return Ok(st);
                }
            }
        }
    }

    // Dead. An owned zombie gets reaped before respawn.
    let reap_pid = {
        let s = serve_lock(&serve_state)?;
        if s.owned {
            s.pid
        } else {
            None
        }
    };
    if let Some(pid) = reap_pid {
        if pid_alive(pid) {
            kill_tree(pid);
        }
    }

    {
        let mut s = serve_lock(&serve_state)?;
        if s.failed_spawns >= MAX_RESPAWNS {
            if let Some(t) = s.last_spawn {
                if t.elapsed() > Duration::from_secs(RESPAWN_WINDOW_SECS) {
                    s.failed_spawns = 0; // window elapsed — budget refills
                }
            }
            if s.failed_spawns >= MAX_RESPAWNS {
                s.state = "lost".into();
                s.detail = Some("serve died repeatedly — restart manually".into());
                let st = ServeStatus::of(&s);
                drop(s);
                emit_serve_state(app, &st);
                return Ok(st);
            }
        }
    }

    let found = find_klanker(app);
    let Some((argv, version)) = found else {
        let st = {
            let mut s = serve_lock(&serve_state)?;
            s.state = "not_found".into();
            s.detail = Some(
                "klanker not found — install via `uv tool install klanker` or `pip install klanker`"
                    .into(),
            );
            ServeStatus::of(&s)
        };
        emit_serve_state(app, &st);
        return Ok(st);
    };

    let port = pick_port_excluding(&foreign_ports, relay_host);
    let (token, vault_tok, keyring_tok) = resolved_token();
    let log = log_path(app)?;
    match spawn_klanker(&argv, port, &token, &log, &host_dir, relay_host) {
        Ok(pid) => {
            // A serve we cannot authenticate to is an orphan — reap it
            // instead of leaking a child the app will never adopt.
            if let Err(e) = persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref()) {
                kill_tree(pid);
                remove_pid_file(app, Some(pid));
                let st = {
                    let mut s = serve_lock(&serve_state)?;
                    s.klanker_version = version;
                    s.failed_spawns += 1;
                    s.last_spawn = Some(Instant::now());
                    s.state = "stopped".into();
                    s.detail = Some(format!("token persist failed: {e}"));
                    ServeStatus::of(&s)
                };
                emit_serve_state(app, &st);
                return Err(e);
            }
            write_pid_file(app, pid, port, expected_host_id.as_deref());
            let healthy = probe_health(port).is_some();
            let st = {
                let mut s = serve_lock(&serve_state)?;
                s.klanker_version = version;
                s.failed_spawns += 1;
                s.last_spawn = Some(Instant::now());
                s.state = if healthy { "running".into() } else { "starting".into() };
                s.pid = Some(pid);
                s.port = port;
                s.host = relay_host.into();
                s.owned = true;
                s.detail = None;
                ServeStatus::of(&s)
            };
            emit_serve_state(app, &st);
            Ok(st)
        }
        Err(e) => {
            let st = {
                let mut s = serve_lock(&serve_state)?;
                s.klanker_version = version;
                s.failed_spawns += 1;
                s.last_spawn = Some(Instant::now());
                s.state = "stopped".into();
                s.detail = Some(e);
                ServeStatus::of(&s)
            };
            emit_serve_state(app, &st);
            Ok(st)
        }
    }
}

/// Short-lived ServeState guard — blocking probes/kills never hold it.
/// Takes `&State` (not `&AppHandle`): the guard borrows through the
/// caller-owned State, which outlives every block it is used in.
fn serve_lock<'s>(
    state: &'s tauri::State<'_, ServeState>,
) -> Result<std::sync::MutexGuard<'s, Serve>, String> {
    state.0.lock().map_err(|e| e.to_string())
}

/// Serializes ensure/restart/status so two lifecycle ops never interleave
/// (double-spawn). Only ever locked inside spawn_blocking workers, so
/// waiting here never stalls an async runtime thread.
static LIFECYCLE: Mutex<()> = Mutex::new(());

enum ProbeOutcome {
    Adopt(u16, Option<String>),
    AuthLost(u16),
}

fn status(app: &AppHandle) -> Result<(ServeStatus, bool), String> {
    let expected_host_id = crate::desktop_host_dir()
        .ok()
        .and_then(|d| crate::desktop_host_id_at(&d).ok());
    let serve_state = app.state::<ServeState>();
    let (prev, candidates) = {
        let s = serve_lock(&serve_state)?;
        (
            (s.state.clone(), s.port, s.owned, s.pid, s.host.clone()),
            candidate_ports(&s, app),
        )
    };

    let mut handled = false;
    let mut outcome: Option<ProbeOutcome> = None;
    for port in candidates {
        let Some(health) = probe_health(port) else {
            continue;
        };
        if let Some(ref hid) = expected_host_id {
            if !host_id_matches(&health, hid) {
                continue;
            }
        }
        handled = true;
        let (token, vault_tok, keyring_tok) = resolved_token();
        if auth_ok(port, &token) {
            persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref())?;
            outcome = Some(ProbeOutcome::Adopt(port, port_bind_addr(port)));
        } else {
            outcome = Some(ProbeOutcome::AuthLost(port));
        }
        break;
    }

    let mark_lost = if !handled {
        let (state_name, owned, pid) = {
            let s = serve_lock(&serve_state)?;
            (s.state.clone(), s.owned, s.pid)
        };
        (state_name == "running" || state_name == "starting")
            && (!owned || pid.is_some_and(|p| !pid_alive(p)))
    } else {
        false
    };

    // The adopt probe spawns tasklist/proc reads and touches the keyring —
    // resolve it before the commit lock, never under it.
    let adopt_pid = if matches!(outcome, Some(ProbeOutcome::Adopt(..))) {
        adopt_probe(app)
    } else {
        None
    };
    let mut s = serve_lock(&serve_state)?;
    match outcome {
        Some(ProbeOutcome::Adopt(port, bind)) => {
            adopt_commit(&mut s, port, adopt_pid);
            s.host = bind.unwrap_or_else(|| "127.0.0.1".into());
        }
        Some(ProbeOutcome::AuthLost(port)) => {
            s.state = "lost".into();
            s.owned = false;
            s.port = port;
            s.detail =
                Some("auth token mismatch — restart respawns a serve we can reach".into());
        }
        None => {}
    }
    if mark_lost {
        s.state = "lost".into();
        s.detail = Some("serve stopped answering".into());
    }
    let changed = (s.state.clone(), s.port, s.owned, s.pid, s.host.clone()) != prev;
    Ok((ServeStatus::of(&s), changed))
}

fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let pgid_arg = format!("-{pid}");
        let pg_ok = Command::new("kill")
            .args(["-TERM", &pgid_arg])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|st| st.success())
            .unwrap_or(false);
        if !pg_ok {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        for _ in 0..12 {
            if !pid_alive(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if pg_ok {
            let _ = Command::new("kill")
                .args(["-KILL", &pgid_arg])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Kill the owned child on app exit. Foreign serves are untouched.
pub fn kill_owned(app: &AppHandle) {
    let (owned, owned_pid) = {
        let binding = app.state::<ServeState>();
        let Ok(state) = binding.0.lock() else {
            return;
        };
        (state.owned, state.pid)
    };
    if owned {
        if let Some(pid) = owned_pid {
            if pid_alive(pid) {
                kill_tree(pid);
            }
        }
        remove_pid_file(app, owned_pid);
    }
}

// --- commands ------------------------------------------------------------

/// All lifecycle work (TCP probes, tasklist/netstat, kill_tree, spawn
/// grace sleeps) is blocking — it runs on `spawn_blocking` so tokio
/// worker threads stay free and the UI never stalls.
#[tauri::command]
pub async fn serve_status(app: AppHandle) -> Result<ServeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _cycle = LIFECYCLE.lock().map_err(|e| e.to_string())?;
        let (st, changed) = status(&app)?;
        if changed {
            emit_serve_state(&app, &st);
        } else {
            crate::tray::update_tray_tooltip(&app, &st);
        }
        Ok(st)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ensure a local serve answers. Called by the web layer when the active
/// instance is the managed `local` entry — spawn policy lives in JS.
/// `hub_mode` binds the spawned serve on 0.0.0.0 (LAN-reachable hub)
/// instead of the 127.0.0.1 default.
#[tauri::command]
pub async fn serve_ensure_local(app: AppHandle, hub_mode: Option<bool>) -> Result<ServeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _cycle = LIFECYCLE.lock().map_err(|e| e.to_string())?;
        do_ensure(&app, hub_mode.unwrap_or(false), false)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn resolve_restart_hub_mode(explicit: Option<bool>, prev_host: &str) -> bool {
    explicit.unwrap_or_else(|| prev_host == "0.0.0.0")
}

/// Manual retry from the "server lost" state — resets the respawn budget.
/// Both owned and external same-host serves are stopped cleanly before respawn
/// so at most one serve runs per host.
#[tauri::command]
pub async fn serve_restart(app: AppHandle, hub_mode: Option<bool>) -> Result<ServeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _cycle = LIFECYCLE.lock().map_err(|e| e.to_string())?;
        let serve_state = app.state::<ServeState>();
        let (killed, prev_host) = {
            let mut s = serve_lock(&serve_state)?;
            s.failed_spawns = 0;
            let prev_host = s.host.clone();
            let pid = if s.owned { s.pid.take() } else { None };
            if pid.is_some() {
                s.state = "stopped".into();
                s.owned = false;
            }
            (pid, prev_host)
        };
        if let Some(pid) = killed {
            kill_tree(pid);
            for _ in 0..40 {
                if !pid_alive(pid) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            remove_pid_file(&app, Some(pid));
        }
        let target_hub_mode = resolve_restart_hub_mode(hub_mode, &prev_host);
        do_ensure(&app, target_hub_mode, true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// init() cannot propagate errors — persist failures land in the serve
/// log instead of vanishing.
fn log_persist_err(app: &AppHandle, res: Result<(), String>) {
    if let Err(e) = res {
        if let Ok(log) = log_path(app) {
            if let Ok(mut f) = OpenOptions::new().append(true).open(log) {
                let _ = writeln!(f, "[shell] token persist failed: {e}");
            }
        }
    }
}

/// Warm the state at app start: adopt recorded or canonical port serve ONLY
/// when host_id and bearer token verify cleanly.
pub fn init(app: &AppHandle) {
    app.manage(ServeState(Mutex::new(Serve::default())));
    let expected_host_id = crate::desktop_host_dir()
        .ok()
        .and_then(|d| crate::desktop_host_id_at(&d).ok());
    if let Some((pid, port)) = read_pid_file(app) {
        let host_ok = probe_health(port)
            .map(|h| {
                expected_host_id
                    .as_deref()
                    .map(|id| host_id_matches(&h, id))
                    .unwrap_or(true)
            })
            .unwrap_or(false);
        let (token, vault_tok, keyring_tok) = resolved_token();
        if pid_is_ours(pid) && host_ok && auth_ok(port, &token) {
            log_persist_err(app, persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref()));
            let bind = port_bind_addr(port);
            let state = app.state::<ServeState>();
            if let Ok(mut s) = state.0.lock() {
                s.state = "running".into();
                s.pid = Some(pid);
                s.port = port;
                s.host = bind.unwrap_or_else(|| "127.0.0.1".into());
                s.owned = true;
            };
            return;
        }
        if !pid_alive(pid) {
            remove_pid_file(app, Some(pid));
        }
    }
    if let Some(health) = probe_health(DEFAULT_PORT) {
        let host_ok = expected_host_id
            .as_deref()
            .map(|id| host_id_matches(&health, id))
            .unwrap_or(true);
        let (token, vault_tok, keyring_tok) = resolved_token();
        if host_ok && auth_ok(DEFAULT_PORT, &token) {
            log_persist_err(app, persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref()));
            let bind = port_bind_addr(DEFAULT_PORT);
            let owned_pid = adopt_probe(app);
            let state = app.state::<ServeState>();
            if let Ok(mut s) = state.0.lock() {
                adopt_commit(&mut s, DEFAULT_PORT, owned_pid);
                s.host = bind.unwrap_or_else(|| "127.0.0.1".into());
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "klanker-serve-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn entry_workspace_honors_agents_json_default_workspace_then_default_then_first() {
        let tmp = TempDir::new("ws");
        let host = &tmp.0;
        assert_eq!(entry_workspace(host), None);

        fs::create_dir_all(host.join("workspaces").join(".trash").join("old")).unwrap();
        fs::create_dir_all(host.join("workspaces").join("beta")).unwrap();
        fs::create_dir_all(host.join("workspaces").join("alpha")).unwrap();
        assert_eq!(entry_workspace(host).as_deref(), Some("alpha"));

        fs::create_dir_all(host.join("workspaces").join("default")).unwrap();
        assert_eq!(entry_workspace(host).as_deref(), Some("default"));

        // Invalid or missing configured default_workspace falls back to "default".
        fs::write(host.join("agents.json"), r#"{"default_workspace":"missing"}"#).unwrap();
        assert_eq!(entry_workspace(host).as_deref(), Some("default"));

        fs::write(host.join("agents.json"), r#"{"default_workspace":"../escape"}"#).unwrap();
        assert_eq!(entry_workspace(host).as_deref(), Some("default"));

        // Valid existing default_workspace wins over "default".
        fs::write(host.join("agents.json"), r#"{"default_workspace":"beta"}"#).unwrap();
        assert_eq!(entry_workspace(host).as_deref(), Some("beta"));
    }

    #[test]
    fn serve_json_round_trip_and_legacy_pid_fallback() {
        let tmp = TempDir::new("state");
        let state_file = tmp.0.join("run").join("serve.json");
        let legacy_pid = tmp.0.join("legacy").join("serve.pid");
        fs::create_dir_all(legacy_pid.parent().unwrap()).unwrap();

        assert_eq!(read_serve_state_at(&state_file, Some(&legacy_pid)), None);

        // Legacy key=value serve.pid fallback when serve.json is absent.
        fs::write(&legacy_pid, "pid=4321\nport=8888\n").unwrap();
        assert_eq!(
            read_serve_state_at(&state_file, Some(&legacy_pid)),
            Some((4321, 8888))
        );

        // serve.json takes precedence once written.
        write_serve_state_at(&state_file, 9999, 9123).unwrap();
        assert_eq!(
            read_serve_state_at(&state_file, Some(&legacy_pid)),
            Some((9999, 9123))
        );

        // CLI-written serve.json with extra "url" field parses cleanly.
        fs::write(
            &state_file,
            r#"{"pid": 5555, "port": 8787, "url": "http://127.0.0.1:8787"}"#,
        )
        .unwrap();
        assert_eq!(
            read_serve_state_at(&state_file, Some(&legacy_pid)),
            Some((5555, 8787))
        );

        // Removing with mismatched PID preserves serve.json; matching PID removes it.
        remove_serve_state_at(&state_file, Some(&legacy_pid), Some(1111));
        assert!(state_file.exists());
        remove_serve_state_at(&state_file, Some(&legacy_pid), Some(5555));
        assert!(!state_file.exists());
    }

    #[test]
    fn resolve_serve_token_precedence_and_read_only_legacy_pin() {
        let tmp = TempDir::new("tok");
        let pin = tmp.0.join(".klanker").join("relay-secret");
        fs::create_dir_all(pin.parent().unwrap()).unwrap();
        fs::write(&pin, "legacy-pin\n").unwrap();

        assert_eq!(
            resolve_serve_token(Some("vault-tok".into()), Some("kr-tok".into()), Some(&pin)),
            "vault-tok"
        );
        assert_eq!(
            resolve_serve_token(None, Some("kr-tok".into()), Some(&pin)),
            "kr-tok"
        );
        assert_eq!(
            resolve_serve_token(None, None, Some(&pin)),
            "legacy-pin"
        );
        // Legacy pin stays untouched; missing all sources mints a fresh UUID without creating pin.
        let missing_pin = tmp.0.join("missing").join("relay-secret");
        let minted = resolve_serve_token(None, None, Some(&missing_pin));
        assert!(!minted.is_empty());
        assert!(!missing_pin.exists());
    }

    #[test]
    fn desktop_host_dir_honors_override_and_host_id_persists() {
        let tmp = TempDir::new("hostid");
        let custom = tmp.0.to_string_lossy().to_string();
        assert_eq!(crate::desktop_host_dir_with(Some(&custom)).unwrap(), tmp.0);
        assert_ne!(crate::desktop_host_dir_with(Some("   ")).unwrap(), tmp.0);

        fs::write(tmp.0.join("agents.json"), r#"{"default_workspace":"work"}"#).unwrap();
        let id1 = crate::desktop_host_id_at(&tmp.0).unwrap();
        assert!(id1.starts_with("host_"));
        let id2 = crate::desktop_host_id_at(&tmp.0).unwrap();
        assert_eq!(id1, id2);
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(tmp.0.join("agents.json")).unwrap()).unwrap();
        assert_eq!(saved["default_workspace"], "work");
        assert_eq!(saved["host_id"], id1);
    }

    #[test]
    fn health_probe_and_host_id_guard_refuse_mismatch() {
        let ok_raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"host_id\":\"host_abc\",\"port\":9010}";
        let parsed = parse_health_response(ok_raw).unwrap();
        assert_eq!(parsed.host_id.as_deref(), Some("host_abc"));
        assert_eq!(parsed.port, Some(9010));
        assert!(host_id_matches(&parsed, "host_abc"));
        assert!(!host_id_matches(&parsed, "host_other"));

        // Legacy relay omitting host_id stays compatible.
        let legacy_raw = "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}";
        let legacy = parse_health_response(legacy_raw).unwrap();
        assert!(host_id_matches(&legacy, "host_abc"));

        assert!(parse_health_response("HTTP/1.1 500 ERR\r\n\r\n").is_none());
    }

    #[test]
    fn serve_json_writes_url_and_host_id() {
        let tmp = TempDir::new("serve-hid");
        let state_file = tmp.0.join("run").join("serve.json");
        write_serve_state_with_host_at(&state_file, 7777, 9444, Some("host_xyz")).unwrap();
        let val: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&state_file).unwrap()).unwrap();
        assert_eq!(val["pid"], 7777);
        assert_eq!(val["port"], 9444);
        assert_eq!(val["url"], "http://127.0.0.1:9444");
        assert_eq!(val["host_id"], "host_xyz");
        assert_eq!(read_serve_state_at(&state_file, None), Some((7777, 9444)));
    }

    #[test]
    fn parse_netstat_listen_pid_is_locale_independent() {
        let sample = "\
Aktive Verbindungen
  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    127.0.0.1:19010        0.0.0.0:0              ABHÖREN         1111
  TCP    127.0.0.1:9010         127.0.0.1:54321        HERGESTELLT     2222
  TCP    127.0.0.1:9010         0.0.0.0:0              ABHÖREN         3333
  TCP    [::1]:9011             [::]:0                 LISTENING       4444
";
        assert_eq!(parse_netstat_listen_pid(sample, 9010), Some(3333));
        assert_eq!(parse_netstat_listen_pid(sample, 9011), Some(4444));
        assert_eq!(parse_netstat_listen_pid(sample, 8787), None);
    }

    #[test]
    fn can_reclaim_by_port_requires_explicit_matching_host_id() {
        let matched = HealthProbe {
            host_id: Some("host_abc".into()),
            port: Some(8787),
            version: None,
        };
        let missing_hid = HealthProbe {
            host_id: None,
            port: Some(8787),
            version: None,
        };
        let blank_hid = HealthProbe {
            host_id: Some("   ".into()),
            port: Some(8787),
            version: None,
        };
        assert!(can_reclaim_by_port(&matched, Some("host_abc")));
        assert!(!can_reclaim_by_port(&matched, Some("host_other")));
        assert!(!can_reclaim_by_port(&matched, None));
        assert!(!can_reclaim_by_port(&matched, Some(" ")));
        assert!(!can_reclaim_by_port(&missing_hid, Some("host_abc")));
        assert!(!can_reclaim_by_port(&blank_hid, Some("host_abc")));
    }

    #[test]
    fn parse_lsof_listen_addr_maps_wildcard_loopback_and_v6() {
        let sample = "p1234\nf3\nn*:8787\np5555\nf4\nn127.0.0.1:9010\nn[::1]:9011\n";
        assert_eq!(parse_lsof_listen_addr(sample, 8787).as_deref(), Some("0.0.0.0"));
        assert_eq!(parse_lsof_listen_addr(sample, 9010).as_deref(), Some("127.0.0.1"));
        assert_eq!(parse_lsof_listen_addr(sample, 9011).as_deref(), Some("::1"));
        // A listener on a different port never aliases (host suffix match only).
        assert_eq!(parse_lsof_listen_addr(sample, 787).as_deref(), None);
        assert_eq!(parse_lsof_listen_addr("", 8787).as_deref(), None);
    }

    #[test]
    fn tasklist_csv_pid_match_is_exact_column_not_substring() {
        let out = "\"python.exe\",\"1234\",\"Console\",\"1\",\"45,120 K\"\r\n\
                   \"uv.exe\",\"9123\",\"Console\",\"1\",\"8,912 K\"\r\n\
                   \"klanker.exe\",\"123\",\"Services\",\"0\",\"12,000 K\"\r\n";
        assert!(tasklist_csv_has_pid(out, 123));
        assert!(tasklist_csv_has_pid(out, 1234));
        assert!(tasklist_csv_has_pid(out, 9123));
        // Substring matches that the old `.contains(&pid.to_string())` hit.
        assert!(!tasklist_csv_has_pid(out, 12));
        assert!(!tasklist_csv_has_pid(out, 23));
        assert!(!tasklist_csv_has_pid(out, 45));
        assert!(!tasklist_csv_has_pid(out, 120));
        // tasklist /NH "no tasks" line + empty output.
        assert!(!tasklist_csv_has_pid("INFO: No tasks are running which match the specified criteria.\r\n", 123));
        assert!(!tasklist_csv_has_pid("", 123));
    }

    #[test]
    fn health_probe_parses_version_and_klanker_version() {
        let raw = "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"version\":\"0.9.1\",\"host_id\":\"host_v\",\"port\":8787}";
        let p = parse_health_response(raw).unwrap();
        assert_eq!(p.version.as_deref(), Some("0.9.1"));
        let raw2 = "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"klanker_version\":\"0.9.2\"}";
        assert_eq!(parse_health_response(raw2).unwrap().version.as_deref(), Some("0.9.2"));
    }

    #[test]
    fn restart_hub_mode_preserves_prior_lan_bind_when_explicit_none() {
        assert!(resolve_restart_hub_mode(None, "0.0.0.0"));
        assert!(!resolve_restart_hub_mode(None, "127.0.0.1"));
        assert!(!resolve_restart_hub_mode(None, ""));
        assert!(!resolve_restart_hub_mode(Some(false), "0.0.0.0"));
        assert!(resolve_restart_hub_mode(Some(true), "127.0.0.1"));
    }
}
