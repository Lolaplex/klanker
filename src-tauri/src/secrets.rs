use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const SERVICE: &str = "klanker-desktop";
pub const OPENROUTER: &str = "openrouter";

pub fn relay_account(id: &str) -> String {
    format!("relay.{id}")
}

fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(account: &str) -> Option<String> {
    cache().lock().ok()?.get(account).cloned()
}

fn cache_set(account: &str, secret: &str) {
    if let Ok(mut map) = cache().lock() {
        map.insert(account.to_string(), secret.to_string());
    }
}

fn cache_remove(account: &str) {
    if let Ok(mut map) = cache().lock() {
        map.remove(account);
    }
}

pub fn get(account: &str) -> Option<String> {
    if let Some(value) = cache_get(account) {
        if !value.is_empty() {
            return Some(value);
        }
    }
    if cfg!(test) {
        return None;
    }
    let entry = keyring::Entry::new(SERVICE, account).ok()?;
    let value = entry.get_password().ok()?.trim().to_string();
    if value.is_empty() {
        return None;
    }
    cache_set(account, &value);
    Some(value)
}

pub fn present(account: &str) -> bool {
    get(account).is_some()
}

pub fn set(account: &str, secret: &str) -> Result<(), String> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Ok(());
    }
    cache_set(account, secret);
    if cfg!(test) {
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, account).map_err(|_| "credential store rejected the value")?;
    entry
        .set_password(secret)
        .map_err(|_| "credential store rejected the value".to_string())
}

pub fn delete(account: &str) {
    cache_remove(account);
    if cfg!(test) {
        return;
    }
    if let Ok(entry) = keyring::Entry::new(SERVICE, account) {
        let _ = entry.delete_credential();
    }
}

fn host_vault_path() -> Result<PathBuf, String> {
    Ok(crate::desktop_host_dir()?.join("secrets").join("host.json"))
}

pub(crate) fn read_host_vault_secret_at(path: &Path, key: &str) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    let obj = val.as_object()?;
    let value = obj.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn write_host_vault_secret_at(path: &Path, key: &str, value: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("empty secret key".into());
    }
    let value = value.trim();
    if value.is_empty() {
        return Err("empty secret value".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "invalid vault path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create secrets dir: {e}"))?;
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod secrets dir: {e}"))?;

    let mut map: Map<String, Value> = if path.exists() {
        let raw = fs::read_to_string(path).map_err(|e| format!("read host vault: {e}"))?;
        if raw.trim().is_empty() {
            Map::new()
        } else {
            let parsed: Value =
                serde_json::from_str(&raw).map_err(|e| format!("parse host vault: {e}"))?;
            parsed
                .as_object()
                .cloned()
                .ok_or_else(|| "host vault must be a JSON object".to_string())?
        }
    } else {
        Map::new()
    };

    map.insert(key.to_string(), Value::String(value.to_string()));
    let mut payload =
        serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    payload.push('\n');

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("host.json");
    let tmp = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    let write_res = (|| -> Result<(), String> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut f = opts
            .open(&tmp)
            .map_err(|e| format!("create vault temp file: {e}"))?;
        f.write_all(payload.as_bytes())
            .map_err(|e| format!("write vault temp file: {e}"))?;
        f.flush()
            .map_err(|e| format!("flush vault temp file: {e}"))?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }

    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename host vault: {err}"));
    }

    #[cfg(unix)]
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));

    Ok(())
}

/// Read a host-scoped secret from `~/.agents/secrets/host.json`.
pub fn read_host_vault_secret(key: &str) -> Option<String> {
    host_vault_path()
        .ok()
        .and_then(|path| read_host_vault_secret_at(&path, key))
}

/// Atomically write a host-scoped secret into `~/.agents/secrets/host.json`,
/// preserving any existing keys.
pub fn write_host_vault_secret(key: &str, value: &str) -> Result<(), String> {
    let path = host_vault_path()?;
    write_host_vault_secret_at(&path, key, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "klanker-secrets-{tag}-{}",
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
    fn host_vault_atomic_write_preserves_other_keys_and_reads_back() {
        let tmp = TempDir::new("vault");
        let vault = tmp.0.join("secrets").join("host.json");

        assert_eq!(read_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN"), None);

        write_host_vault_secret_at(&vault, "OTHER_KEY", "keep-me").unwrap();
        write_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN", "  tok-1  ").unwrap();

        assert_eq!(
            read_host_vault_secret_at(&vault, "OTHER_KEY").as_deref(),
            Some("keep-me")
        );
        assert_eq!(
            read_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN").as_deref(),
            Some("tok-1")
        );

        // Update existing key preserves sibling keys and leaves no temp files behind.
        write_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN", "tok-2").unwrap();
        assert_eq!(
            read_host_vault_secret_at(&vault, "OTHER_KEY").as_deref(),
            Some("keep-me")
        );
        assert_eq!(
            read_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN").as_deref(),
            Some("tok-2")
        );
        let leftovers: Vec<_> = fs::read_dir(vault.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());

        #[cfg(unix)]
        {
            let dir_mode = fs::metadata(vault.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(&vault).unwrap().permissions().mode() & 0o777;
            assert_eq!(dir_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }
    }

    #[test]
    fn host_vault_rejects_corrupt_json_without_overwriting() {
        let tmp = TempDir::new("corrupt");
        let vault = tmp.0.join("secrets").join("host.json");
        fs::create_dir_all(vault.parent().unwrap()).unwrap();
        fs::write(&vault, "{not json").unwrap();

        assert_eq!(read_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN"), None);
        assert!(write_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN", "tok").is_err());
        assert_eq!(fs::read_to_string(&vault).unwrap(), "{not json");
    }
}
