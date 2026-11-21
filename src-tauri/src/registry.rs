//! Durable instance registry: `~/.agents/clients/desktop/instances.json`.
//! Reads `~/.agents/clients/desktop/instances/*/instance.json` and
//! `~/.klanker/instances/*/instance.json` as a one-release fallback when
//! `instances.json` does not exist yet.
//! Slim CRUD only; secrets never touch disk (OS keyring `relay.<id>`).

use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

fn registry_file_path() -> Result<PathBuf, String> {
    Ok(crate::desktop_host_dir()?
        .join("clients")
        .join("desktop")
        .join("instances.json"))
}

fn legacy_dirs() -> Result<Vec<PathBuf>, String> {
    let mut dirs_list = vec![crate::desktop_host_dir()?
        .join("clients")
        .join("desktop")
        .join("instances")];
    if let Some(home) = dirs::home_dir() {
        dirs_list.push(home.join(".klanker").join("instances"));
    }
    Ok(dirs_list)
}

/// Instance ids become keys and may have originated from directory names —
/// reject separators and traversal.
fn clean_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err(format!("invalid instance id: {id:?}"));
    }
    Ok(id.to_string())
}

fn strip_secrets(mut val: Value) -> Value {
    if let Some(obj) = val.as_object_mut() {
        obj.remove("secret");
        if let Some(ep) = obj.get_mut("endpoint").and_then(Value::as_object_mut) {
            ep.remove("secret");
        }
    }
    val
}

fn strip_secrets_map(obj: &mut Map<String, Value>) {
    obj.remove("secret");
    if let Some(ep) = obj.get_mut("endpoint").and_then(Value::as_object_mut) {
        ep.remove("secret");
    }
}

