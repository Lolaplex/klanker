//! Local `klanker serve` lifecycle — LM-Studio model.
//!
//! The app owns at most one user-visible child: `klanker serve` on
//! 127.0.0.1. An already-running serve (CLI, Docker, whatever) is
//! adopted, never killed. A serve spawned by us is PID-tracked and
//! killed on tray-quit. The web side drives the lifecycle through two
//! commands: `serve_ensure_local` (spawn if dead, bounded respawn) and
//! `serve_restart` (manual retry that resets the respawn budget).
//!
//! Token bootstrap: every app-spawned serve gets a fresh
//! `RELAY_WEB_TOKEN` via env — never argv, never logged — stored in the
//! OS keyring under `relay.local` for the web layer to use as Bearer.

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
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

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir)
}

fn pid_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("serve.pid"))
}

pub fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("serve.log"))
}

// --- health / process ----------------------------------------------------

pub fn health_ok(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut s) = TcpStream::connect(&addr) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(3)));
    if s
        .write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 512];
    let n = s.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/") && head.contains(" 200")
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

fn read_pid_file(app: &AppHandle) -> Option<(u32, u16)> {
    let content = fs::read_to_string(pid_path(app).ok()?).ok()?;
    let mut pid = None;
    let mut port = None;
    for line in content.lines() {
        let (k, v) = line.split_once('=')?;
        match k.trim() {
            "pid" => pid = v.trim().parse().ok(),
            "port" => port = v.trim().parse().ok(),
            _ => {}
        }
    }
    pid.map(|p| (p, port.unwrap_or(DEFAULT_PORT)))
}

fn write_pid_file(app: &AppHandle, pid: u32, port: u16) {
    if let Ok(path) = pid_path(app) {
        let _ = fs::write(path, format!("pid={pid}\nport={port}\n"));
    }
}

