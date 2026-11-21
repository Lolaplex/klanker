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
use tauri::{AppHandle, Manager};

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

fn probe(port: u16, request: &str) -> Option<String> {
    let addr = format!("127.0.0.1:{port}");
    let mut s = TcpStream::connect(&addr).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(3)));
    s.write_all(request.as_bytes()).ok()?;
    let mut buf = [0u8; 512];
    let n = s.read(&mut buf).unwrap_or(0);
    Some(String::from_utf8_lossy(&buf[..n]).into_owned())
}

pub fn health_ok(port: u16) -> bool {
    probe(port, "GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .map(|head| head.starts_with("HTTP/") && head.contains(" 200"))
        .unwrap_or(false)
}

/// Bearer probe modelling exactly what the frontend sends: a healthy serve
/// whose secret we cannot resolve is indistinguishable from a dead one —
/// every /v1 call 401s. Verified adoption requires the resolved token to
/// authenticate, so a stale env-only token (dead parent, rotated store)
/// triggers a respawn instead of being adopted.
fn auth_ok(port: u16, token: &str) -> bool {
    let req = format!(
        "GET /v1/workspaces HTTP/1.0\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\n\r\n"
    );
    probe(port, &req)
        .map(|head| head.starts_with("HTTP/") && head.contains(" 200"))
        .unwrap_or(false)
}

/// PID listening on a TCP port — needed to take the port back from a serve
/// we cannot authenticate to (one serve per device).
fn pid_on_port(port: u16) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        let out = Command::new("netstat")
            .args(["-ano", "-p", "tcp"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let suffix = format!(":{port}");
        for line in text.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            // Proto  Local          Foreign        State      PID
            if cols.len() >= 5 && cols[3] == "LISTENING" && cols[1].ends_with(&suffix) {
                if let Ok(pid) = cols[4].parse::<u32>() {
                    return Some(pid);
                }
            }
        }
        None
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
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
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

pub(crate) fn write_serve_state_at(state_file: &Path, pid: u32, port: u16) -> Result<(), String> {
    let parent = state_file
        .parent()
        .ok_or_else(|| "invalid serve state path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create run dir: {e}"))?;
    let mut payload = serde_json::to_string_pretty(&serde_json::json!({
        "pid": pid,
        "port": port,
    }))
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

fn write_pid_file(_app: &AppHandle, pid: u32, port: u16) {
    if let Ok(path) = state_path() {
        let _ = write_serve_state_at(&path, pid, port);
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
    workdir: &str,
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
        .env("RELAY_HOST", "127.0.0.1")
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
    if !workdir.is_empty() {
        cmd.env("AGENTS_WORKDIR", workdir);
    }
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

fn sync_vault_to_keyring() {
    if let Some(vault_tok) = crate::secrets::read_host_vault_secret("RELAY_WEB_TOKEN") {
        let account = crate::secrets::relay_account("local");
        if crate::secrets::get(&account).as_deref() != Some(vault_tok.as_str()) {
            let _ = crate::secrets::set(&account, &vault_tok);
        }
    }
}

fn adopt_or_mark(s: &mut Serve, app: &AppHandle) {
    // A serve is already answering on the port. If our recorded PID is
    // still alive we spawned it earlier -> owned; otherwise foreign.
    if let Some((pid, port)) = read_pid_file(app) {
        if pid_is_ours(pid) {
            sync_vault_to_keyring();
            s.state = "running".into();
            s.pid = Some(pid);
            s.port = port;
            s.owned = true;
            s.failed_spawns = 0;
            s.detail = None;
            return;
        }
        remove_pid_file(app, Some(pid));
    }
    sync_vault_to_keyring();
    s.state = "running".into();
    s.pid = None;
    s.port = DEFAULT_PORT;
    s.owned = false;
    s.failed_spawns = 0;
    s.detail = Some("foreign serve (not app-managed)".into());
}

fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).is_ok() {
        return DEFAULT_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .map(|l| l.local_addr().map(|a| a.port()).unwrap_or(DEFAULT_PORT))
        .unwrap_or(DEFAULT_PORT)
}

/// Data root for the managed local serve: the same host root `klanker
/// serve` uses on the CLI — `AGENTS_HOST_DIR` or `~/.agents` (`desktop_host_dir()`).
/// Sharing one stem means workspaces, personas, inbox and secrets are
/// identical no matter who spawned the process.
fn instance_host_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var_os("AGENTS_HOST_DIR").filter(|v| !v.is_empty()) {
        Some(val) => PathBuf::from(val),
        None => crate::desktop_host_dir()?,
    };
    fs::create_dir_all(&dir).map_err(|e| format!("create host dir: {e}"))?;
    Ok(dir)
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

/// Shared host bearer token as resolved from vault, keyring, legacy pin,
/// or freshly minted — plus which stores already held it.
fn resolved_token() -> (String, Option<String>, Option<String>) {
    let vault_tok = crate::secrets::read_host_vault_secret("RELAY_WEB_TOKEN");
    let keyring_tok = crate::secrets::get(&crate::secrets::relay_account("local"));
    let legacy_pin = dirs::home_dir().map(|h| h.join(".klanker").join("relay-secret"));
    let token = resolve_serve_token(
        vault_tok.clone(),
        keyring_tok.clone(),
        legacy_pin.as_deref(),
    );
    (token, vault_tok, keyring_tok)
}

/// Sync the shared token into BOTH stores — the frontend reads the keyring,
/// `klanker serve`/CLI consumers read the host vault. Adoption must persist
/// too: a resolved pin or keyring token is useless to the UI when the other
/// store stays empty.
fn persist_token(token: &str, vault_tok: Option<&str>, keyring_tok: Option<&str>) {
    if keyring_tok != Some(token) {
        let _ = crate::secrets::set(&crate::secrets::relay_account("local"), token);
    }
    if vault_tok != Some(token) {
        let _ = crate::secrets::write_host_vault_secret("RELAY_WEB_TOKEN", token);
    }
}

fn do_ensure(app: &AppHandle, workdir: &str, force_own: bool) -> Result<ServeStatus, String> {
    let state = app.state::<ServeState>();
    let mut s = state.0.lock().map_err(|e| e.to_string())?;

    let live_port = if health_ok(s.port) {
        Some(s.port)
    } else if health_ok(DEFAULT_PORT) {
        Some(DEFAULT_PORT)
    } else {
        None
    };
    if let Some(port) = live_port {
        let (token, vault_tok, keyring_tok) = resolved_token();
        if auth_ok(port, &token) {
            persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref());
            if !force_own {
                adopt_or_mark(&mut s, app);
                return Ok(ServeStatus::of(&s));
            }
            // Restart semantics: never adopt a foreign process — a changed
            // secret must take effect via a respawn we own.
            s.owned = false;
            s.pid = None;
        } else {
            // Token mismatch: the port is held by a serve spawned with a
            // secret we can no longer resolve (env-only mint by a dead
            // parent, rotated store). One serve per device — take the port
            // back. A non-klanker listener is never killed; we spawn on a
            // fresh port instead.
            if let Some(pid) = pid_on_port(port) {
                if pid_is_ours(pid) {
                    kill_tree(pid);
                    for _ in 0..40 {
                        if !pid_alive(pid) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                    remove_pid_file(app, Some(pid));
                    s.pid = None;
                    s.owned = false;
                }
            }
        }
    }

    // A booting child needs grace — python imports take seconds. Only
    // reap it once the boot window passed without health, or it died.
    if s.state == "starting" {
        let booted_long = s
            .last_spawn
            .map(|t| t.elapsed() > Duration::from_secs(60))
            .unwrap_or(false);
        if let Some(pid) = s.pid {
            if pid_alive(pid) && !booted_long {
                return Ok(ServeStatus::of(&s));
            }
        }
    }

    // Dead. An owned zombie gets reaped before respawn.
    if let Some(pid) = s.pid {
        if s.owned && pid_alive(pid) {
            kill_tree(pid);
        }
    }

    if s.failed_spawns >= MAX_RESPAWNS {
        if let Some(t) = s.last_spawn {
            if t.elapsed() > Duration::from_secs(RESPAWN_WINDOW_SECS) {
                s.failed_spawns = 0; // window elapsed — budget refills
            }
        }
        if s.failed_spawns >= MAX_RESPAWNS {
            s.state = "lost".into();
            s.detail = Some("serve died repeatedly — restart manually".into());
            return Ok(ServeStatus::of(&s));
        }
    }

    let Some((argv, version)) = find_klanker(app) else {
        s.state = "not_found".into();
        s.detail = Some(
            "klanker not found — install via `uv tool install klanker` or `pip install klanker`"
                .into(),
        );
        return Ok(ServeStatus::of(&s));
    };
    s.klanker_version = version;

    let port = pick_port();
    // Shared host bearer: OS Keyring (`relay.local`) <-> host vault
    // (`~/.agents/secrets/host.json` -> `RELAY_WEB_TOKEN`), fallback read-only
    // to `~/.klanker/relay-secret`, else mint a fresh UUID. Sync into BOTH
    // keyring and host vault; never write `~/.klanker/relay-secret`.
    let (token, vault_tok, keyring_tok) = resolved_token();
    let log = log_path(app)?;
    let host_dir = instance_host_dir(app)?;
    if !workdir.is_empty() {
        let _ = fs::create_dir_all(workdir);
    }
    match spawn_klanker(&argv, port, &token, &log, &host_dir, workdir) {
        Ok(pid) => {
            persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref());
            write_pid_file(app, pid, port);
            s.failed_spawns += 1;
            s.last_spawn = Some(Instant::now());
            s.state = "starting".into();
            s.pid = Some(pid);
            s.port = port;
            s.owned = true;
            s.detail = None;
        }
        Err(e) => {
            s.failed_spawns += 1;
            s.last_spawn = Some(Instant::now());
            s.state = "stopped".into();
            s.detail = Some(e);
        }
    }
    Ok(ServeStatus::of(&s))
}

fn status(app: &AppHandle) -> Result<ServeStatus, String> {
    let state = app.state::<ServeState>();
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    let live_port = if health_ok(s.port) {
        Some(s.port)
    } else if health_ok(DEFAULT_PORT) {
        Some(DEFAULT_PORT)
    } else {
        None
    };
    if let Some(port) = live_port {
        // Honest state: a running serve we cannot authenticate to is lost
        // to the UI, not "running". The next ensure/restart respawns it.
        let (token, _, _) = resolved_token();
        if !auth_ok(port, &token) {
            s.state = "lost".into();
            s.owned = false;
            s.detail = Some("auth token mismatch — restart respawns a serve we can reach".into());
        } else {
            adopt_or_mark(&mut s, app);
        }
    } else if s.state == "running" || s.state == "starting" {
        let owned_dead = s.owned && s.pid.is_some() && !pid_alive(s.pid.unwrap_or(0));
        if owned_dead || !s.owned {
            s.state = "lost".into();
            s.detail = Some("serve stopped answering".into());
        }
    }
    Ok(ServeStatus::of(&s))
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
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
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
        if state.owned {
            if let Some(pid) = state.pid {
                if pid_alive(pid) {
                    kill_tree(pid);
                }
            }
        }
        (state.owned, state.pid)
    };
    if owned {
        remove_pid_file(app, owned_pid);
    }
}

// --- commands ------------------------------------------------------------

#[tauri::command]
pub async fn serve_status(app: AppHandle) -> Result<ServeStatus, String> {
    let st = status(&app)?;
    // The frontend polls this every few seconds — reflect the state in
    // the tray tooltip so hidden operation is still visible.
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if st.state == "running" {
            format!(
                "Klanker — serve :{} ({})",
                st.port,
                if st.owned { "managed" } else { "external" }
            )
        } else {
            format!("Klanker — serve {}", st.state)
        };
        let _ = tray.set_tooltip(Some(&tip));
    }
    Ok(st)
}

