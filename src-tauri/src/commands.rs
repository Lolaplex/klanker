use crate::models::{
    DesktopSettings, DiscoveredPeer, InstanceEndpoint, InstanceKind, KlankerInstance,
    PendingApproval, ProcessStatus, ProviderModels, TracePage, TurnResponse,
};
use crate::presence::{self, PresenceOffer};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub fn silent_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: prevents console popup on Windows
    cmd
}

pub struct AppState {
    pub running_processes: Mutex<HashMap<String, u32>>, // instance_id -> PID
}

fn get_instances_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let dir = home.join(".klanker").join("instances");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create instances dir: {}", e))?;
    }
    Ok(dir)
}

fn instance_path(id: &str) -> Result<PathBuf, String> {
    Ok(get_instances_dir()?.join(format!("{id}.json")))
}

pub(crate) fn read_instance(id: &str) -> Result<KlankerInstance, String> {
    let content = fs::read_to_string(instance_path(id)?).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn write_instance(instance: &KlankerInstance) -> Result<(), String> {
    let json = serde_json::to_string_pretty(instance).map_err(|e| e.to_string())?;
    fs::write(instance_path(&instance.id)?, json)
        .map_err(|e| format!("Failed to save instance file: {}", e))
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains("..") || id.contains(['/', '\\', ':']) {
        return Err("invalid instance id".into());
    }
    Ok(())
}

fn is_remote(inst: &KlankerInstance) -> bool {
    inst.kind == InstanceKind::Remote
}

fn secret_value(inst: &KlankerInstance) -> String {
    let account = crate::secrets::relay_account(&inst.id);
    if let Some(value) = crate::secrets::get(&account) {
        if !value.is_empty() {
            return value;
        }
    }
    inst.secret
        .as_deref()
        .or_else(|| inst.endpoint.as_ref().and_then(|e| e.secret.as_deref()))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn kept_local_port(previous: Option<u16>) -> Option<u16> {
    previous.filter(|port| *port != 0)
}

fn without_secrets(mut instance: KlankerInstance) -> KlankerInstance {
    instance.api_key = None;
    instance.secret = None;
    if let Some(ep) = instance.endpoint.as_mut() {
        ep.secret = None;
    }
    instance.has_secret = false;
    instance
}

fn for_ui(mut instance: KlankerInstance) -> KlankerInstance {
    let file_secret = instance
        .secret
        .as_deref()
        .or_else(|| instance.endpoint.as_ref().and_then(|e| e.secret.as_deref()))
        .is_some_and(|value| !value.trim().is_empty());
    instance.has_secret = file_secret || crate::secrets::present(&crate::secrets::relay_account(&instance.id));
    instance.api_key = None;
    instance.secret = None;
    instance
}

fn store_relay_secret(id: &str, incoming: &str, previous: &str) -> Result<(), String> {
    let account = crate::secrets::relay_account(id);
    let incoming = incoming.trim();
    if !incoming.is_empty() {
        return crate::secrets::set(&account, incoming);
    }
    if crate::secrets::present(&account) {
        return Ok(());
    }
    let previous = previous.trim();
    if previous.is_empty() {
        return Ok(());
    }
    crate::secrets::set(&account, previous)
}

fn relay_origin(inst: &KlankerInstance) -> Result<String, String> {
    if is_remote(inst) {
        let raw = inst
            .endpoint
            .as_ref()
            .map(|e| e.base_url.as_str())
            .or(inst.base_url.as_deref())
            .unwrap_or("");
        return remote_origin(raw);
    }
    Ok(format!("http://127.0.0.1:{}", inst.port))
}

fn instance_root_in(instances_dir: &Path, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(instances_dir.join(id).join("root"))
}

fn instance_root(id: &str) -> Result<PathBuf, String> {
    instance_root_in(&get_instances_dir()?, id)
}

fn remote_origin(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("remote instance has no base_url".into());
    }
    let (scheme, rest) = if let Some(rest) = raw.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = raw.strip_prefix("http://") {
        ("http", rest)
    } else {
        return Err("remote base_url must be an http(s) URL".into());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("").trim();
    if authority.is_empty() || authority.contains('@') || authority.contains(' ') {
        return Err("remote base_url must be an http(s) origin".into());
    }
    Ok(format!("{scheme}://{authority}"))
}

fn pid_path(id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(get_instances_dir()?.join(id).join("daemon.pid"))
}

fn load_pid(inst: &KlankerInstance) -> Option<u32> {
    if let Some(pid) = inst.pid {
        return Some(pid);
    }
    let path = pid_path(&inst.id).ok()?;
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

pub(crate) fn store_pid(inst: &mut KlankerInstance, pid: Option<u32>) -> Result<(), String> {
    inst.pid = pid;
    inst.updated_at = chrono::Utc::now().to_rfc3339();
    write_instance(inst)?;
    let path = pid_path(&inst.id)?;
    match pid {
        Some(pid) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(path, format!("{pid}\n")).map_err(|e| e.to_string())
        }
        None => {
            if path.exists() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

pub(crate) fn remember(state: &AppState, id: &str, pid: Option<u32>) {
    let mut procs = state.running_processes.lock().unwrap();
    match pid {
        Some(pid) => {
            procs.insert(id.to_string(), pid);
        }
        None => {
            procs.remove(id);
        }
    }
}

fn local_port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

fn with_secret(req: reqwest::RequestBuilder, secret: &str) -> Result<reqwest::RequestBuilder, String> {
    if secret.is_empty() {
        return Ok(req);
    }
    let value = reqwest::header::HeaderValue::from_str(secret)
        .map_err(|_| "relay secret is not a valid header value".to_string())?;
    Ok(req.header("X-Relay-Secret", value))
}

async fn health_ok(origin: &str, secret: &str) -> bool {
    let Ok(client) = http_client(Duration::from_millis(600)) else {
        return false;
    };
    let Ok(req) = with_secret(client.get(format!("{origin}/health")), secret) else {
        return false;
    };
    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(body) => body.get("ok").and_then(|v| v.as_bool()) == Some(true),
            Err(_) => false,
        },
        _ => false,
    }
}

fn redact_secrets(text: &str, inst: &KlankerInstance) -> String {
    let mut out = text.to_string();
    let mut values = vec![secret_value(inst)];
    if let Some(key) = inst.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        values.push(key.to_string());
    }
    if let Some(key) = window_openrouter_key() {
        values.push(key);
    }
    for raw in values {
        if !raw.is_empty() {
            out = out.replace(&raw, "[redacted]");
        }
    }
    out
}

fn log_tail(root: &Path, inst: &KlankerInstance) -> String {
    let text = fs::read_to_string(root.join("serve.log")).unwrap_or_default();
    let redacted = redact_secrets(&text, inst);
    let trimmed = redacted.trim();
    let tail: String = trimmed.chars().rev().take(400).collect::<String>().chars().rev().collect();
    tail
}

#[cfg(windows)]
pub(crate) fn pid_alive(pid: u32) -> bool {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(desired: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    if pid == 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
pub(crate) fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    silent_command("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn process_command_line(pid: u32) -> Result<String, String> {
    #[cfg(windows)]
    {
        let script = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
        let out = silent_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("could not read pid {pid} command line: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "could not read pid {pid} command line: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    #[cfg(not(windows))]
    {
        let raw = fs::read(format!("/proc/{pid}/cmdline"))
            .map_err(|e| format!("could not read pid {pid} command line: {e}"))?;
        Ok(String::from_utf8_lossy(&raw).replace('\0', " "))
    }
}

/// True when a recorded pid still looks like the process this instance started.
///
/// A declared start command is matched by every argv element; the built-in
/// serve path keeps the older "klanker serve" check.
fn command_matches(line: &str, inst: &KlankerInstance) -> bool {
    let lower = line.to_lowercase();
    if let Some(spec) = inst.start_cmd.as_ref() {
        if spec.argv.is_empty() {
            return false;
        }
        return spec.argv.iter().all(|part| {
            let part = part.trim().to_lowercase();
            part.is_empty() || lower.contains(&part)
        });
    }
    lower.contains("klanker") && lower.contains("serve")
}

pub(crate) fn is_our_process(pid: u32, inst: &KlankerInstance) -> Result<(), String> {
    let line = process_command_line(pid)?;
    if command_matches(&line, inst) {
        return Ok(());
    }
    Err(format!(
        "recorded pid {pid} does not match this instance; not killing it"
    ))
}

pub(crate) fn kill_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    let out = silent_command("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("taskkill failed to start: {e}"))?;
    #[cfg(not(windows))]
    let out = silent_command("kill")
        .args(["-TERM", &format!("-{pid}")])
        .output()
        .map_err(|e| format!("kill failed to start: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let msg = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    let lower = msg.to_lowercase();
    if lower.contains("not found") || lower.contains("no such process") {
        return Ok(());
    }
    Err(format!("failed to stop pid {pid}: {}", msg.trim()))
}

fn status_of(inst: &KlankerInstance, health: bool, port_open: bool, pid: Option<u32>, alive: bool) -> ProcessStatus {
    let owned = alive;
    let state = if health {
        if is_remote(inst) || owned {
            "running"
        } else {
            "not_owned"
        }
    } else if !is_remote(inst) && port_open && !owned {
        "port_busy"
    } else {
        "stopped"
    };
    let detail = match state {
        "not_owned" => "relay is up but this app did not start it".to_string(),
        "port_busy" => format!(
            "port {} is in use by a process this app did not start",
            inst.port
        ),
        "stopped" if owned => format!("pid {} is up, health is not", pid.unwrap_or(0)),
        _ => String::new(),
    };
    ProcessStatus {
        is_running: state == "running",
        pid: if owned { pid } else { None },
        port: inst.port,
        last_ping: Some(chrono::Utc::now().to_rfc3339()),
        state: state.to_string(),
        detail,
    }
}

async fn probe_instance(inst: &KlankerInstance) -> Result<ProcessStatus, String> {
    let origin = relay_origin(inst)?;
    let secret = secret_value(inst);
    let health = health_ok(&origin, &secret).await;
    let port_open = if is_remote(inst) {
        health
    } else {
        local_port_open(inst.port)
    };
    let pid = load_pid(inst);
    let alive = pid.map(pid_alive).unwrap_or(false);
    Ok(status_of(inst, health, port_open, pid, alive))
}

pub(crate) struct PythonInv {
    pub(crate) program: String,
    pub(crate) prefix: Vec<String>,
}

fn hidden_status(program: &str, args: &[&str]) -> bool {
    let mut cmd = silent_command(program);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.status().map(|status| status.success()).unwrap_or(false)
}

#[cfg(windows)]
fn python_exe_candidates() -> Vec<String> {
    let mut cmd = silent_command("where.exe");
    cmd.arg("python");
    cmd.stdin(Stdio::null());
    cmd.stderr(Stdio::null());
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            lower.ends_with("python.exe") && !lower.contains("\\windowsapps\\")
        })
        .map(str::to_string)
        .collect()
}

fn resolve_python_for(module: &str) -> Result<PythonInv, String> {
    let probe = format!("import {module}");
    let mut programs = Vec::new();
    #[cfg(windows)]
    programs.extend(python_exe_candidates());
    if programs.is_empty() {
        programs.push("python".to_string());
    }
    for program in &programs {
        if hidden_status(program, &["-c", probe.as_str()]) {
            return Ok(PythonInv {
                program: program.clone(),
                prefix: Vec::new(),
            });
        }
    }
    #[cfg(windows)]
    if hidden_status("py", &["-3", "-c", probe.as_str()]) {
        return Ok(PythonInv {
            program: "py".to_string(),
            prefix: vec!["-3".to_string()],
        });
    }
    Err(format!("python -m {module} not found (tried python.exe, then py -3)"))
}

fn resolve_python() -> Result<PythonInv, String> {
    resolve_python_for("klanker")
}

/// Presence publishing signs via the suite's key-custody CLI — the desktop
/// never reads `~/.agents/keys/*.ed25519` itself.
pub(crate) fn resolve_agents_keys() -> Result<PythonInv, String> {
    resolve_python_for("agents_keys")
}

fn prepare_root(id: &str) -> Result<PathBuf, String> {
    let root = instance_root(id)?;
    for sub in ["traces", "schedules", "relay", "modules"] {
        fs::create_dir_all(root.join(sub)).map_err(|e| format!("failed to create {sub}: {e}"))?;
    }
    let mcp = root.join("mcp.json");
    if !mcp.exists() {
        fs::write(&mcp, "{\"mcpServers\":{}}\n").map_err(|e| e.to_string())?;
    }
    Ok(root)
}

/// The instance's workspace decision is not a free-form env knob. A start
/// command may set its own environment, but it must not silently widen or
/// drop the boundary the instance declares.
fn apply_workspace_env(cmd: &mut Command, inst: &KlankerInstance) {
    if inst.workspace.trim().is_empty() {
        return;
    }
    cmd.env("AGENTS_WORKSPACE_DIR", inst.workspace.trim());
    if inst.lock_workspace {
        cmd.env("AGENTS_WORKSPACE_LOCK", "1");
    } else {
        cmd.env_remove("AGENTS_WORKSPACE_LOCK");
    }
}

fn configure_child_env(cmd: &mut Command, inst: &KlankerInstance, root: &Path) {
    for key in [
        "TELEGRAM_BOT_TOKEN",
        "LLM_API_KEY",
        "LLM_BASE_URL",
        "LLM_MODEL",
        "GITHUB_TOKEN",
        "RELAY_SECRET",
        "GATEWAY_SECRET",
        "LOOP_CMD",
        "LOOP_PROVIDER",
    ] {
        cmd.env_remove(key);
    }
    cmd.env("RELAY_HOST", "127.0.0.1");
    cmd.env("RELAY_PORT", inst.port.to_string());
    cmd.env("KLANKER_TICK", "0");
    cmd.env("AGENTS_HOME", root);
    cmd.env("AGENTS_TRACES_DIR", root.join("traces"));
    cmd.env("AGENTS_IDENTITY_PATH", root.join("identity.json"));
    cmd.env("AGENTS_SCHEDULES_DIR", root.join("schedules"));
    cmd.env("AGENTS_RELAY_STATE", root.join("relay"));
    cmd.env("AGENTS_MODULES_DIR", root.join("modules"));
    cmd.env("AGENTS_MCP_CONFIG", root.join("mcp.json"));
    cmd.env("AGENTS_MCP_CACHE", root.join("mcp-tools-cache.json"));
    apply_workspace_env(cmd, inst);
    apply_provider_env(cmd, inst);
    let secret = secret_value(inst);
    if !secret.is_empty() {
        cmd.env("RELAY_SECRET", secret);
    }
}

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1";
const LMSTUDIO_URL: &str = "http://127.0.0.1:1234/v1";

/// agents-harness `runner/providers/openai.default.json` @ c24ce12147fef784a26293f30f8da681743441e7
/// is `openai_compat` and reads `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`.
fn loopback_llm_url(raw: &str) -> bool {
    let raw = raw.trim();
    let Some(rest) = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

fn provider_kind(raw: &str) -> &'static str {
    if raw.eq_ignore_ascii_case("echo") {
        "echo"
    } else if raw.eq_ignore_ascii_case("openrouter") {
        "openrouter"
    } else if raw.eq_ignore_ascii_case("lmstudio") || raw.eq_ignore_ascii_case("lmstudio.local") {
        "lmstudio"
    } else if raw.eq_ignore_ascii_case("inherit") {
        "inherit"
    } else {
        ""
    }
}

fn openrouter_host(raw: &str) -> bool {
    let raw = raw.trim();
    let Some(rest) = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(inner) = host.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };
    host.eq_ignore_ascii_case("openrouter.ai")
}

fn is_openrouter(inst: &KlankerInstance) -> bool {
    provider_kind(&inst.provider) == "openrouter"
        || openrouter_host(inst.base_url.as_deref().unwrap_or(""))
}

fn loop_provider_name(inst: &KlankerInstance) -> Option<&'static str> {
    if provider_kind(&inst.provider) == "echo" {
        return Some("echo");
    }
    if is_openrouter(inst) {
        return Some("openai.default");
    }
    if inst.provider.trim().is_empty() || provider_kind(&inst.provider) == "inherit" {
        return None;
    }
    let url = inst.base_url.as_deref().unwrap_or("").trim();
    if loopback_llm_url(url) {
        return Some("openai.default");
    }
    None
}

fn settings_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.join(".klanker").join("settings.json"))
}

fn default_settings() -> DesktopSettings {
    DesktopSettings {
        provider: "echo".to_string(),
        openrouter_api_key: String::new(),
        openrouter_key_set: false,
        model: String::new(),
        workspace: crate::models::default_window_workspace(),
        lmstudio_base_url: LMSTUDIO_URL.to_string(),
        recent_models: ProviderModels::default(),
        favorites: ProviderModels::default(),
    }
}

fn take_ids(raw: Vec<String>, limit: Option<usize>) -> Vec<String> {
    let mut out = Vec::new();
    for id in raw {
        let id = id.trim().to_string();
        if id.is_empty() || out.iter().any(|have| have == &id) {
            continue;
        }
        out.push(id);
        if limit.is_some_and(|max| out.len() == max) {
            break;
        }
    }
    out
}

fn sanitize_settings(mut settings: DesktopSettings) -> DesktopSettings {
    let provider = settings.provider.trim().to_ascii_lowercase();
    settings.provider = match provider.as_str() {
        "lmstudio" | "lmstudio.local" => "lmstudio".to_string(),
        "openrouter" => "openrouter".to_string(),
        _ => "echo".to_string(),
    };
    settings.openrouter_api_key = settings.openrouter_api_key.trim().to_string();
    settings.model = settings.model.trim().to_string();
    let workspace = settings.workspace.trim().to_string();
    settings.workspace = if workspace.is_empty() {
        crate::models::default_window_workspace()
    } else {
        workspace
    };
    let url = settings.lmstudio_base_url.trim().trim_end_matches('/');
    settings.lmstudio_base_url = if url.is_empty() {
        LMSTUDIO_URL.to_string()
    } else {
        url.to_string()
    };
    settings.recent_models = ProviderModels {
        openrouter: take_ids(settings.recent_models.openrouter, Some(8)),
        lmstudio: take_ids(settings.recent_models.lmstudio, Some(8)),
    };
    settings.favorites = ProviderModels {
        openrouter: take_ids(settings.favorites.openrouter, None),
        lmstudio: take_ids(settings.favorites.lmstudio, None),
    };
    settings
}

fn read_settings() -> DesktopSettings {
    let Ok(path) = settings_path() else {
        return default_settings();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return default_settings();
    };
    sanitize_settings(serde_json::from_str(&text).unwrap_or_else(|_| default_settings()))
}

fn window_openrouter_key() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    if let Some(key) = crate::secrets::get(crate::secrets::OPENROUTER) {
        if !key.is_empty() {
            return Some(key);
        }
    }
    let key = read_settings().openrouter_api_key;
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

fn settings_for_disk(mut settings: DesktopSettings) -> DesktopSettings {
    settings.openrouter_api_key.clear();
    settings.openrouter_key_set = false;
    settings
}

fn resolved_for_env(inst: &KlankerInstance) -> KlankerInstance {
    if provider_kind(&inst.provider) != "inherit" {
        return inst.clone();
    }
    let settings = read_settings();
    let mut copy = inst.clone();
    copy.provider = settings.provider.clone();
    match settings.provider.as_str() {
        "echo" => {
            copy.base_url = None;
            copy.api_key = None;
        }
        "openrouter" => {
            copy.base_url = Some(OPENROUTER_URL.to_string());
            copy.api_key = None;
            if copy.model.trim().is_empty() {
                copy.model = settings.model;
            }
        }
        "lmstudio" => {
            if copy
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .is_none()
            {
                copy.base_url = Some(settings.lmstudio_base_url);
            }
            if copy.model.trim().is_empty() {
                copy.model = settings.model;
            }
        }
        _ => {}
    }
    copy
}

/// Echo stays `echo` and exports `LOOP_PROVIDER=echo` with no `LLM_*`.
/// A blank provider plus a loopback URL becomes `openai.default` on save.
/// OpenRouter keeps its provider and the public API root. Files are not rewritten on load.
fn normalize_local_model(instance: &mut KlankerInstance) {
    match provider_kind(&instance.provider) {
        "echo" => {
            instance.provider = "echo".to_string();
            instance.base_url = None;
            instance.api_key = None;
        }
        "inherit" => {
            instance.provider = "inherit".to_string();
            instance.base_url = None;
            instance.api_key = None;
            instance.model = instance.model.trim().to_string();
        }
        "openrouter" => {
            instance.provider = "openrouter".to_string();
            instance.base_url = Some(OPENROUTER_URL.to_string());
            instance.api_key = None;
            instance.model = instance.model.trim().to_string();
        }
        "lmstudio" => {
            if !instance.provider.eq_ignore_ascii_case("lmstudio.local") {
                instance.provider = "lmstudio".to_string();
            }
            instance.base_url = instance
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_string);
            instance.model = instance.model.trim().to_string();
            instance.api_key = instance
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string);
        }
        _ => {
            let url = instance
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .map(str::to_string);
            let provider_blank = instance.provider.trim().is_empty();
            match url {
                None => {
                    instance.base_url = None;
                    if provider_blank {
                        instance.provider.clear();
                    }
                }
                Some(url) => {
                    let loopback = loopback_llm_url(&url);
                    let openrouter = openrouter_host(&url);
                    instance.base_url = Some(url);
                    if provider_blank && loopback {
                        instance.provider = "openai.default".to_string();
                    } else if provider_blank && !openrouter {
                        instance.provider.clear();
                    }
                }
            }
        }
    }
}

