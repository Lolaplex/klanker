use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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
