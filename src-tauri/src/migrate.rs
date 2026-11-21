//! One-time import of desktop settings (`~/.agents/clients/desktop/settings.json`
//! with a 1-release fallback to `~/.klanker/settings.json`) and legacy
//! `~/.klanker/instances/*/instance.json`.

use std::fs;
use std::path::{Path, PathBuf};

fn desktop_settings_path() -> Option<PathBuf> {
    crate::desktop_host_dir()
        .ok()
        .map(|h| h.join("clients").join("desktop").join("settings.json"))
}

fn legacy_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".klanker"))
}

fn read_json_non_null(path: &Path) -> Option<serde_json::Value> {
    let raw = fs::read_to_string(path).ok()?;
    let val = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    (!val.is_null()).then_some(val)
}

pub(crate) fn legacy_state_at(
    desktop_settings: Option<&Path>,
    klanker_root: Option<&Path>,
) -> serde_json::Value {
    let mut instances = Vec::new();
    let mut settings = desktop_settings
        .and_then(read_json_non_null)
        .unwrap_or(serde_json::Value::Null);

    if let Some(root) = klanker_root {
        if let Ok(entries) = fs::read_dir(root.join("instances")) {
            let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            paths.sort();
            for entry_path in paths {
                let cfg = entry_path.join("instance.json");
                if let Ok(raw) = fs::read_to_string(&cfg) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                        instances.push(json);
                    }
                }
            }
        }
        if settings.is_null() {
            if let Some(val) = read_json_non_null(&root.join("settings.json")) {
                settings = val;
            }
        }
    }
    serde_json::json!({ "instances": instances, "settings": settings })
}

/// Returns `{instances: [...], settings: {...}|null}`.
/// Empty arrays/null when neither store exists — importing is always safe to call.
#[tauri::command]
pub fn legacy_state() -> serde_json::Value {
    legacy_state_at(
        desktop_settings_path().as_deref(),
        legacy_root().as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "klanker-migrate-{tag}-{}",
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
    fn prefers_desktop_settings_over_legacy_klanker_and_loads_legacy_instances() {
        let tmp = TempDir::new("both");
        let desktop_settings = tmp.0.join("clients").join("desktop").join("settings.json");
        let klanker = tmp.0.join(".klanker");
        fs::create_dir_all(desktop_settings.parent().unwrap()).unwrap();
        fs::create_dir_all(klanker.join("instances").join("vps")).unwrap();

        fs::write(&desktop_settings, r#"{"workspace":"work"}"#).unwrap();
        fs::write(klanker.join("settings.json"), r#"{"workspace":"old"}"#).unwrap();
        fs::write(
            klanker.join("instances").join("vps").join("instance.json"),
            r#"{"id":"vps","name":"VPS"}"#,
        )
        .unwrap();

        let state = legacy_state_at(Some(&desktop_settings), Some(&klanker));
        assert_eq!(state["settings"]["workspace"], "work");
        assert_eq!(state["instances"].as_array().unwrap().len(), 1);
        assert_eq!(state["instances"][0]["id"], "vps");
    }

    #[test]
    fn falls_back_to_legacy_klanker_settings_when_desktop_settings_absent() {
        let tmp = TempDir::new("fallback");
        let desktop_settings = tmp.0.join("clients").join("desktop").join("settings.json");
        let klanker = tmp.0.join(".klanker");
        fs::create_dir_all(&klanker).unwrap();
        fs::write(klanker.join("settings.json"), r#"{"workspace":"legacy"}"#).unwrap();

        let state = legacy_state_at(Some(&desktop_settings), Some(&klanker));
        assert_eq!(state["settings"]["workspace"], "legacy");
        assert!(state["instances"].as_array().unwrap().is_empty());
    }

    #[test]
    fn missing_stores_return_empty_state() {
        let tmp = TempDir::new("empty");
        let state = legacy_state_at(
            Some(&tmp.0.join("missing.json")),
            Some(&tmp.0.join("missing-klanker")),
        );
        assert_eq!(state["instances"], serde_json::json!([]));
        assert!(state["settings"].is_null());
    }
}
