//! One-time import of the legacy `~/.klanker` store: instance configs and
//! app settings written by the pre-thin-shell desktop build. The web layer
//! merges them into localStorage; secrets already live in the OS keyring.

use std::fs;

fn legacy_root() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".klanker"))
}

/// Returns `{instances: [...], settings: {...}|null}` from `~/.klanker`.
/// Empty arrays/objects when the legacy store does not exist — importing is
/// always safe to call.
#[tauri::command]
pub fn legacy_state() -> serde_json::Value {
    let mut instances = Vec::new();
    let mut settings = serde_json::Value::Null;
    if let Some(root) = legacy_root() {
        if let Ok(entries) = fs::read_dir(root.join("instances")) {
            for entry in entries.flatten() {
                let cfg = entry.path().join("instance.json");
                if let Ok(raw) = fs::read_to_string(&cfg) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                        instances.push(json);
                    }
                }
            }
        }
        if let Ok(raw) = fs::read_to_string(root.join("settings.json")) {
            settings = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
        }
    }
    serde_json::json!({ "instances": instances, "settings": settings })
}
