use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const SERVICE: &str = "agents-host";
const LEGACY_SERVICE: &str = "klanker-desktop";

pub fn relay_account(id: &str) -> String {
    format!("relay.{id}")
}

/// Accounts accessible from the Tauri webview IPC commands (`secret_get`/`set`/`delete`).
/// Restricts key access strictly to scoped `relay.<id|host>` accounts without path traversal.
pub fn valid_account(account: &str) -> bool {
    let Some(suffix) = account.strip_prefix("relay.") else {
        return false;
    };
    !suffix.is_empty()
        && suffix.len() <= 255
        && !account.contains("..")
        && !suffix.starts_with('.')
        && !suffix.contains(['/', '\\'])
        && suffix.chars().all(|c| c.is_ascii_graphic())
}

/// Keyring reads cache because a Credential Manager / Secret Service call
/// costs hundreds of ms — but an external writer (CLI, second app
/// instance) can replace the OS credential underneath us. The TTL bounds
/// how long a stale cached value can be served.
const KEYRING_CACHE_TTL: Duration = Duration::from_secs(30);

fn cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(account: &str) -> Option<String> {
    let (value, at) = cache().lock().ok()?.get(account)?.clone();
    (at.elapsed() < KEYRING_CACHE_TTL).then_some(value)
}

fn cache_set(account: &str, secret: &str) {
    if let Ok(mut map) = cache().lock() {
        map.insert(account.to_string(), (secret.to_string(), Instant::now()));
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
    if let Ok(entry) = keyring::Entry::new(SERVICE, account) {
        if let Ok(raw) = entry.get_password() {
            let value = raw.trim().to_string();
            if !value.is_empty() {
                cache_set(account, &value);
                return Some(value);
            }
        }
    }
    // 1-release fallback from legacy "klanker-desktop" keyring service + mirror forward.
    if let Ok(legacy) = keyring::Entry::new(LEGACY_SERVICE, account) {
        if let Ok(raw) = legacy.get_password() {
            let value = raw.trim().to_string();
            if !value.is_empty() {
                cache_set(account, &value);
                if let Ok(primary) = keyring::Entry::new(SERVICE, account) {
                    let _ = primary.set_password(&value);
                }
                return Some(value);
            }
        }
    }
    None
}

pub fn present(account: &str) -> bool {
    get(account).is_some()
}

pub fn set(account: &str, secret: &str) -> Result<(), String> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Ok(());
    }
    if cfg!(test) {
        cache_set(account, secret);
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, account).map_err(|_| "credential store rejected the value")?;
    entry
        .set_password(secret)
        .map_err(|_| "credential store rejected the value".to_string())?;
    // Cache only after the store accepted the write — caching first
    // poisons every read with a value the OS rejected.
    cache_set(account, secret);
    Ok(())
}

pub fn delete(account: &str) {
    cache_remove(account);
    if cfg!(test) {
        return;
    }
    for svc in [SERVICE, LEGACY_SERVICE] {
        if let Ok(entry) = keyring::Entry::new(svc, account) {
            let _ = entry.delete_credential();
        }
    }
}

fn host_vault_path() -> Result<PathBuf, String> {
    Ok(crate::desktop_host_dir()?.join("secrets").join("host.json"))
}

// --- cross-process vault lock ----------------------------------------------
//
// Writers serialize on `<file>.lock` via an OS advisory lock (`try_lock`
// — LockFileEx / flock) with exponential retry; the handle is the lock and
// drops release it, so a crash can never leave a stale lockfile. Retried
// on Windows sharing violations (os error 32) and ERROR_LOCK_VIOLATION
// (os error 33), which surface when a peer holds the lock or opened the
// file without share flags.
//
// ASYMMETRY: Python `agents_workspace.secrets.write_secret` performs an
// unlocked read-modify-write today — this lock orders Rust-side writers
// (desktop + future Rust tools) only. Python can join the protocol later
// by flocking `host.json.lock` the same way; until then a Rust write can
// still race a Python write and last-rename wins.
const VAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(10);

struct VaultLock {
    _file: File,
}

fn vault_lock_path(vault: &Path) -> PathBuf {
    let mut name = vault
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| "host.json".into());
    name.push(".lock");
    vault.with_file_name(name)
}