fn port_bindable(port: u16) -> bool {
    port != 0 && std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn allocate_port(except_id: &str) -> u16 {
    let mut taken = Vec::new();
    if let Ok(dir) = get_instances_dir() {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(inst) = serde_json::from_str::<KlankerInstance>(&text) else {
                    continue;
                };
                if inst.id == except_id || inst.kind == InstanceKind::Remote {
                    continue;
                }
                taken.push(inst.port);
            }
        }
    }
    let mut port: u16 = 8787;
    loop {
        if !taken.contains(&port) && port_bindable(port) {
            return port;
        }
        if port == u16::MAX {
            return 8787;
        }
        port += 1;
    }
}

/// Non-empty prompt becomes `LOOP_CMD`. Empty leaves it unset so `klanker serve` injects its own.
///
/// Quoted with `posix_arg`, the same form the approval bridge uses: the relay
/// splits `LOOP_CMD` with the platform's quoting rules, so a path with a space
/// survives on both Windows and POSIX.
fn custom_loop_cmd(py: &PythonInv, inst: &KlankerInstance, root: &Path) -> Result<Option<String>, String> {
    let prompt = inst.system_prompt.trim();
    if prompt.is_empty() {
        return Ok(None);
    }
    let path = root.join("system-prompt.txt");
    fs::write(&path, prompt).map_err(|e| format!("failed to write system prompt: {e}"))?;
    let mut parts = vec![posix_arg(&py.program)];
    parts.extend(py.prefix.iter().map(|arg| posix_arg(arg)));
    parts.extend([
        "-m".to_string(),
        "klanker.turn".to_string(),
        "--system".to_string(),
        posix_arg(&path.to_string_lossy()),
    ]);
    Ok(Some(parts.join(" ")))
}

