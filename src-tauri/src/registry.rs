//! Durable instance registry: `~/.klanker/instances/<id>/instance.json` —
//! the same files the legacy monolith wrote and `migrate.rs` imports.
//! Slim CRUD only; secrets never touch disk (OS keyring `relay.<id>`).

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".klanker").join("instances"))
        .ok_or_else(|| "no home dir".to_string())
}

/// Instance ids become directory names — reject separators and traversal.
fn clean_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err(format!("invalid instance id: {id:?}"));
    }
    Ok(id.to_string())
}

#[tauri::command]
pub fn instances_list() -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(root()?) {
        for entry in entries.flatten() {
            let cfg = entry.path().join("instance.json");
            if let Ok(raw) = fs::read_to_string(&cfg) {
                if let Ok(json) = serde_json::from_str::<Value>(&raw) {
                    out.push(json);
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn instance_save(inst: Value) -> Result<Value, String> {
    let mut obj = inst.as_object().cloned().ok_or("instance must be an object")?;
    let id = clean_id(obj.get("id").and_then(Value::as_str).unwrap_or(""))?;
    obj.insert("id".into(), Value::String(id.clone()));
    obj.remove("secret");
    if let Some(ep) = obj.get_mut("endpoint").and_then(Value::as_object_mut) {
        ep.remove("secret");
    }
    let dir = root()?.join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("instance.json"),
        serde_json::to_string_pretty(&Value::Object(obj.clone())).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(Value::Object(obj))
}

#[tauri::command]
pub fn instance_delete(id: String) -> Result<(), String> {
    let id = clean_id(&id)?;
    let dir = root()?.join(&id);
    let cfg = dir.join("instance.json");
    if cfg.exists() {
        fs::remove_file(&cfg).map_err(|e| e.to_string())?;
    }
    // Remove the dir only when empty — `default` doubles as the managed
    // host root (workspaces/ etc.) and must survive registry deletes.
    if dir.read_dir().map(|mut d| d.next().is_none()).unwrap_or(false) {
        let _ = fs::remove_dir(&dir);
    }
    Ok(())
}