fn is_sharing_violation(e: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33) — Windows.
    matches!(e.raw_os_error(), Some(32) | Some(33))
}

/// Retry os error 32/33 briefly: on Windows a peer (indexer, AV, the
/// Python side holding the file open without share-delete) can transiently
/// block a read or rename of host.json — one shot is not a real failure.
fn retry_sharing_violation<T>(
    mut op: impl FnMut() -> Result<T, std::io::Error>,
) -> Result<T, std::io::Error> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut delay = Duration::from_millis(5);
    loop {
        match op() {
            Err(e) if is_sharing_violation(&e) && Instant::now() < deadline => {
                std::thread::sleep(delay);
                delay = (delay * 2).min(Duration::from_millis(100));
            }
            other => return other,
        }
    }
}

fn acquire_vault_lock(vault: &Path) -> Result<VaultLock, String> {
    let lock_path = vault_lock_path(vault);
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create vault lock dir: {e}"))?;
    }
    let deadline = Instant::now() + VAULT_LOCK_TIMEOUT;
    let mut delay = Duration::from_millis(5);
    loop {
        let open_res = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&lock_path);
        match open_res {
            Ok(file) => match file.try_lock() {
                Ok(()) => return Ok(VaultLock { _file: file }),
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(std::fs::TryLockError::Error(e)) => {
                    if !is_sharing_violation(&e) {
                        return Err(format!("lock host vault: {e}"));
                    }
                }
            },
            Err(e) => {
                if !is_sharing_violation(&e) {
                    return Err(format!("open vault lockfile: {e}"));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "host vault lock timeout ({})",
                lock_path.display()
            ));
        }
        std::thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_millis(200));
    }
}

// --- host.json read cache ----------------------------------------------------
// The vault file is re-read only when (mtime, len) changed — callers poll
// the vault on every serve status tick and a stat is cheaper than a
// read+parse. Writes invalidate their own entry.

#[derive(Clone)]
struct VaultCacheEntry {
    mtime: SystemTime,
    len: u64,
    value: Arc<Value>,
}

fn vault_cache() -> &'static Mutex<HashMap<PathBuf, VaultCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, VaultCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn vault_cache_get(path: &Path, mtime: SystemTime, len: u64) -> Option<Arc<Value>> {
    let entry = vault_cache().lock().ok()?.get(path)?.clone();
    (entry.mtime == mtime && entry.len == len).then_some(entry.value)
}

fn vault_cache_set(path: &Path, mtime: SystemTime, len: u64, value: &Value) {
    if let Ok(mut map) = vault_cache().lock() {
        map.insert(
            path.to_path_buf(),
            VaultCacheEntry {
                mtime,
                len,
                value: Arc::new(value.clone()),
            },
        );
    }
}

fn vault_cache_invalidate(path: &Path) {
    if let Ok(mut map) = vault_cache().lock() {
        map.remove(path);
    }
}

/// Parsed host.json — served from cache while (mtime, len) is unchanged.
pub(crate) fn read_host_vault_at(path: &Path) -> Option<Arc<Value>> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    if let Some(hit) = vault_cache_get(path, mtime, meta.len()) {
        return Some(hit);
    }
    let raw = fs::read_to_string(path).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    vault_cache_set(path, mtime, meta.len(), &val);
    Some(Arc::new(val))
}

pub(crate) fn read_host_vault_secret_at(path: &Path, key: &str) -> Option<String> {
    let val = read_host_vault_at(path)?;
    let obj = val.as_object()?;
    let value = obj.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn write_host_vault_secrets_at(path: &Path, pairs: &[(&str, &str)]) -> Result<(), String> {
    if pairs.is_empty() {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "invalid vault path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create secrets dir: {e}"))?;
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod secrets dir: {e}"))?;

    // Whole read-merge-write under the OS advisory lock — concurrent
    // writers (several serve spawn paths, future CLI) must not clobber
    // each other's keys.
    let _lock = acquire_vault_lock(path)?;

    let mut map: Map<String, Value> = if path.exists() {
        let raw = retry_sharing_violation(|| fs::read_to_string(path))
            .map_err(|e| format!("read host vault: {e}"))?;
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

    for &(raw_key, raw_value) in pairs {
        let key = raw_key.trim();
        if key.is_empty() {
            return Err("empty secret key".into());
        }
        let value = raw_value.trim();
        if value.is_empty() {
            return Err("empty secret value".into());
        }
        map.insert(key.to_string(), Value::String(value.to_string()));
    }

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

    if let Err(err) = retry_sharing_violation(|| fs::rename(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename host vault: {err}"));
    }

    vault_cache_invalidate(path);

    #[cfg(unix)]
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));

    Ok(())
}