fn apply_provider_env(cmd: &mut Command, inst: &KlankerInstance) {
    apply_provider_env_with(cmd, inst, window_openrouter_key().as_deref());
}

fn apply_provider_env_with(cmd: &mut Command, inst: &KlankerInstance, or_key: Option<&str>) {
    let inst = resolved_for_env(inst);
    let Some(name) = loop_provider_name(&inst) else {
        return;
    };
    cmd.env("LOOP_PROVIDER", name);
    if name != "openai.default" {
        return;
    }
    if is_openrouter(&inst) {
        cmd.env("LLM_BASE_URL", OPENROUTER_URL);
        if !inst.model.trim().is_empty() {
            cmd.env("LLM_MODEL", inst.model.trim());
        }
        if let Some(key) = or_key.map(str::trim).filter(|key| !key.is_empty()) {
            cmd.env("LLM_API_KEY", key);
        }
        return;
    }
    if let Some(url) = inst.base_url.as_deref().map(str::trim).filter(|url| !url.is_empty()) {
        cmd.env("LLM_BASE_URL", url.trim_end_matches('/'));
    }
    if !inst.model.trim().is_empty() {
        cmd.env("LLM_MODEL", inst.model.trim());
    }
    if let Some(key) = inst.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        cmd.env("LLM_API_KEY", key);
    }
}

fn posix_arg(raw: &str) -> String {
    let text = raw.replace('\\', "/");
    if text.is_empty() || text.chars().any(|c| c.is_whitespace() || c == '\'') {
        format!("'{}'", text.replace('\'', "'\\''"))
    } else {
        text
    }
}

/// Harness splits this with posix `shlex`. Forward slashes, no backslash escapes.
fn approval_bridge_cmd(py: &PythonInv) -> String {
    let mut parts = vec![posix_arg(&py.program)];
    parts.extend(py.prefix.iter().map(|arg| posix_arg(arg)));
    parts.extend(
        ["-m", "agents_relay", "approve", "--local", "--timeout", "300"]
            .into_iter()
            .map(str::to_string),
    );
    parts.join(" ")
}

/// Desktop-spawned local Klanker defaults to ask. An exported off/strict/cmd wins.
fn apply_desktop_approval(cmd: &mut Command, py: &PythonInv, mode: &str, inherited_cmd: &str) {
    let mode = mode.trim().to_ascii_lowercase();
    if !(mode.is_empty() || mode == "ask") {
        return;
    }
    if mode.is_empty() {
        cmd.env("AGENTS_APPROVAL_MODE", "ask");
    }
    if inherited_cmd.trim().is_empty() {
        cmd.env("AGENTS_APPROVAL_CMD", approval_bridge_cmd(py));
    }
}

/// `start_cmd` instances spawn their declared argv instead of `klanker serve`.
/// The instance-root env contract still applies; `spec.env` wins on conflicts.
fn spawn_spec(inst: &KlankerInstance, root: &Path) -> Result<u32, String> {
    let spec = inst.start_cmd.as_ref().ok_or("start_cmd missing")?;
    let program = spec.argv.first().ok_or("start_cmd.argv is empty")?;
    let log_path = root.join("serve.log");
    let spawn_once = |flags: u32| -> std::io::Result<std::process::Child> {
        let log = OpenOptions::new().create(true).write(true).truncate(true).open(&log_path)?;
        let err = log.try_clone()?;
        let mut cmd = silent_command(program);
        cmd.args(&spec.argv[1..]);
        configure_child_env(&mut cmd, inst, root);
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        // Re-assert after `spec.env`: the boundary is the instance's decision.
        apply_workspace_env(&mut cmd, inst);
        cmd.current_dir(spec.cwd.as_deref().map(Path::new).unwrap_or(root));
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::from(log));
        cmd.stderr(Stdio::from(err));
        #[cfg(windows)]
        {
            cmd.creation_flags(flags);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let _ = flags;
            cmd.process_group(0);
        }
        cmd.spawn()
    };
    #[cfg(windows)]
    let child = match spawn_once(0x0800_0000 | 0x0000_0200 | 0x0100_0000) {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("failed to start {program}: {err}"));
        }
        Err(_) => spawn_once(0x0800_0000 | 0x0000_0200)
            .map_err(|err| format!("failed to start {program}: {err}"))?,
    };
    #[cfg(not(windows))]
    let child = spawn_once(0).map_err(|err| format!("failed to start {program}: {err}"))?;
    let pid = child.id();
    drop(child);
    Ok(pid)
}