fn remove_pid_file(app: &AppHandle) {
    if let Ok(path) = pid_path(app) {
        let _ = fs::remove_file(path);
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

/// Resolve how to run `klanker`. Probe order: `klanker` on PATH,
/// `py -m klanker`, `python -m klanker`, `uv tool run klanker`.
/// Returns (argv_prefix, version).
fn find_klanker(app: &AppHandle) -> Option<(Vec<String>, Option<String>)> {
    if let Some(v) = try_probe(&["klanker"]) {
        return Some((vec!["klanker".into()], v));
    }
    for prog in ["py", "python"] {
        if let Some(v) = try_probe(&[prog, "-m", "klanker"]) {
            return Some((vec![prog.into(), "-m".into(), "klanker".into()], v));
        }
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
    log: &PathBuf,
    host_dir: &PathBuf,
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
        // Data lives under the instance folder, which is the host root.
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
    // host holds several. Pick `default` when present, else the first ws.
    if std::env::var_os("AGENTS_WORKSPACE").is_none() {
        if let Some(ws) = entry_workspace(host_dir) {
            cmd.env("AGENTS_WORKSPACE", ws);
        }
    }
    // No DETACHED_PROCESS: the python entry-point shim dies instantly
    // without a console. CREATE_NO_WINDOW hides it for our GUI parent.
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    let child = cmd
        .spawn()
        .map_err(|e| format!("spawn klanker serve: {e}"))?;
    let pid = child.id();
    let mut child = child;
    // Surface early exit: a child that dies within the first seconds is a
    // spawn failure, not a running serve.
    std::thread::sleep(Duration::from_secs(3));
    match child.try_wait() {
        Ok(Some(status)) => Err(format!("klanker serve exited early ({status})")),
        Ok(None) => Ok(pid),
        Err(e) => Err(format!("wait klanker serve: {e}")),
    }
}

// --- lifecycle -----------------------------------------------------------

fn adopt_or_mark(s: &mut Serve, app: &AppHandle) {
    // A serve is already answering on the port. If our recorded PID is
    // still alive we spawned it earlier -> owned; otherwise foreign.
    if let Some((pid, port)) = read_pid_file(app) {
        if pid_is_ours(pid) {
            s.state = "running".into();
            s.pid = Some(pid);
            s.port = port;
            s.owned = true;
            s.failed_spawns = 0;
            s.detail = None;
            return;
        }
        remove_pid_file(app);
    }
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
/// serve` uses on the CLI — `AGENTS_HOST_DIR` or `~/.agents`. Sharing one
/// stem means workspaces, personas, inbox and secrets are identical no
/// matter who spawned the process.
fn instance_host_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    let dir = std::env::var_os("AGENTS_HOST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".agents"));
    fs::create_dir_all(&dir).map_err(|e| format!("create host dir: {e}"))?;
    Ok(dir)
}

/// Entry workspace for `klanker serve`: `default` wins, else the first
/// directory under `<host>/workspaces`. None when the host has no ws yet —
/// serve still boots (per-request turns pick their own).
fn entry_workspace(host_dir: &PathBuf) -> Option<String> {
    let ws_root = host_dir.join("workspaces");
    if ws_root.join("default").is_dir() {
        return Some("default".into());
    }
    fs::read_dir(&ws_root).ok()?.flatten().find_map(|e| {
        e.path().is_dir().then(|| e.file_name().to_string_lossy().to_string())
    })
}

fn do_ensure(app: &AppHandle, workdir: &str, force_own: bool) -> Result<ServeStatus, String> {
    let state = app.state::<ServeState>();
    let mut s = state.0.lock().map_err(|e| e.to_string())?;

    if health_ok(s.port) || health_ok(DEFAULT_PORT) {
        if !force_own {
            adopt_or_mark(&mut s, app);
            return Ok(ServeStatus::of(&s));
        }
        // Restart semantics: never adopt a foreign process — its token is
        // not the keyring one, so linking would fail forever. Leave it
        // running and spawn our own on a fresh port instead.
        s.owned = false;
        s.pid = None;
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
        s.detail = Some("klanker not found — install via `uv tool install klanker` or `pip install klanker`".into());
        return Ok(ServeStatus::of(&s));
    };
    s.klanker_version = version;

    let port = pick_port();
    // Machine-wide pin wins over keyring: `klanker serve` (CLI) reads and
    // writes `~/.klanker/relay-secret`, so every serve on this host shares
    // one bearer — a foreign process validates the same token we hold.
    let pin = dirs::home_dir().map(|h| h.join(".klanker").join("relay-secret"));
    let pinned = pin
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let token = pinned
        .or_else(|| crate::secrets::get(&crate::secrets::relay_account("local")))
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    if let Some(p) = &pin {
        if fs::read_to_string(p).map(|s| s.trim() != token).unwrap_or(true) {
            let _ = fs::create_dir_all(p.parent().unwrap_or(p));
            let _ = fs::write(p, format!("{token}\n"));
        }
    }
    let log = log_path(app)?;
    let host_dir = instance_host_dir(app)?;
    if !workdir.is_empty() {
        let _ = fs::create_dir_all(workdir);
    }
    match spawn_klanker(&argv, port, &token, &log, &host_dir, workdir) {
        Ok(pid) => {
            let _ = crate::secrets::set(&crate::secrets::relay_account("local"), &token);
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
    if health_ok(s.port) || health_ok(DEFAULT_PORT) {
        adopt_or_mark(&mut s, app);
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
    drop(state);
    remove_pid_file(app);
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
pub async fn serve_ensure_local(app: AppHandle, workdir: Option<String>) -> Result<ServeStatus, String> {
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
/// port is still ours; a port answering without a pid file is foreign.
pub fn init(app: &AppHandle) {
    app.manage(ServeState(Mutex::new(Serve::default())));
    if let Some((pid, port)) = read_pid_file(app) {
        if pid_is_ours(pid) && health_ok(port) {
            let state = app.state::<ServeState>();
            if let Ok(mut s) = state.0.lock() {
                s.state = "running".into();
                s.pid = Some(pid);
                s.port = port;
                s.owned = true;
            };
            return;
        }
        remove_pid_file(app);
    }
    if health_ok(DEFAULT_PORT) {
        let state = app.state::<ServeState>();
        if let Ok(mut s) = state.0.lock() {
            adopt_or_mark(&mut s, app);
        };
    }
}