pub(crate) fn write_host_vault_secret_at(path: &Path, key: &str, value: &str) -> Result<(), String> {
    write_host_vault_secrets_at(path, &[(key, value)])
}

/// Read a host-scoped secret from `<host>/secrets/host.json`.
pub fn read_host_vault_secret(key: &str) -> Option<String> {
    host_vault_path()
        .ok()
        .and_then(|path| read_host_vault_secret_at(&path, key))
}

/// Atomically write a host-scoped secret into `<host>/secrets/host.json`,
/// preserving any existing keys.
pub fn write_host_vault_secret(key: &str, value: &str) -> Result<(), String> {
    let path = host_vault_path()?;
    write_host_vault_secret_at(&path, key, value)
}

/// Atomically write multiple host-scoped secrets in a single vault update.
pub fn write_host_vault_secrets(pairs: &[(&str, &str)]) -> Result<(), String> {
    let path = host_vault_path()?;
    write_host_vault_secrets_at(&path, pairs)
}

/// One-time migration: copy orphan legacy keyring `"klanker-desktop" / "openrouter"`
/// into `<host>/secrets/host.json` (`OPENROUTER_API_KEY`) when absent.
pub(crate) fn migrate_legacy_openrouter_key_at(
    vault_path: &Path,
    legacy_key: Option<&str>,
) -> bool {
    let Some(trimmed) = legacy_key.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    if read_host_vault_secret_at(vault_path, "OPENROUTER_API_KEY").is_some() {
        return false;
    }
    write_host_vault_secret_at(vault_path, "OPENROUTER_API_KEY", trimmed).is_ok()
}