fn spawn_serve(py: &PythonInv, inst: &KlankerInstance, root: &Path) -> Result<u32, String> {
    let log_path = root.join("serve.log");
    let loop_cmd = custom_loop_cmd(py, inst, root)?;
    let mut args = py.prefix.clone();
    args.extend([
        "-m".to_string(),
        "klanker".to_string(),
        "serve".to_string(),
        "--no-telegram".to_string(),
    ]);
    let spawn_once = |flags: u32| -> std::io::Result<std::process::Child> {
        let log = OpenOptions::new().create(true).write(true).truncate(true).open(&log_path)?;
        let err = log.try_clone()?;
        let mut cmd = silent_command(&py.program);
        cmd.args(&args);
        configure_child_env(&mut cmd, inst, root);
        apply_desktop_approval(
            &mut cmd,
            py,
            &std::env::var("AGENTS_APPROVAL_MODE").unwrap_or_default(),
            &std::env::var("AGENTS_APPROVAL_CMD").unwrap_or_default(),
        );
        if let Some(loop_cmd) = &loop_cmd {
            cmd.env("LOOP_CMD", loop_cmd);
        }
        cmd.current_dir(root);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::from(log));
        cmd.stderr(Stdio::from(err));
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, plus breakaway when asked.
            // DETACHED_PROCESS is omitted: Windows ignores CREATE_NO_WINDOW if it is set.
            // creation_flags replaces the CREATE_NO_WINDOW set by silent_command.
            cmd.creation_flags(flags);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let _ = flags;
            cmd.process_group(0);
        }
        cmd.spawn()
    };

    // Drop the Child. Do not wait and do not kill. The serve process is not owned by the window.
    #[cfg(windows)]
    let child = match spawn_once(0x0800_0000 | 0x0000_0200 | 0x0100_0000) {
        Ok(child) => child,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("failed to start {}: {err}", py.program));
        }
        Err(_) => spawn_once(0x0800_0000 | 0x0000_0200)
            .map_err(|err| format!("failed to start {}: {err}", py.program))?,
    };
    #[cfg(not(windows))]
    let child = spawn_once(0).map_err(|err| format!("failed to start {}: {err}", py.program))?;
    let pid = child.id();
    drop(child);
    Ok(pid)
}

