pub mod commands;
pub mod models;
pub mod presence;
pub mod secrets;
pub mod tray;

use commands::AppState;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            running_processes: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
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
            commands::load_settings,
            commands::save_settings,
            commands::list_klankers,
            commands::save_klanker,
            commands::delete_klanker,
            commands::get_gateway_status,
            commands::instance_start,
            commands::instance_stop,
            commands::execute_turn,
            commands::discover_peers,
            commands::list_presence_offers,
            commands::publish_presence_offer,
            commands::read_recent_traces,
            commands::pending_approval,
            commands::resolve_approval
        ])
        .run(tauri::generate_context!())
        .expect("error while running klanker desktop application");
}
