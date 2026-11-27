pub mod autostart;
pub mod discovery;
pub mod migrate;
pub mod provision;
pub mod quick_ask;
pub mod registry;
pub mod secrets;
pub mod serve;
pub mod splash;
pub mod tray;
pub mod updater;

use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn desktop_host_dir_with(env_override: Option<&str>) -> Result<PathBuf, String> {
    if let Some(val) = env_override.map(str::trim).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(val));
    }
    dirs::home_dir()
        .map(|h| h.join(".agents"))
        .ok_or_else(|| "no home dir".to_string())
}

/// Canonical host root for Desktop & CLI (`AGENTS_HOST_DIR` or `~/.agents`).
pub(crate) fn desktop_host_dir() -> Result<PathBuf, String> {
    let raw = std::env::var("AGENTS_HOST_DIR").ok();
    desktop_host_dir_with(raw.as_deref())
}

/// Read persistent `host_id` from `<host>/agents.json`, minting and atomically
/// storing `host_<hex>` if absent while preserving existing fields.
pub(crate) fn desktop_host_id_at(host_dir: &Path) -> Result<String, String> {
    fs::create_dir_all(host_dir).map_err(|e| format!("create host dir: {e}"))?;
    let agents_path = host_dir.join("agents.json");
    let mut map: Map<String, Value> = if agents_path.exists() {
        let raw = fs::read_to_string(&agents_path).unwrap_or_default();
        if raw.trim().is_empty() {
            Map::new()
        } else {
            serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default()
        }
    } else {
        Map::new()
    };

    if let Some(existing) = map
        .get("host_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(existing.to_string());
    }

    let minted = format!("host_{}", uuid::Uuid::new_v4().simple());
    map.insert("host_id".to_string(), Value::String(minted.clone()));
    let mut payload = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    payload.push('\n');

    let tmp = host_dir.join(format!(
        ".agents.json.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(err) = fs::write(&tmp, payload.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write agents.json temp: {err}"));
    }
    if let Err(err) = fs::rename(&tmp, &agents_path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename agents.json: {err}"));
    }
    Ok(minted)
}

#[tauri::command]
fn secret_get(account: String) -> Option<String> {
    if !secrets::valid_account(&account) {
        return None;
    }
    secrets::get(&account)
}

#[tauri::command]
async fn secret_set(account: String, secret: String) -> Result<(), String> {
    // Keyring writes can block for seconds (Windows Credential Manager,
    // vault lock wait up to 10s) — off the IPC handler thread.
    tauri::async_runtime::spawn_blocking(move || {
        if !secrets::valid_account(&account) {
            return Err("invalid secret account".into());
        }
        let trimmed = secret.trim();
        secrets::set(&account, trimmed)?;
        if account == secrets::relay_account("local") && !trimmed.is_empty() {
            secrets::write_host_vault_secrets(&[
                ("RELAY_WEB_TOKEN", trimmed),
                ("RELAY_SECRET", trimmed),
            ])?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
    if !secrets::valid_account(&account) {
        return Err("invalid secret account".into());
    }
    secrets::delete(&account);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build());
    // Dev builds only: MCP bridge for agent automation of the webview.
    // Never linked into release artifacts.
    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    builder
        .setup(|app| {
            if let Ok(hd) = desktop_host_dir() {
                secrets::migrate_legacy_openrouter_key(&hd);
            }
            // init() runs blocking TCP probes, tasklist/netstat spawns and
            // keyring I/O — keeping it on the setup path stalls first paint
            // by seconds.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || serve::init(&handle));
            if let Err(err) = tray::setup_tray(app.handle()) {
                eprintln!("tray setup failed: {err}");
            }
            if let Err(err) = quick_ask::setup_quick_ask(app.handle()) {
                eprintln!("quick-ask setup failed: {err}");
            }
            if let Err(err) = splash::setup_splash(app.handle()) {
                eprintln!("splash setup failed: {err}");
                tray::show_main(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            serve::serve_status,
            serve::serve_ensure_local,
            serve::serve_restart,
            provision::klanker_version,
            provision::klanker_install,
            provision::klanker_upgrade,
            updater::check_for_updates,
            updater::install_update,
            secret_get,
            secret_set,
            secret_delete,
            autostart::autostart_is_enabled,
            autostart::autostart_set,
            migrate::legacy_state,
            registry::instances_list,
            registry::instance_save,
            registry::instance_delete,
            discovery::discover_peers,
            quick_ask::get_quick_ask_config,
            quick_ask::set_quick_ask_config,
            quick_ask::hide_quick_ask,
            quick_ask::open_main_session,
            splash::close_splash
        ])
        .run(tauri::generate_context!())
        .expect("error while running klanker desktop application");
}