async fn wait_health(inst: &KlankerInstance) -> bool {
    let Ok(origin) = relay_origin(inst) else {
        return false;
    };
    let secret = secret_value(inst).to_string();
    for _ in 0..16 {
        if health_ok(&origin, &secret).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

fn foreign_listener(status: &ProcessStatus) -> bool {
    status.state == "running" || status.state == "port_busy" || status.state == "not_owned"
}

fn turn_context(id: &str) -> (String, String, String) {
    match read_instance(id) {
        Ok(inst) => {
            let user = if inst.slug.is_empty() {
                id.to_string()
            } else {
                inst.slug
            };
            (inst.session, inst.user_id, user)
        }
        Err(_) => (String::new(), String::new(), id.to_string()),
    }
}

fn store_turn_identity(id: &str, session: &str, user_id: &str) {
    if session.is_empty() && user_id.is_empty() {
        return;
    }
    let Ok(mut inst) = read_instance(id) else {
        return;
    };
    if !session.is_empty() {
        inst.session = session.to_string();
    }
    if !user_id.is_empty() {
        inst.user_id = user_id.to_string();
    }
    inst.updated_at = chrono::Utc::now().to_rfc3339();
    let _ = write_instance(&inst);
}

fn policy_failure(json: &serde_json::Value) -> bool {
    if json.get("status").and_then(|v| v.as_str()) == Some("policy_failure") {
        return true;
    }
    if json.get("error").and_then(|v| v.as_str()) == Some("policy_failure") {
        return true;
    }
    match json.get("policy_failure") {
        Some(v) if v.as_bool() == Some(true) => true,
        Some(v) => v.as_str().map(|s| !s.is_empty()).unwrap_or(false),
        None => false,
    }
}

fn relay_turn_error(status: u16, json: &serde_json::Value, raw: &str) -> String {
    let reply = json.get("reply").and_then(|v| v.as_str()).unwrap_or("").trim();
    let mut msg = format!("relay HTTP {status}");
    if policy_failure(json) {
        msg.push_str(": policy_failure");
    } else if let Some(body_status) = json.get("status").and_then(|v| v.as_str()) {
        if !body_status.is_empty() {
            msg.push_str(": status ");
            msg.push_str(body_status);
        }
    }
    if let Some(rc) = json.get("returncode").and_then(|v| v.as_i64()) {
        msg.push_str(&format!(": returncode {rc}"));
    }
    if !reply.is_empty() {
        msg.push_str(": ");
        msg.push_str(reply);
    } else if json.is_null() {
        let snippet = raw.trim();
        if snippet.is_empty() {
            msg.push_str(": empty reply");
        } else {
            let end = snippet
                .char_indices()
                .nth(240)
                .map(|(i, _)| i)
                .unwrap_or(snippet.len());
            msg.push_str(": ");
            msg.push_str(&snippet[..end]);
        }
    } else {
        msg.push_str(": empty reply");
    }
    msg
}

struct StreamAccum {
    reply: String,
    session: String,
    user_id: String,
    returncode: i64,
    trailer: bool,
}

fn drain_sse_events(buf: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut events = Vec::new();
    while let Some(pos) = buf.windows(2).position(|pair| pair == b"\n\n") {
        events.push(buf.drain(..pos + 2).collect());
    }
    events
}

fn sse_data(event: &[u8]) -> String {
    let text = String::from_utf8_lossy(event);
    let mut data = String::new();
    for line in text.split(['\n', '\r']) {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
    }
    data
}

/// `Some(text)` is a delta to paint. Trailer updates `acc` and returns `None`.
fn apply_sse_payload(acc: &mut StreamAccum, payload: &str) -> Result<Option<String>, String> {
    let json: serde_json::Value = serde_json::from_str(payload)
        .map_err(|_| format!("stream event is not json: {payload}"))?;
    if policy_failure(&json) {
        return Err(relay_turn_error(200, &json, payload));
    }
    match json.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "delta" => {
            let text = json.get("text").and_then(|v| v.as_str()).unwrap_or("");
            acc.reply.push_str(text);
            if text.is_empty() {
                Ok(None)
            } else {
                Ok(Some(text.to_string()))
            }
        }
        "error" => {
            let detail = json
                .get("text")
                .or_else(|| json.get("message"))
                .or_else(|| json.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or(payload);
            Err(format!("stream error: {detail}"))
        }
        "trailer" => {
            acc.trailer = true;
            acc.session = json
                .get("session")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            acc.user_id = json
                .get("user_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            acc.returncode = json.get("returncode").and_then(|v| v.as_i64()).unwrap_or(0);
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn stream_failure(acc: &StreamAccum) -> Option<String> {
    if !acc.trailer {
        return Some("stream ended without trailer".into());
    }
    if acc.returncode != 0 {
        let reply = acc.reply.trim();
        if reply.is_empty() {
            return Some(format!("relay returncode {}", acc.returncode));
        }
        return Some(format!("relay returncode {}: {reply}", acc.returncode));
    }
    if acc.reply.trim().is_empty() {
        return Some("relay HTTP 200: empty reply".into());
    }
    None
}

#[tauri::command]
pub fn load_settings() -> DesktopSettings {
    let mut settings = read_settings();
    let file_has = !settings.openrouter_api_key.is_empty();
    settings.openrouter_api_key.clear();
    settings.openrouter_key_set = file_has || crate::secrets::present(crate::secrets::OPENROUTER);
    settings
}

#[tauri::command]
pub fn save_settings(settings: DesktopSettings) -> Result<DesktopSettings, String> {
    let incoming = settings.openrouter_api_key.trim().to_string();
    let previous = read_settings();
    let settings = sanitize_settings(settings);
    if !incoming.is_empty() {
        crate::secrets::set(crate::secrets::OPENROUTER, &incoming)?;
    } else if !crate::secrets::present(crate::secrets::OPENROUTER) && !previous.openrouter_api_key.is_empty() {
        crate::secrets::set(crate::secrets::OPENROUTER, &previous.openrouter_api_key)?;
    }
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let disk = settings_for_disk(settings);
    let json = serde_json::to_string_pretty(&disk).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("failed to save settings: {e}"))?;
    Ok(load_settings())
}

#[tauri::command]
pub fn list_klankers() -> Result<Vec<KlankerInstance>, String> {
    let dir = get_instances_dir()?;
    let mut instances = Vec::new();

    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(instance) = serde_json::from_str::<KlankerInstance>(&content) {
                    instances.push(for_ui(instance));
                }
            }
        }
    }

    if instances.is_empty() && !get_instances_dir()?.join("default.json").exists() {
        let default_inst = KlankerInstance {
            id: "default".to_string(),
            name: "Default Klanker".to_string(),
            slug: "default".to_string(),
            role: String::new(),
            provider: String::new(),
            model: String::new(),
            base_url: None,
            api_key: None,
            workspace: String::new(),
            lock_workspace: true,
            port: 0,
            system_prompt: String::new(),
            sensors: HashMap::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            session: String::new(),
            user_id: String::new(),
            kind: InstanceKind::Local,
            endpoint: None,
            start_cmd: None,
            tailscale: None,
            secret: None,
            has_secret: false,
            pid: None,
        };
        if let Ok(saved) = save_klanker(default_inst) {
            instances.push(saved);
        }
    }

    Ok(instances)
}

#[tauri::command]
pub fn save_klanker(mut instance: KlankerInstance) -> Result<KlankerInstance, String> {
    if instance.id.is_empty() {
        instance.id = uuid::Uuid::new_v4().to_string();
    }
    if instance.slug.is_empty() {
        instance.slug = instance.name.to_lowercase().replace(' ', "-");
    }
    instance.role = instance.role.trim().to_string();
    instance.workspace = instance.workspace.trim().to_string();
    instance.system_prompt = instance.system_prompt.trim().to_string();
    instance.updated_at = chrono::Utc::now().to_rfc3339();
    if instance.created_at.is_empty() {
        instance.created_at = instance.updated_at.clone();
    }

    let prev = read_instance(&instance.id).ok();
    let previous_secret = prev
        .as_ref()
        .and_then(|item| {
            item.secret
                .clone()
                .or_else(|| item.endpoint.as_ref().and_then(|e| e.secret.clone()))
        })
        .unwrap_or_default();
    if instance.kind != InstanceKind::Remote {
        instance.kind = InstanceKind::Local;
        normalize_local_model(&mut instance);
        instance.port = match kept_local_port(prev.as_ref().map(|item| item.port)) {
            Some(port) => port,
            None => allocate_port(&instance.id),
        };
        if prev.is_none() && instance.workspace.is_empty() {
            instance.workspace = read_settings().workspace;
        }
    } else {
        let ep_secret = instance
            .endpoint
            .as_ref()
            .and_then(|e| e.secret.clone());
        let raw = instance
            .endpoint
            .as_ref()
            .map(|e| e.base_url.clone())
            .or_else(|| instance.base_url.clone())
            .unwrap_or_default();
        instance.endpoint = Some(InstanceEndpoint {
            base_url: remote_origin(&raw)?,
            secret: ep_secret,
        });
        instance.base_url = None;
        if let Some(item) = prev.as_ref() {
            instance.port = item.port;
        }
    }
    if let Some(prev) = prev {
        instance.session = prev.session;
        instance.user_id = prev.user_id;
        instance.pid = prev.pid;
    }
    let incoming_secret = instance
        .secret
        .clone()
        .or_else(|| instance.endpoint.as_ref().and_then(|e| e.secret.clone()))
        .unwrap_or_default();
    store_relay_secret(&instance.id, &incoming_secret, &previous_secret)?;
    let instance = without_secrets(instance);

    write_instance(&instance)?;
    Ok(for_ui(instance))
}

#[tauri::command]
pub fn delete_klanker(id: String) -> Result<(), String> {
    crate::secrets::delete(&crate::secrets::relay_account(&id));
    let dir = get_instances_dir()?;
    let file_path = dir.join(format!("{}.json", id));
    if file_path.exists() {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[tauri::command]
pub async fn get_gateway_status(
    instance_id: String,
    port: u16,
    state: State<'_, AppState>,
) -> Result<ProcessStatus, String> {
    let inst = match read_instance(&instance_id) {
        Ok(inst) => inst,
        Err(_) => {
            let origin = format!("http://127.0.0.1:{port}");
            let health = health_ok(&origin, "").await;
            let open = local_port_open(port);
            let state_name = if health {
                "not_owned"
            } else if open {
                "port_busy"
            } else {
                "stopped"
            };
            return Ok(ProcessStatus {
                is_running: health,
                pid: None,
                port,
                last_ping: Some(chrono::Utc::now().to_rfc3339()),
                state: state_name.to_string(),
                detail: if health {
                    "relay is up but this app did not start it".into()
                } else if open {
                    format!("port {port} is in use by a process this app did not start")
                } else {
                    String::new()
                },
            });
        }
    };
    let status = probe_instance(&inst).await?;
    remember(&state, &instance_id, status.pid);
    if load_pid(&inst).is_some() && status.pid.is_none() {
        let mut inst = inst;
        store_pid(&mut inst, None)?;
    }
    Ok(status)
}

#[tauri::command]
pub async fn instance_start(id: String, state: State<'_, AppState>) -> Result<ProcessStatus, String> {
    check_id(&id)?;
    let mut inst = read_instance(&id)?;
    if is_remote(&inst) {
        return Err("remote instances are not started by this app".into());
    }
    let owned = load_pid(&inst).filter(|pid| pid_alive(*pid));
    if owned.is_some() {
        remember(&state, &id, owned);
        let mut status = probe_instance(&inst).await?;
        status.pid = owned;
        return Ok(status);
    }
    let current = probe_instance(&inst).await?;
    if foreign_listener(&current) || local_port_open(inst.port) {
        return Err(if current.detail.is_empty() {
            format!("port {} is in use by a process this app did not start", inst.port)
        } else {
            current.detail
        });
    }
    if inst.pid.is_some() || pid_path(&id)?.exists() {
        store_pid(&mut inst, None)?;
    }
    let root = prepare_root(&id)?;
    let pid = if inst.start_cmd.is_some() {
        spawn_spec(&inst, &root)?
    } else {
        let py = resolve_python()?;
        spawn_serve(&py, &inst, &root)?
    };
    store_pid(&mut inst, Some(pid))?;
    remember(&state, &id, Some(pid));
    let up = wait_health(&inst).await;
    if !up && !pid_alive(pid) {
        store_pid(&mut inst, None)?;
        remember(&state, &id, None);
        let tail = log_tail(&root, &inst);
        return Err(if tail.is_empty() {
            format!("serve exited before health (pid {pid})")
        } else {
            format!("serve exited before health (pid {pid}): {tail}")
        });
    }
    let inst = read_instance(&id)?;
    let mut status = probe_instance(&inst).await?;
    if !status.is_running && pid_alive(pid) {
        status.pid = Some(pid);
        status.detail = format!("pid {pid} started, health not up yet");
    }
    Ok(status)
}

#[tauri::command]
pub async fn instance_stop(id: String, state: State<'_, AppState>) -> Result<ProcessStatus, String> {
    check_id(&id)?;
    let mut inst = read_instance(&id)?;
    if is_remote(&inst) {
        return Err("remote instance is not owned by this app".into());
    }
    let Some(pid) = load_pid(&inst) else {
        let status = probe_instance(&inst).await?;
        if foreign_listener(&status) {
            return Err(if status.detail.is_empty() {
                "relay is up but this app did not start it".into()
            } else {
                status.detail
            });
        }
        return Ok(status);
    };
    if !pid_alive(pid) {
        store_pid(&mut inst, None)?;
        remember(&state, &id, None);
        let status = probe_instance(&read_instance(&id)?).await?;
        if foreign_listener(&status) {
            return Err(if status.detail.is_empty() {
                "relay is up but this app did not start it".into()
            } else {
                status.detail
            });
        }
        return Ok(status);
    }
    is_our_process(pid, &inst)?;
    kill_tree(pid)?;
    for _ in 0..20 {
        if !pid_alive(pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if pid_alive(pid) {
        return Err(format!("pid {pid} still alive after stop"));
    }
    store_pid(&mut inst, None)?;
    remember(&state, &id, None);
    probe_instance(&read_instance(&id)?).await
}

struct PostedTurn {
    reply: String,
    session: String,
    user_id: String,
}

/// Empty pin keeps the instance session. A non-empty pin is that chat's thread.
fn pinned_session(stored: &str, pin: Option<&str>) -> String {
    match pin.map(str::trim).filter(|value| !value.is_empty()) {
        Some(pin) => pin.to_string(),
        None => stored.to_string(),
    }
}

/// Side chats must not overwrite the instance session.
fn persist_pinned_session(stored: &str, pin: Option<&str>) -> bool {
    match pin.map(str::trim).filter(|value| !value.is_empty()) {
        Some(pin) => pin == stored,
        None => true,
    }
}

async fn post_stream(
    inst: &KlankerInstance,
    message: &str,
    session_pin: Option<&str>,
    mut paint: impl FnMut(String),
) -> Result<PostedTurn, String> {
    let (stored, user_id, user) = turn_context(&inst.id);
    let session = pinned_session(&stored, session_pin);
    let origin = relay_origin(inst)?;
    let secret = secret_value(inst).to_string();
    let client = http_client(Duration::from_secs(120))?;
    let url = format!("{origin}/v1/stream");
    let payload = serde_json::json!({
        "text": message,
        "channel": "http",
        "user": user,
        "session": session,
        "user_id": user_id,
    });
    let req = with_secret(client.post(&url).json(&payload), &secret)?;
    let mut resp = req
        .send()
        .await
        .map_err(|e| format!("relay unreachable at {url}: {e}"))?;

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let raw = resp.text().await.unwrap_or_default();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
        return Err(relay_turn_error(status, &json, &raw));
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut acc = StreamAccum {
        reply: String::new(),
        session: String::new(),
        user_id: String::new(),
        returncode: 0,
        trailer: false,
    };
    loop {
        let chunk = resp
            .chunk()
            .await
            .map_err(|e| format!("stream read failed: {e}"))?;
        let Some(chunk) = chunk else {
            break;
        };
        buf.extend_from_slice(&chunk);
        for event in drain_sse_events(&mut buf) {
            let payload = sse_data(&event);
            if payload.is_empty() {
                continue;
            }
            if let Some(text) = apply_sse_payload(&mut acc, &payload)? {
                paint(text);
            }
        }
    }
    if !buf.is_empty() {
        let payload = sse_data(&buf);
        if !payload.is_empty() {
            if let Some(text) = apply_sse_payload(&mut acc, &payload)? {
                paint(text);
            }
        }
    }
    if let Some(err) = stream_failure(&acc) {
        return Err(err);
    }
    Ok(PostedTurn {
        reply: acc.reply.trim().to_string(),
        session: acc.session,
        user_id: acc.user_id,
    })
}

#[tauri::command]
pub async fn execute_turn(
    app: tauri::AppHandle,
    instance_id: String,
    port: u16,
    message: String,
    session: Option<String>,
) -> Result<TurnResponse, String> {
    let _ = port;
    let start = Instant::now();
    let inst = read_instance(&instance_id)?;
    let (stored, _, _) = turn_context(&instance_id);
    let pin = session.as_deref();
    let posted = post_stream(&inst, &message, pin, |text| {
        let _ = app.emit(
            "turn-delta",
            serde_json::json!({ "instanceId": &instance_id, "text": text }),
        );
    })
    .await?;
    if persist_pinned_session(&stored, pin) {
        store_turn_identity(&instance_id, &posted.session, &posted.user_id);
    }
    Ok(TurnResponse {
        reply: posted.reply,
        session: posted.session,
        user_id: posted.user_id,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn read_trace_lines(traces_dir: &Path, limit: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let Ok(entries) = fs::read_dir(traces_dir) else {
        return lines;
    };
    let mut files: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    files.sort();
    files.reverse();
    for file in files.iter().take(3) {
        if !file.is_file() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(file) {
            for line in content.lines().rev().take(limit) {
                if !line.trim().is_empty() {
                    lines.push(line.to_string());
                }
            }
        }
    }
    lines
}

#[tauri::command]
pub fn read_recent_traces(instance_id: String, limit: usize) -> Result<TracePage, String> {
    let inst = read_instance(&instance_id).map_err(|_| "Instance not found.".to_string())?;
    if is_remote(&inst) {
        return Ok(TracePage {
            lines: Vec::new(),
            note: "Remote instance. Traces stay on that machine.".into(),
        });
    }
    let traces_dir = instance_root(&inst.id)?.join("traces");
    if !traces_dir.is_dir() {
        return Ok(TracePage {
            lines: Vec::new(),
            note: "No local trace directory for this instance.".into(),
        });
    }
    let lines = read_trace_lines(&traces_dir, limit);
    if lines.is_empty() {
        return Ok(TracePage {
            lines,
            note: "No traces yet for this instance.".into(),
        });
    }
    Ok(TracePage {
        lines,
        note: String::new(),
    })
}

fn approval_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn read_pending_approval(dir: &Path) -> Option<PendingApproval> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(f64, PendingApproval)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if value.get("status").and_then(|item| item.as_str()) != Some("pending") {
            continue;
        }
        let Some(id) = value.get("id").and_then(|item| item.as_str()) else {
            continue;
        };
        if !approval_id_ok(id) {
            continue;
        }
        let request = value.get("request");
        let tool = request
            .and_then(|item| item.get("tool"))
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        let summary = request
            .and_then(|item| item.get("summary"))
            .and_then(|item| item.as_str())
            .unwrap_or("")
            .trim();
        let summary = if summary.is_empty() { tool } else { summary };
        let created = value.get("created_at").and_then(|item| item.as_f64()).unwrap_or(0.0);
        let item = PendingApproval {
            id: id.to_string(),
            tool: tool.to_string(),
            summary: summary.to_string(),
        };
        let replace = match &best {
            Some((stamp, _)) => created < *stamp,
            None => true,
        };
        if replace {
            best = Some((created, item));
        }
    }
    best.map(|(_, item)| item)
}

/// Peer-discovery enumerator #1. Tailnet has no broadcast domain —
/// `tailscale status --json` IS the peer list (challenges entry).
/// Missing/broken tailscale yields no peers, never an error.
const DISCOVERY_PORTS: &[u16] = &[8787, 8000];

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
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
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
        // Online=false is tailscale's last-contact guess, not liveness — the probe decides.
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

/// `{"ok":true}` is the audited relay health contract (docs/wire-contract.md §2).
/// A port that answers differently is a service, not a klanker relay.
async fn probe_relay_health(ip: &str, port: u16) -> Option<String> {
    let url = format!("http://{ip}:{port}/health");
    let client = http_client(Duration::from_millis(1200)).ok()?;
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    (json.get("ok").and_then(|v| v.as_bool()) == Some(true))
        .then(|| format!("http://{ip}:{port}"))
}

#[tauri::command]
pub async fn discover_peers() -> Result<Vec<DiscoveredPeer>, String> {
    let mut found = Vec::new();
    for (hostname, ip, fqdn) in tailscale_peers() {
        for &port in DISCOVERY_PORTS {
            if let Some(endpoint) = probe_relay_health(&ip, port).await {
                found.push(DiscoveredPeer {
                    hostname: hostname.clone(),
                    ip: ip.clone(),
                    fqdn: fqdn.clone(),
                    endpoint,
                });
            }
        }
    }
    Ok(found)
}

/// Presence-offer enumerator (challenges/presence-offers): reads the shared
/// registry — every file becomes one row, invalid offers report their reason.
#[tauri::command]
pub fn list_presence_offers(registry: Option<String>) -> Result<Vec<PresenceOffer>, String> {
    let dir = registry
        .map(PathBuf::from)
        .unwrap_or_else(presence::default_registry);
    presence::scan_registry(&dir)
}

/// Publish a signed road declaration for this box into the registry.
/// Signing goes through `python -m agents_keys`; the doc self-verifies before write.
#[tauri::command]
pub fn publish_presence_offer(
    key_slug: String,
    label: String,
    addr: String,
    kind: String,
    registry: Option<String>,
) -> Result<PresenceOffer, String> {
    if key_slug.trim().is_empty() || addr.trim().is_empty() {
        return Err("key_slug and addr are required".into());
    }
    let dir = registry
        .map(PathBuf::from)
        .unwrap_or_else(presence::default_registry);
    let python = resolve_agents_keys()?;
    presence::publish_offer(&dir, &python, &key_slug, &label, &kind, &addr)
}

#[tauri::command]
pub fn pending_approval(instance_id: String) -> Result<Option<PendingApproval>, String> {
    check_id(&instance_id)?;
    let inst = read_instance(&instance_id)?;
    if is_remote(&inst) {
        return Ok(None);
    }
    let dir = instance_root(&instance_id)?.join("relay").join("approvals");
    Ok(read_pending_approval(&dir))
}

fn run_approve_cli(instance_id: &str, approval_id: &str, allow: bool) -> Result<(), String> {
    let py = resolve_python()?;
    let state = instance_root(instance_id)?.join("relay");
    let mut cmd = silent_command(&py.program);
    cmd.args(&py.prefix);
    cmd.args(["-m", "agents_relay", "approve", "--decide", approval_id]);
    cmd.arg(if allow { "--allow" } else { "--deny" });
    cmd.env("AGENTS_RELAY_STATE", &state);
    cmd.env("AGENTS_NO_UPDATE_CHECK", "1");
    cmd.stdin(Stdio::null());
    let out = cmd.output().map_err(|err| format!("failed to decide approval: {err}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err_text = String::from_utf8_lossy(&out.stderr);
    let out_text = String::from_utf8_lossy(&out.stdout);
    let detail = if err_text.trim().is_empty() {
        out_text.trim()
    } else {
        err_text.trim()
    };
    if detail.contains("not pending") {
        return Ok(());
    }
    Err(if detail.is_empty() {
        format!("approve exited {}", out.status)
    } else {
        detail.to_string()
    })
}

#[tauri::command]
pub async fn resolve_approval(instance_id: String, approval_id: String, allow: bool) -> Result<(), String> {
    check_id(&instance_id)?;
    if !approval_id_ok(&approval_id) {
        return Err("invalid approval id".into());
    }
    let source = read_instance(&instance_id)?;
    if is_remote(&source) {
        return Err("remote instance has no local approval file".into());
    }
    tokio::task::spawn_blocking(move || run_approve_cli(&instance_id, &approval_id, allow))
        .await
        .map_err(|err| format!("failed to decide approval: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        apply_desktop_approval, apply_provider_env_with, apply_sse_payload, apply_workspace_env,
        approval_bridge_cmd, command_matches, configure_child_env, drain_sse_events,
        instance_root_in, loopback_llm_url, normalize_local_model, read_pending_approval,
        relay_origin, remote_origin, sse_data, status_of, stream_failure, PythonInv, StreamAccum,
        KlankerInstance,
    };
    use crate::models::{InstanceKind, InstanceStartSpec};
    use std::collections::HashMap;
    use std::ffi::OsStr;
    use std::path::Path;
    use std::process::Command;

    fn inst(provider: &str, base_url: Option<&str>, kind: &str) -> KlankerInstance {
        KlankerInstance {
            id: "box".into(),
            name: "box".into(),
            slug: "box".into(),
            role: String::new(),
            provider: provider.into(),
            model: "demo-model".into(),
            base_url: base_url.map(str::to_string),
            api_key: None,
            workspace: String::new(),
            lock_workspace: true,
            port: 8787,
            system_prompt: String::new(),
            sensors: HashMap::new(),
            created_at: String::new(),
            updated_at: String::new(),
            session: String::new(),
            user_id: String::new(),
            kind: if kind == "remote" {
                InstanceKind::Remote
            } else {
                InstanceKind::Local
            },
            endpoint: None,
            start_cmd: None,
            tailscale: None,
            secret: None,
            has_secret: false,
            pid: None,
        }
    }

    fn env_of(instance: &KlankerInstance, key: &str) -> Option<String> {
        let mut cmd = Command::new("python");
        configure_child_env(&mut cmd, instance, Path::new("root"));
        cmd.get_envs().find(|(k, _)| *k == OsStr::new(key)).and_then(|(_, v)| {
            v.map(|s| s.to_string_lossy().into_owned())
        })
    }

    fn cleared(instance: &KlankerInstance, key: &str) -> bool {
        let mut cmd = Command::new("python");
        configure_child_env(&mut cmd, instance, Path::new("root"));
        cmd.get_envs()
            .any(|(k, v)| k == OsStr::new(key) && v.is_none())
    }

    #[test]
    fn lmstudio_loopback_uses_openai_default() {
        let instance = inst(
            "lmstudio.local",
            Some("http://127.0.0.1:1234/v1"),
            "local",
        );
        assert_eq!(env_of(&instance, "LOOP_PROVIDER").as_deref(), Some("openai.default"));
        assert_eq!(
            env_of(&instance, "LLM_BASE_URL").as_deref(),
            Some("http://127.0.0.1:1234/v1")
        );
        assert_eq!(env_of(&instance, "LLM_MODEL").as_deref(), Some("demo-model"));
        assert_ne!(env_of(&instance, "LOOP_PROVIDER").as_deref(), Some("lmstudio.local"));
    }

    #[test]
    fn echo_and_empty_do_not_call_a_model() {
        let echo = inst("echo", Some("http://127.0.0.1:1234/v1"), "local");
        assert_eq!(env_of(&echo, "LOOP_PROVIDER").as_deref(), Some("echo"));
        assert_eq!(env_of(&echo, "LLM_BASE_URL"), None);
        assert_eq!(env_of(&echo, "LLM_MODEL"), None);

        let empty = inst("", Some("http://127.0.0.1:1234/v1"), "local");
        assert_eq!(env_of(&empty, "LOOP_PROVIDER"), None);
        assert_eq!(env_of(&empty, "LLM_BASE_URL"), None);
        assert!(cleared(&empty, "LOOP_PROVIDER"));
        assert!(cleared(&empty, "LLM_BASE_URL"));
        assert!(loopback_llm_url("http://localhost:11434/v1"));
        assert!(loopback_llm_url("http://[::1]:1234/v1"));
        assert!(!loopback_llm_url("http://10.0.0.8:1234/v1"));
    }

    #[test]
    fn old_instance_json_loads_without_role() {
        let bare = r#"{"id":"a","name":"A","slug":"a"}"#;
        let inst: KlankerInstance = serde_json::from_str(bare).unwrap();
        assert_eq!(inst.role, "");
        assert_eq!(inst.provider, "");
        assert_eq!(inst.model, "");
        assert_eq!(inst.kind, InstanceKind::Local);
        assert_eq!(inst.port, 8787);
        assert!(inst.sensors.is_empty());
        assert!(inst.system_prompt.is_empty());

        let kept = r#"{"id":"a","name":"A","slug":"a","role":"kept","provider":"lmstudio.local","sensors":{"memory":true}}"#;
        let inst: KlankerInstance = serde_json::from_str(kept).unwrap();
        assert_eq!(inst.role, "kept");
        assert_eq!(inst.sensors.get("memory"), Some(&true));
    }

    #[test]
    fn empty_url_does_not_export_loop_provider() {
        let mut echo = inst("echo", None, "local");
        normalize_local_model(&mut echo);
        assert_eq!(echo.provider, "echo");
        assert!(echo.base_url.is_none());
        assert_eq!(env_of(&echo, "LOOP_PROVIDER").as_deref(), Some("echo"));
        assert_eq!(env_of(&echo, "LLM_BASE_URL"), None);
        assert_eq!(env_of(&echo, "LLM_MODEL"), None);
        assert_eq!(env_of(&echo, "LLM_API_KEY"), None);

        let mut named = inst("lmstudio.local", None, "local");
        normalize_local_model(&mut named);
        assert_eq!(named.provider, "lmstudio.local");
        assert_eq!(env_of(&named, "LOOP_PROVIDER"), None);

        let mut bare = inst("", Some("http://127.0.0.1:1234/v1"), "local");
        normalize_local_model(&mut bare);
        assert_eq!(bare.provider, "openai.default");
        assert_eq!(env_of(&bare, "LOOP_PROVIDER").as_deref(), Some("openai.default"));
        assert_eq!(
            env_of(&bare, "LLM_BASE_URL").as_deref(),
            Some("http://127.0.0.1:1234/v1")
        );
    }

    #[test]
    fn remote_and_paid_urls_are_not_a_loop_provider() {
        let paid = inst("openai.default", Some("https://api.openai.com/v1"), "local");
        assert_eq!(env_of(&paid, "LOOP_PROVIDER"), None);
        assert_eq!(env_of(&paid, "LLM_BASE_URL"), None);

        let anthropic = inst("anthropic.default", Some("https://api.anthropic.com"), "local");
        assert_eq!(env_of(&anthropic, "LOOP_PROVIDER"), None);

        let bare = inst("lmstudio.local", None, "local");
        assert_eq!(env_of(&bare, "LOOP_PROVIDER"), None);
    }

    #[test]
    fn openrouter_uses_openai_default() {
        let or_inst = inst("openrouter", Some("https://openrouter.ai/api/v1"), "local");
        assert_eq!(env_of(&or_inst, "LOOP_PROVIDER").as_deref(), Some("openai.default"));
        assert_eq!(
            env_of(&or_inst, "LLM_BASE_URL").as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(env_of(&or_inst, "LLM_MODEL").as_deref(), Some("demo-model"));
        assert_eq!(env_of(&or_inst, "LLM_API_KEY"), None);
        assert!(cleared(&or_inst, "TELEGRAM_BOT_TOKEN"));
        assert!(cleared(&or_inst, "GITHUB_TOKEN"));
        assert!(cleared(&or_inst, "RELAY_SECRET"));
        assert!(cleared(&or_inst, "GATEWAY_SECRET"));
        assert!(cleared(&or_inst, "LOOP_CMD"));

        let shaped = inst("openai.default", Some("https://openrouter.ai/api/v1/chat"), "local");
        assert_eq!(env_of(&shaped, "LOOP_PROVIDER").as_deref(), Some("openai.default"));
        assert_eq!(
            env_of(&shaped, "LLM_BASE_URL").as_deref(),
            Some("https://openrouter.ai/api/v1")
        );

        let mut cmd = Command::new("python");
        apply_provider_env_with(&mut cmd, &or_inst, Some("k"));
        let key = cmd
            .get_envs()
            .find(|(name, _)| *name == OsStr::new("LLM_API_KEY"))
            .and_then(|(_, value)| value.map(|text| text.to_string_lossy().into_owned()));
        assert_eq!(key.as_deref(), Some("k"));
    }

    #[test]
    fn remote_down_is_stopped_and_origin_drops_the_path() {
        let remote = inst("lmstudio.local", Some("https://down.example/v1/turn"), "remote");
        let status = status_of(&remote, false, false, None, false);
        assert_eq!(status.state, "stopped");
        assert!(!status.is_running);
        assert_eq!(
            remote_origin("https://down.example/v1/turn").unwrap(),
            "https://down.example"
        );
        assert_eq!(relay_origin(&remote).unwrap(), "https://down.example");
        let up = status_of(&remote, true, true, None, false);
        assert_eq!(up.state, "running");
    }

    #[test]
    fn traces_path_stays_under_the_instance_root() {
        let root = instance_root_in(Path::new(r"C:\home\.klanker\instances"), "box").unwrap();
        let traces = root.join("traces");
        let text = traces.to_string_lossy().replace('\\', "/");
        assert_eq!(text, "C:/home/.klanker/instances/box/root/traces");
        assert!(!text.contains(".agents"));
        assert!(instance_root_in(Path::new(r"C:\home\.klanker\instances"), "../x").is_err());
    }

    #[test]
    fn side_chat_keeps_the_instance_session() {
        assert_eq!(super::pinned_session("ses_old", None), "ses_old");
        assert_eq!(super::pinned_session("ses_old", Some("")), "ses_old");
        assert_eq!(super::pinned_session("ses_old", Some("ses_old")), "ses_old");
        assert_eq!(super::pinned_session("ses_old", Some("ses_new")), "ses_new");
        assert!(super::persist_pinned_session("ses_old", None));
        assert!(super::persist_pinned_session("ses_old", Some("ses_old")));
        assert!(!super::persist_pinned_session("ses_old", Some("ses_new")));
    }

    #[test]
    fn sse_delta_then_trailer_and_bad_returncode() {
        let raw = concat!(
            "data: {\"type\":\"delta\",\"text\":\"amber-stream-1\"}\n\n",
            "data: {\"type\":\"trailer\",\"session\":\"ses_a\",\"user_id\":\"u_b\",\"alias\":\"http:box\",\"returncode\":0}\n\n"
        );
        let mut buf = raw.as_bytes().to_vec();
        let events = drain_sse_events(&mut buf);
        assert!(buf.is_empty());
        assert_eq!(events.len(), 2);
        let mut acc = StreamAccum {
            reply: String::new(),
            session: String::new(),
            user_id: String::new(),
            returncode: 0,
            trailer: false,
        };
        let delta = apply_sse_payload(&mut acc, &sse_data(&events[0])).unwrap();
        assert_eq!(delta.as_deref(), Some("amber-stream-1"));
        assert!(apply_sse_payload(&mut acc, &sse_data(&events[1])).unwrap().is_none());
        assert!(stream_failure(&acc).is_none());
        assert_eq!(acc.session, "ses_a");
        assert_eq!(acc.user_id, "u_b");
        acc.returncode = 1;
        assert_eq!(
            stream_failure(&acc).as_deref(),
            Some("relay returncode 1: amber-stream-1")
        );
        let err = apply_sse_payload(&mut acc, r#"{"type":"error","text":"nope"}"#);
        assert_eq!(err.unwrap_err(), "stream error: nope");
    }

    #[test]
    fn old_settings_json_loads_without_favorites() {
        let raw = r#"{"provider":"echo","model":"leftover"}"#;
        let settings: crate::models::DesktopSettings = serde_json::from_str(raw).unwrap();
        assert!(settings.favorites.openrouter.is_empty());
        assert!(settings.favorites.lmstudio.is_empty());
        assert!(settings.recent_models.openrouter.is_empty());
        let clean = super::sanitize_settings(settings);
        assert!(clean.favorites.openrouter.is_empty());
    }

    #[test]
    fn favorites_and_recent_are_model_ids_per_provider() {
        let raw = r#"{
            "provider":"openrouter",
            "recent_models":["orphan","also"],
            "favorites":[
                {"provider":"echo","model":""},
                {"provider":"echo","model":"ignored"},
                {"provider":"openrouter","model":" openai/gpt-4o "},
                {"provider":"openrouter","model":""},
                {"provider":"lmstudio.local","model":"qwen"},
                {"provider":"nope","model":"x"}
            ]
        }"#;
        let settings: crate::models::DesktopSettings = serde_json::from_str(raw).unwrap();
        let clean = super::sanitize_settings(settings);
        assert!(clean.recent_models.openrouter.is_empty());
        assert!(clean.recent_models.lmstudio.is_empty());
        assert_eq!(clean.favorites.openrouter, vec!["openai/gpt-4o".to_string()]);
        assert_eq!(clean.favorites.lmstudio, vec!["qwen".to_string()]);

        let ranked = r#"{"recent_models":{"openrouter":["a","b","a"," c ","","d","e","f","g","h","i"],"lmstudio":["x"]},"favorites":{"openrouter":["m"],"lmstudio":[]}}"#;
        let again: crate::models::DesktopSettings = serde_json::from_str(ranked).unwrap();
        let clean = super::sanitize_settings(again);
        assert_eq!(
            clean.recent_models.openrouter,
            vec!["a", "b", "c", "d", "e", "f", "g", "h"]
        );
        assert_eq!(clean.recent_models.lmstudio, vec!["x".to_string()]);
        assert_eq!(clean.favorites.openrouter, vec!["m".to_string()]);
    }

    fn cmd_env(cmd: &Command, key: &str) -> Option<String> {
        cmd.get_envs().find(|(name, _)| *name == OsStr::new(key)).and_then(|(_, value)| {
            value.map(|text| text.to_string_lossy().into_owned())
        })
    }

    #[test]
    fn desktop_spawn_defaults_ask_local_bridge() {
        let py = PythonInv {
            program: r"C:\Py\python.exe".into(),
            prefix: vec!["-3".into()],
        };
        let mut cmd = Command::new("python");
        apply_desktop_approval(&mut cmd, &py, "", "");
        assert_eq!(cmd_env(&cmd, "AGENTS_APPROVAL_MODE").as_deref(), Some("ask"));
        let bridge = cmd_env(&cmd, "AGENTS_APPROVAL_CMD").unwrap();
        assert_eq!(
            bridge,
            "C:/Py/python.exe -3 -m agents_relay approve --local --timeout 300"
        );
        assert!(!bridge.contains('\\'));
        assert_eq!(approval_bridge_cmd(&py), bridge);

        let mut off = Command::new("python");
        apply_desktop_approval(&mut off, &py, "off", "");
        assert_eq!(cmd_env(&off, "AGENTS_APPROVAL_MODE"), None);
        assert_eq!(cmd_env(&off, "AGENTS_APPROVAL_CMD"), None);

        let mut strict = Command::new("python");
        apply_desktop_approval(&mut strict, &py, "strict", "");
        assert_eq!(cmd_env(&strict, "AGENTS_APPROVAL_MODE"), None);
        assert_eq!(cmd_env(&strict, "AGENTS_APPROVAL_CMD"), None);

        let mut custom = Command::new("python");
        apply_desktop_approval(
            &mut custom,
            &py,
            "ask",
            "agents-relay approve --user {user} --timeout 300",
        );
        assert_eq!(cmd_env(&custom, "AGENTS_APPROVAL_MODE"), None);
        assert_eq!(cmd_env(&custom, "AGENTS_APPROVAL_CMD"), None);
    }

    #[test]
    fn workspace_lock_follows_the_instance_switch() {
        let mut instance = inst("echo", None, "local");
        instance.workspace = r"C:\work".into();
        assert_eq!(env_of(&instance, "AGENTS_WORKSPACE_DIR").as_deref(), Some(r"C:\work"));
        assert_eq!(env_of(&instance, "AGENTS_WORKSPACE_LOCK").as_deref(), Some("1"));

        instance.lock_workspace = false;
        assert_eq!(env_of(&instance, "AGENTS_WORKSPACE_DIR").as_deref(), Some(r"C:\work"));
        assert_eq!(env_of(&instance, "AGENTS_WORKSPACE_LOCK"), None);

        instance.workspace.clear();
        assert_eq!(env_of(&instance, "AGENTS_WORKSPACE_DIR"), None);
        assert_eq!(env_of(&instance, "AGENTS_WORKSPACE_LOCK"), None);
    }

    #[test]
    fn workspace_decision_wins_over_a_start_command_env() {
        let mut instance = inst("echo", None, "local");
        instance.workspace = r"C:\work".into();

        let mut locked = Command::new("python");
        locked.env("AGENTS_WORKSPACE_DIR", r"C:\elsewhere");
        locked.env("AGENTS_WORKSPACE_LOCK", "0");
        apply_workspace_env(&mut locked, &instance);
        assert_eq!(cmd_env(&locked, "AGENTS_WORKSPACE_DIR").as_deref(), Some(r"C:\work"));
        assert_eq!(cmd_env(&locked, "AGENTS_WORKSPACE_LOCK").as_deref(), Some("1"));

        instance.lock_workspace = false;
        let mut open = Command::new("python");
        open.env("AGENTS_WORKSPACE_LOCK", "1");
        apply_workspace_env(&mut open, &instance);
        assert_eq!(cmd_env(&open, "AGENTS_WORKSPACE_LOCK"), None);
    }

    #[test]
    fn stop_matches_the_declared_start_command() {
        let mut instance = inst("echo", None, "local");
        instance.start_cmd = Some(InstanceStartSpec {
            argv: vec![
                r"C:\Py\python.exe".into(),
                "-m".into(),
                "klanker".into(),
                "serve".into(),
            ],
            cwd: None,
            env: HashMap::new(),
        });
        assert!(command_matches(
            r#""C:\Py\python.exe" -m klanker serve"#,
            &instance
        ));
        assert!(!command_matches(r#""C:\Py\python.exe" other.py"#, &instance));

        let plain = inst("echo", None, "local");
        assert!(command_matches("python -m klanker serve", &plain));
        assert!(!command_matches("python -m other serve", &plain));
    }

    #[test]
    fn custom_loop_cmd_quotes_a_path_with_a_space() {
        let dir = std::env::temp_dir().join(format!("klanker prompt {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let py = PythonInv {
            program: r"C:\Program Files\Python\python.exe".into(),
            prefix: Vec::new(),
        };
        let mut instance = inst("echo", None, "local");
        instance.system_prompt = "be brief".into();
        let cmd = super::custom_loop_cmd(&py, &instance, &dir).unwrap().unwrap();
        assert!(!cmd.contains('\\'), "{cmd}");
        assert!(cmd.contains("'C:/Program Files/Python/python.exe'"), "{cmd}");
        assert!(cmd.contains("--system '"), "{cmd}");
        assert!(cmd.ends_with("system-prompt.txt'"), "{cmd}");
        assert_eq!(
            std::fs::read_to_string(dir.join("system-prompt.txt")).unwrap(),
            "be brief"
        );

        let mut blank = inst("echo", None, "local");
        blank.system_prompt = "   ".into();
        assert!(super::custom_loop_cmd(&py, &blank, &dir).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oldest_pending_approval_is_the_card() {
        let dir = std::env::temp_dir().join(format!("klanker-appr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("later.json"),
            r#"{"id":"later","status":"pending","created_at":20,"request":{"tool":"later","summary":"later tool"}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("first.json"),
            r#"{"id":"first-tool","status":"pending","created_at":10,"request":{"tool":"mcp.terminal.run","summary":"mcp.terminal.run cmd=echo hi"}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("done.json"),
            r#"{"id":"done","status":"approved","created_at":1,"request":{"tool":"nope","summary":"nope"}}"#,
        )
        .unwrap();
        let pending = read_pending_approval(&dir).unwrap();
        assert_eq!(pending.id, "first-tool");
        assert_eq!(pending.tool, "mcp.terminal.run");
        assert_eq!(pending.summary, "mcp.terminal.run cmd=echo hi");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_keeps_assigned_port_and_drops_plaintext_secret() {
        assert_eq!(super::kept_local_port(Some(8791)), Some(8791));
        assert_eq!(super::kept_local_port(Some(0)), None);
        assert_eq!(super::kept_local_port(None), None);

        let mut instance = inst("echo", None, "local");
        instance.secret = Some("relay-secret".into());
        instance.api_key = Some("sk-test".into());
        assert_eq!(env_of(&instance, "RELAY_SECRET").as_deref(), Some("relay-secret"));
        let stored = super::without_secrets(instance);
        let json = serde_json::to_string(&stored).unwrap();
        assert!(!json.contains("relay-secret"));
        assert!(!json.contains("sk-test"));
        assert!(!json.contains("\"secret\""));
        assert!(!json.contains("api_key"));

        let mut settings = super::default_settings();
        settings.openrouter_api_key = "sk-or".into();
        settings.openrouter_key_set = true;
        let disk = super::settings_for_disk(settings);
        let json = serde_json::to_string(&disk).unwrap();
        assert!(!json.contains("sk-or"));
        assert!(!json.contains("openrouter_api_key"));
        assert!(!json.contains("openrouter_key_set"));
    }
}