/// Ensure a local serve answers. Called by the web layer when the active
/// instance is the managed `local` entry — spawn policy lives in JS.
#[tauri::command]
pub async fn serve_ensure_local(
    app: AppHandle,
    workdir: Option<String>,
) -> Result<ServeStatus, String> {
    do_ensure(&app, workdir.as_deref().unwrap_or(""), false)
}

/// Manual retry from the "server lost" state — resets the respawn budget.
/// An owned serve is actually killed first: without that the health probe
/// in `do_ensure` adopts the still-dying process and the "restart" becomes
/// a no-op, so a new agents-relay build or changed env is never picked up.
/// A foreign serve is never killed, but never adopted either — restart
/// means "a serve we own", so a changed secret actually takes effect.
#[tauri::command]
pub async fn serve_restart(app: AppHandle, workdir: Option<String>) -> Result<ServeStatus, String> {
    let mut killed = None;
    {
        let state = app.state::<ServeState>();
        let mut s = state.0.lock().map_err(|e| e.to_string())?;
        s.failed_spawns = 0;
        if s.owned {
            if let Some(pid) = s.pid.take() {
                kill_tree(pid);
                killed = Some(pid);
            }
            s.state = "stopped".into();
            s.owned = false;
        }
    }
    if let Some(pid) = killed {
        for _ in 0..40 {
            if !pid_alive(pid) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    do_ensure(&app, workdir.as_deref().unwrap_or(""), true)
}

/// Warm the state at app start: a live pid-file serve on its recorded
/// port is still ours — but only when it still accepts the resolvable
/// token. A mismatched one is left stopped so ensure spawns a fresh serve.
pub fn init(app: &AppHandle) {
    app.manage(ServeState(Mutex::new(Serve::default())));
    if let Some((pid, port)) = read_pid_file(app) {
        let (token, vault_tok, keyring_tok) = resolved_token();
        if pid_is_ours(pid) && health_ok(port) && auth_ok(port, &token) {
            persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref());
            let state = app.state::<ServeState>();
            if let Ok(mut s) = state.0.lock() {
                s.state = "running".into();
                s.pid = Some(pid);
                s.port = port;
                s.owned = true;
            };
            return;
        }
        remove_pid_file(app, Some(pid));
    }
    if health_ok(DEFAULT_PORT) {
        let (token, vault_tok, keyring_tok) = resolved_token();
        if !auth_ok(DEFAULT_PORT, &token) {
            return; // unverifiable listener — ensure will take the port back
        }
        persist_token(&token, vault_tok.as_deref(), keyring_tok.as_deref());
        let state = app.state::<ServeState>();
        if let Ok(mut s) = state.0.lock() {
            adopt_or_mark(&mut s, app);
        };
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
        fs::write(
            host.join("agents.json"),
            r#"{"default_workspace":"missing"}"#,
        )
        .unwrap();
        assert_eq!(entry_workspace(host).as_deref(), Some("default"));

        fs::write(
            host.join("agents.json"),
            r#"{"default_workspace":"../escape"}"#,
        )
        .unwrap();
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
        assert_eq!(resolve_serve_token(None, None, Some(&pin)), "legacy-pin");
        // Legacy pin stays untouched; missing all sources mints a fresh UUID without creating pin.
        let missing_pin = tmp.0.join("missing").join("relay-secret");
        let minted = resolve_serve_token(None, None, Some(&missing_pin));
        assert!(!minted.is_empty());
        assert!(!missing_pin.exists());
    }
}
