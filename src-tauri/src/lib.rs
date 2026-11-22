pub mod autostart;
pub mod discovery;
pub mod migrate;
pub mod provision;
pub mod registry;
pub mod secrets;
pub mod serve;
pub mod tray;
pub mod updater;

use std::path::PathBuf;
use tauri::Manager;

/// Host root for desktop infra (`~/.agents`), deliberately ignoring
/// `AGENTS_HOST_DIR` so tests and CI never hijack the desktop registry.
pub(crate) fn desktop_host_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".agents"))
        .ok_or_else(|| "no home dir".to_string())
}

#[tauri::command]
fn secret_get(account: String) -> Option<String> {
    if !secrets::valid_account(&account) {
        return None;
    }
    secrets::get(&account)
}

#[tauri::command]
fn secret_set(account: String, secret: String) -> Result<(), String> {
    if !secrets::valid_account(&account) {
        return Err("invalid secret account".into());
    }
    secrets::set(&account, &secret)
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
            serve::init(app.handle());
            if let Err(err) = tray::setup_tray(app.handle()) {
                eprintln!("tray setup failed: {err}");
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
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
            discovery::discover_peers
        ])
        .run(tauri::generate_context!())
        .expect("error while running klanker desktop application");
}
