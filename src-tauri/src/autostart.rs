//! OS login autostart via tauri-plugin-autostart.
//!
//! Toggle lives in web Settings; the web app calls these commands through
//! `invoke`. Web/PWA hosts get `caps.spawn === false` and never call them.

use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn autostart_is_enabled(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())
}