fn parse_registry_value(val: Value) -> Vec<Value> {
    match val {
        Value::Array(items) => items
            .into_iter()
            .filter(|v| v.is_object())
            .map(strip_secrets)
            .collect(),
        Value::Object(map) => {
            if let Some(Value::Array(items)) = map.get("instances") {
                return items
                    .iter()
                    .filter(|v| v.is_object())
                    .cloned()
                    .map(strip_secrets)
                    .collect();
            }
            map.into_iter()
                .filter_map(|(k, v)| {
                    let mut obj = v.as_object()?.clone();
                    if obj.get("id").and_then(Value::as_str).unwrap_or("").is_empty() {
                        obj.insert("id".into(), Value::String(k));
                    }
                    strip_secrets_map(&mut obj);
                    Some(Value::Object(obj))
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

fn read_legacy_dir(dir: &Path, seen: &mut HashSet<String>, out: &mut Vec<Value>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for entry_path in paths {
        if !entry_path.is_dir() {
            continue;
        }
        let cfg = entry_path.join("instance.json");
        let Ok(raw) = fs::read_to_string(&cfg) else {
            continue;
        };
        let Ok(mut json) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(obj) = json.as_object_mut() else {
            continue;
        };
        let fallback_id = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or(fallback_id);
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        obj.insert("id".into(), Value::String(id));
        strip_secrets_map(obj);
        out.push(json);
    }
}

pub(crate) fn list_at(registry_path: &Path, legacy_roots: &[PathBuf]) -> Result<Vec<Value>, String> {
    if registry_path.exists() {
        let raw = fs::read_to_string(registry_path).map_err(|e| e.to_string())?;
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        return Ok(parse_registry_value(parsed));
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for dir in legacy_roots {
        read_legacy_dir(dir, &mut seen, &mut out);
    }
    Ok(out)
}

fn write_registry_at(registry_path: &Path, items: &[Value]) -> Result<(), String> {
    let parent = registry_path
        .parent()
        .ok_or_else(|| "invalid registry path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let mut payload = serde_json::to_string_pretty(&Value::Array(items.to_vec()))
        .map_err(|e| e.to_string())?;
    payload.push('\n');

    let name = registry_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("instances.json");
    let tmp = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    let write_res = (|| -> Result<(), String> {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(payload.as_bytes()).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }

    if let Err(err) = fs::rename(&tmp, registry_path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    Ok(())
}

pub(crate) fn save_at(
    registry_path: &Path,
    legacy_roots: &[PathBuf],
    inst: Value,
) -> Result<Value, String> {
    let mut obj = inst
        .as_object()
        .cloned()
        .ok_or("instance must be an object")?;
    let id = clean_id(obj.get("id").and_then(Value::as_str).unwrap_or(""))?;
    obj.insert("id".into(), Value::String(id.clone()));
    strip_secrets_map(&mut obj);
    let saved = Value::Object(obj);

    let mut items = list_at(registry_path, legacy_roots)?;
    if let Some(slot) = items
        .iter_mut()
        .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        *slot = saved.clone();
    } else {
        items.push(saved.clone());
    }
    write_registry_at(registry_path, &items)?;
    Ok(saved)
}

pub(crate) fn delete_at(
    registry_path: &Path,
    legacy_roots: &[PathBuf],
    id: &str,
) -> Result<(), String> {
    let id = clean_id(id)?;
    let mut items = list_at(registry_path, legacy_roots)?;
    let before = items.len();
    items.retain(|row| row.get("id").and_then(Value::as_str) != Some(id.as_str()));
    let removed = items.len() != before;
    if registry_path.exists() || removed {
        write_registry_at(registry_path, &items)?;
    }
    Ok(())
}

#[tauri::command]
pub fn instances_list() -> Result<Vec<Value>, String> {
    list_at(&registry_file_path()?, &legacy_dirs()?)
}

#[tauri::command]
pub fn instance_save(inst: Value) -> Result<Value, String> {
    save_at(&registry_file_path()?, &legacy_dirs()?, inst)
}

#[tauri::command]
pub fn instance_delete(id: String) -> Result<(), String> {
    delete_at(&registry_file_path()?, &legacy_dirs()?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "klanker-registry-{tag}-{}",
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
    fn save_list_update_delete_and_strip_secrets() {
        let tmp = TempDir::new("crud");
        let reg = tmp.0.join("clients").join("desktop").join("instances.json");
        let legacy: Vec<PathBuf> = Vec::new();

        assert!(list_at(&reg, &legacy).unwrap().is_empty());

        let saved = save_at(
            &reg,
            &legacy,
            json!({
                "id": "vps",
                "name": "VPS",
                "secret": "top-secret",
                "endpoint": { "base_url": "https://vps.example", "secret": "ep-secret" }
            }),
        )
        .unwrap();
        assert!(saved.get("secret").is_none());
        assert!(saved["endpoint"].get("secret").is_none());

        let rows = list_at(&reg, &legacy).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "vps");
        assert!(rows[0].get("secret").is_none());
        assert!(rows[0]["endpoint"].get("secret").is_none());

        // Update same id in place.
        save_at(&reg, &legacy, json!({ "id": "vps", "name": "VPS Updated" })).unwrap();
        let rows = list_at(&reg, &legacy).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "VPS Updated");

        // Delete removes it cleanly.
        delete_at(&reg, &legacy, "vps").unwrap();
        assert!(list_at(&reg, &legacy).unwrap().is_empty());

        // Invalid ids rejected.
        assert!(save_at(&reg, &legacy, json!({ "id": "../bad" })).is_err());
        assert!(delete_at(&reg, &legacy, "a/b").is_err());
    }

    #[test]
    fn legacy_fallback_reads_desktop_then_klanker_until_instances_json_exists() {
        let tmp = TempDir::new("legacy");
        let reg = tmp.0.join("clients").join("desktop").join("instances.json");
        let desktop_legacy = tmp.0.join("clients").join("desktop").join("instances");
        let klanker_legacy = tmp.0.join(".klanker").join("instances");

        fs::create_dir_all(desktop_legacy.join("alpha")).unwrap();
        fs::write(
            desktop_legacy.join("alpha").join("instance.json"),
            r#"{"id":"alpha","name":"Desktop Alpha","secret":"leak"}"#,
        )
        .unwrap();

        fs::create_dir_all(klanker_legacy.join("alpha")).unwrap();
        fs::write(
            klanker_legacy.join("alpha").join("instance.json"),
            r#"{"id":"alpha","name":"Klanker Alpha"}"#,
        )
        .unwrap();

        fs::create_dir_all(klanker_legacy.join("beta")).unwrap();
        fs::write(
            klanker_legacy.join("beta").join("instance.json"),
            r#"{"id":"beta","name":"Klanker Beta"}"#,
        )
        .unwrap();

        let legacy = vec![desktop_legacy.clone(), klanker_legacy.clone()];
        let rows = list_at(&reg, &legacy).unwrap();
        assert_eq!(rows.len(), 2);
        let alpha = rows.iter().find(|r| r["id"] == "alpha").unwrap();
        assert_eq!(alpha["name"], "Desktop Alpha");
        assert!(alpha.get("secret").is_none());
        assert!(rows.iter().any(|r| r["id"] == "beta"));

        // Saving a new entry preserves legacy items into instances.json.
        save_at(&reg, &legacy, json!({ "id": "gamma", "name": "Gamma" })).unwrap();
        assert!(reg.exists());
        let after_save = list_at(&reg, &legacy).unwrap();
        assert_eq!(after_save.len(), 3);

        // Deleting all items leaves instances.json as [] and does not re-read legacy.
        for id in ["alpha", "beta", "gamma"] {
            delete_at(&reg, &legacy, id).unwrap();
        }
        assert!(list_at(&reg, &legacy).unwrap().is_empty());
        assert!(klanker_legacy.join("beta").join("instance.json").exists());
    }
}