pub fn migrate_legacy_openrouter_key(host_dir: &Path) {
    if cfg!(test) {
        return;
    }
    let Ok(legacy) = keyring::Entry::new(LEGACY_SERVICE, "openrouter") else {
        return;
    };
    let Ok(raw) = legacy.get_password() else {
        return;
    };
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        let _ = legacy.delete_credential();
        return;
    }
    let vault_path = host_dir.join("secrets").join("host.json");
    if migrate_legacy_openrouter_key_at(&vault_path, Some(&trimmed)) {
        let _ = set("OPENROUTER_API_KEY", &trimmed);
    }
    let _ = legacy.delete_credential();
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

    #[test]
    fn valid_account_allows_relay_and_rejects_arbitrary_or_traversal() {
        assert!(valid_account("relay.local"));
        assert!(valid_account("relay.vps.tailnet.ts.net:8787"));
        assert!(!valid_account("openrouter"));
        assert!(!valid_account("relay."));
        assert!(!valid_account("relay..local"));
        assert!(!valid_account("relay.a/b"));
        assert!(!valid_account("relay.a\\b"));
        assert!(!valid_account("relay.has space"));
        assert!(!valid_account(&format!("relay.{}", "a".repeat(256))));
    }

    #[test]
    fn migrate_legacy_openrouter_key_preserves_existing_and_moves_missing() {
        let tmp = TempDir::new("mig-or");
        let vault = tmp.0.join("secrets").join("host.json");

        // Blank/absent legacy key does nothing.
        assert!(!migrate_legacy_openrouter_key_at(&vault, None));
        assert!(!migrate_legacy_openrouter_key_at(&vault, Some("   ")));
        assert!(!vault.exists());

        // Migrates when OPENROUTER_API_KEY is absent in host vault.
        assert!(migrate_legacy_openrouter_key_at(&vault, Some("  sk-or-v1-legacy  ")));
        assert_eq!(
            read_host_vault_secret_at(&vault, "OPENROUTER_API_KEY").as_deref(),
            Some("sk-or-v1-legacy")
        );

        // Existing vault key must NOT be clobbered.
        write_host_vault_secret_at(&vault, "OPENROUTER_API_KEY", "sk-or-v1-current").unwrap();
        assert!(!migrate_legacy_openrouter_key_at(&vault, Some("sk-or-v1-legacy")));
        assert_eq!(
            read_host_vault_secret_at(&vault, "OPENROUTER_API_KEY").as_deref(),
            Some("sk-or-v1-current")
        );
    }

    #[test]
    fn write_host_vault_secrets_updates_multiple_keys_atomically() {
        let tmp = TempDir::new("multi-vault");
        let vault = tmp.0.join("secrets").join("host.json");
        write_host_vault_secrets_at(
            &vault,
            &[("RELAY_WEB_TOKEN", "tok-new"), ("RELAY_SECRET", "tok-new")],
        )
        .unwrap();
        assert_eq!(
            read_host_vault_secret_at(&vault, "RELAY_WEB_TOKEN").as_deref(),
            Some("tok-new")
        );
        assert_eq!(
            read_host_vault_secret_at(&vault, "RELAY_SECRET").as_deref(),
            Some("tok-new")
        );
    }

    #[test]
    fn concurrent_vault_read_modify_writes_lose_no_keys() {
        let tmp = TempDir::new("rmw-stress");
        let vault = tmp.0.join("secrets").join("host.json");
        const THREADS: usize = 8;
        const KEYS_PER_THREAD: usize = 6;

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
        let mut handles = Vec::new();
        for t in 0..THREADS {
            let vault = vault.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                for k in 0..KEYS_PER_THREAD {
                    let key = format!("KEY_T{t}_K{k}");
                    let val = format!("v-{t}-{k}");
                    write_host_vault_secret_at(&vault, &key, &val)
                        .unwrap_or_else(|e| panic!("write {key}: {e}"));
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let raw = fs::read_to_string(&vault).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        let obj = doc.as_object().unwrap();
        assert_eq!(obj.len(), THREADS * KEYS_PER_THREAD);
        for t in 0..THREADS {
            for k in 0..KEYS_PER_THREAD {
                assert_eq!(
                    obj.get(&format!("KEY_T{t}_K{k}")).and_then(Value::as_str),
                    Some(format!("v-{t}-{k}").as_str())
                );
            }
        }
    }

    #[test]
    fn vault_read_cache_tracks_mtime_and_len_and_invalidates_on_write() {
        let tmp = TempDir::new("vault-cache");
        let vault = tmp.0.join("secrets").join("host.json");
        fs::create_dir_all(vault.parent().unwrap()).unwrap();
        fs::write(&vault, r#"{"A":"1"}"#).unwrap();

        assert_eq!(read_host_vault_secret_at(&vault, "A").as_deref(), Some("1"));
        // External (unlocked) write is re-read — the (mtime, len) guard
        // never serves a stale map (len differs; sleep covers mtime
        // granularity).
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(&vault, r#"{"A":"2","B":"x"}"#).unwrap();
        assert_eq!(read_host_vault_secret_at(&vault, "A").as_deref(), Some("2"));
        assert_eq!(read_host_vault_secret_at(&vault, "B").as_deref(), Some("x"));

        // Locked write invalidates its own entry.
        write_host_vault_secret_at(&vault, "C", "y").unwrap();
        assert_eq!(read_host_vault_secret_at(&vault, "C").as_deref(), Some("y"));
    }

    #[test]
    fn vault_lockfile_is_sibling_lock_and_lock_serializes() {
        let tmp = TempDir::new("vault-lock");
        let vault = tmp.0.join("secrets").join("host.json");
        let guard = acquire_vault_lock(&vault).unwrap();
        assert!(tmp.0.join("secrets").join("host.json.lock").exists());
        // Second acquisition would block — prove the lock is held by
        // checking try_lock fails from the same file handle path.
        let lock_path = vault_lock_path(&vault);
        let f2 = OpenOptions::new().read(true).write(true).open(&lock_path).unwrap();
        assert!(matches!(
            f2.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(f2);
        drop(guard);
        // Released lock is re-acquirable.
        let _again = acquire_vault_lock(&vault).unwrap();
    }
}
