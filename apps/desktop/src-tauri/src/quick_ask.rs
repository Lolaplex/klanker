//! Pre-warmed quick-ask spotlight window, persisted config, and the global hotkey.
//!
//! The window is created hidden at app setup so the first hotkey press is a
//! focus operation, not a webview cold start. The same hotkey always stays
//! registered: with quick-ask disabled it falls back to raising the main
//! workbench and focusing its composer.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const QUICK_ASK_LABEL: &str = "quick-ask";
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";
const CONFIG_KEY: &str = "quick_ask";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuickAskConfig {
    pub enabled: bool,
    pub shortcut: String,
}

impl Default for QuickAskConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_SHORTCUT.to_string(),
        }
    }
}

struct QuickAskRuntime {
    config: QuickAskConfig,
    registered_shortcut: Option<String>,
}

pub struct QuickAskState(Mutex<QuickAskRuntime>);

fn config_path_at(host_dir: &Path) -> PathBuf {
    host_dir.join("desktop.json")
}

fn config_from_map(map: &Map<String, Value>) -> Result<QuickAskConfig, String> {
    let default = QuickAskConfig::default();
    let empty = Map::new();
    let source = map
        .get(CONFIG_KEY)
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);
    let enabled = source
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(default.enabled);
    let shortcut = source
        .get("shortcut")
        .and_then(|v| v.as_str())
        .unwrap_or(&default.shortcut);
    validate_shortcut(shortcut).map(|shortcut| QuickAskConfig { enabled, shortcut })
}

pub(crate) fn load_config_at(host_dir: &Path) -> Result<QuickAskConfig, String> {
    let path = config_path_at(host_dir);
    if !path.exists() {
        return Ok(QuickAskConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(QuickAskConfig::default());
    }
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let map = value
        .as_object()
        .ok_or_else(|| format!("parse {}: root must be an object", path.display()))?;
    config_from_map(map)
}

pub(crate) fn save_config_at(host_dir: &Path, config: &QuickAskConfig) -> Result<(), String> {
    validate_shortcut(&config.shortcut)?;
    fs::create_dir_all(host_dir).map_err(|e| format!("create host dir: {e}"))?;
    let path = config_path_at(host_dir);
    let mut map: Map<String, Value> = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        if raw.trim().is_empty() {
            Map::new()
        } else {
            serde_json::from_str::<Value>(&raw)
                .map_err(|e| format!("parse {}: {e}", path.display()))?
                .as_object()
                .cloned()
                .ok_or_else(|| format!("parse {}: root must be an object", path.display()))?
        }
    } else {
        Map::new()
    };
    map.insert(
        CONFIG_KEY.to_string(),
        serde_json::json!({
            "enabled": config.enabled,
            "shortcut": config.shortcut,
        }),
    );
    let mut payload =
        serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    payload.push('\n');
    let tmp = host_dir.join(format!(
        ".desktop.json.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(err) = fs::write(&tmp, payload.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write desktop.json temp: {err}"));
    }
    if let Err(err) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("rename desktop.json: {err}"));
    }
    Ok(())
}

fn canonical_key(code: tauri_plugin_global_shortcut::Code) -> String {
    let raw = code.to_string();
    if raw.len() == 4 && raw.starts_with("Key") {
        return raw[3..].to_string();
    }
    if raw.len() == 6 && raw.starts_with("Digit") {
        return raw[5..].to_string();
    }
    raw
}

fn canonical_modifier(token: &str) -> Option<&'static str> {
    match token.trim().to_ascii_lowercase().as_str() {
        "alt" | "option" => Some("Alt"),
        "ctrl" | "control" => Some("Ctrl"),
        "shift" => Some("Shift"),
        "cmd" | "command" | "super" => Some("Super"),
        "cmdorctrl" | "cmdorcontrol" | "commandorctrl" | "commandorcontrol" => Some("CmdOrCtrl"),
        _ => None,
    }
}

/// Validate and canonicalize the user-facing accelerator. Validation is
/// deliberately done against the same parser the global-shortcut plugin uses,
/// with one extra product rule: a modifier is required (a bare `K` must never
/// steal every keystroke system-wide).
pub(crate) fn validate_shortcut(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("shortcut is empty".to_string());
    }
    let parsed =
        Shortcut::from_str(trimmed).map_err(|e| format!("invalid shortcut '{trimmed}': {e}"))?;
    if parsed.mods.is_empty() {
        return Err("shortcut needs at least one modifier".to_string());
    }
    let tokens: Vec<&str> = trimmed.split('+').map(str::trim).collect();
    if tokens.len() < 2 || tokens.iter().any(|t| t.is_empty()) {
        return Err(format!("invalid shortcut '{trimmed}'"));
    }
    let mut modifiers: Vec<&'static str> = Vec::new();
    for token in &tokens[..tokens.len() - 1] {
        let modifier = canonical_modifier(token)
            .ok_or_else(|| format!("invalid shortcut modifier '{token}'"))?;
        if modifiers.contains(&modifier) {
            return Err(format!("duplicate shortcut modifier '{modifier}'"));
        }
        modifiers.push(modifier);
    }
    Ok(format!(
        "{}+{}",
        modifiers.join("+"),
        canonical_key(parsed.key)
    ))
}

fn initial_config() -> QuickAskConfig {
    match crate::desktop_host_dir().and_then(|dir| load_config_at(&dir)) {
        Ok(config) => config,
        Err(err) => {
            eprintln!("quick-ask config invalid, using defaults: {err}");
            QuickAskConfig::default()
        }
    }
}

fn register_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app_handle, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_quick_ask(app_handle);
            }
        })
        .map_err(|e| format!("register global shortcut {shortcut}: {e}"))
}

fn unregister_shortcut(app: &AppHandle, shortcut: &str) {
    if let Err(err) = app.global_shortcut().unregister(shortcut) {
        eprintln!("quick-ask: unregister global shortcut {shortcut}: {err}");
    }
}

/// Create or reuse the hidden pre-warmed spotlight window.
pub fn ensure_quick_ask_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(QUICK_ASK_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        QUICK_ASK_LABEL,
        WebviewUrl::App("index.html?view=quick-ask".into()),
    )
    .title("Klanker Quick Ask")
    .inner_size(640.0, 420.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .center()
    .focused(false)
    .build()
    .map_err(|e| format!("create quick-ask window: {e}"))?;

    let blurred = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            let _ = blurred.hide();
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = blurred.hide();
        }
        _ => {}
    });
    Ok(window)
}

fn quick_ask_enabled(app: &AppHandle) -> bool {
    app.try_state::<QuickAskState>()
        .and_then(|state| state.0.lock().ok().map(|rt| rt.config.enabled))
        .unwrap_or(true)
}

fn present_quick_ask(app: &AppHandle) {
    match ensure_quick_ask_window(app) {
        Ok(window) => {
            let _ = window.center();
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit("klanker:quick-ask-open", ());
        }
        Err(err) => eprintln!("quick-ask: {err}"),
    }
}

pub fn toggle_quick_ask(app: &AppHandle) {
    if !quick_ask_enabled(app) {
        crate::tray::show_main(app);
        return;
    }
    match ensure_quick_ask_window(app) {
        Ok(window) => {
            let visible = window.is_visible().unwrap_or(false);
            let focused = window.is_focused().unwrap_or(false);
            if visible && focused {
                let _ = window.hide();
            } else {
                present_quick_ask(app);
            }
        }
        Err(err) => eprintln!("quick-ask: {err}"),
    }
}

/// Install state, pre-warm the window, and register the configured hotkey.
/// Hotkey registration failure is non-fatal (another OS app may own the key);
/// the settings command retries and surfaces the registration error loudly.
pub fn setup_quick_ask(app: &AppHandle) -> Result<(), String> {
    let config = initial_config();
    let registered_shortcut = match register_shortcut(app, &config.shortcut) {
        Ok(()) => Some(config.shortcut.clone()),
        Err(err) => {
            eprintln!("quick-ask: {err}");
            None
        }
    };
    app.manage(QuickAskState(Mutex::new(QuickAskRuntime {
        config,
        registered_shortcut,
    })));
    ensure_quick_ask_window(app)?;
    Ok(())
}

#[tauri::command]
pub fn get_quick_ask_config(state: State<'_, QuickAskState>) -> QuickAskConfig {
    state
        .0
        .lock()
        .map(|rt| rt.config.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_quick_ask_config(
    app: AppHandle,
    state: State<'_, QuickAskState>,
    enabled: bool,
    shortcut: String,
) -> Result<QuickAskConfig, String> {
    let shortcut = validate_shortcut(&shortcut)?;
    let next = QuickAskConfig { enabled, shortcut };
    let old_shortcut = {
        let rt = state
            .0
            .lock()
            .map_err(|_| "quick-ask state lock poisoned".to_string())?;
        rt.registered_shortcut.clone()
    };
    let needs_register = old_shortcut.as_deref() != Some(next.shortcut.as_str());
    if needs_register {
        register_shortcut(&app, &next.shortcut)?;
    }

    let host_dir = crate::desktop_host_dir()?;
    if let Err(err) = save_config_at(&host_dir, &next) {
        if needs_register {
            unregister_shortcut(&app, &next.shortcut);
        }
        return Err(err);
    }

    {
        let mut rt = state
            .0
            .lock()
            .map_err(|_| "quick-ask state lock poisoned".to_string())?;
        rt.config = next.clone();
        rt.registered_shortcut = Some(next.shortcut.clone());
    }
    if needs_register {
        if let Some(old) = old_shortcut {
            unregister_shortcut(&app, &old);
        }
    }
    Ok(next)
}

#[tauri::command]
pub fn hide_quick_ask(app: AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK_ASK_LABEL) {
        let _ = window.hide();
    }
}

#[derive(Clone, Debug, Serialize)]
struct OpenSessionPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[tauri::command]
pub fn open_main_session(
    app: AppHandle,
    workspace: Option<String>,
    persona: Option<String>,
    session: Option<String>,
) {
    if let Some(window) = app.get_webview_window(QUICK_ASK_LABEL) {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window(crate::tray::MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let payload = OpenSessionPayload {
        workspace: clean_optional(workspace),
        persona: clean_optional(persona),
        session: clean_optional(session),
    };
    let _ = app.emit("klanker:open-session", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "klanker-quick-ask-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn default_config_is_enabled_alt_space() {
        assert_eq!(
            QuickAskConfig::default(),
            QuickAskConfig {
                enabled: true,
                shortcut: "Alt+Space".to_string(),
            }
        );
    }

    #[test]
    fn config_round_trip_preserves_unknown_desktop_keys() {
        let tmp = TempDir::new("roundtrip");
        fs::write(
            tmp.0.join("desktop.json"),
            r#"{"unrelated":{"keep":true},"quick_ask":{"enabled":false,"shortcut":"Ctrl+Shift+K"}}"#,
        )
        .unwrap();
        let loaded = load_config_at(&tmp.0).unwrap();
        assert_eq!(
            loaded,
            QuickAskConfig {
                enabled: false,
                shortcut: "Ctrl+Shift+K".to_string(),
            }
        );

        let next = QuickAskConfig {
            enabled: true,
            shortcut: "Alt+K".to_string(),
        };
        save_config_at(&tmp.0, &next).unwrap();
        assert_eq!(load_config_at(&tmp.0).unwrap(), next);
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(tmp.0.join("desktop.json")).unwrap()).unwrap();
        assert_eq!(saved["unrelated"]["keep"], true);
        assert_eq!(saved["quick_ask"]["shortcut"], "Alt+K");
    }

    #[test]
    fn corrupt_config_is_never_overwritten_by_a_save() {
        let tmp = TempDir::new("corrupt");
        let path = tmp.0.join("desktop.json");
        fs::write(&path, "{not json").unwrap();
        assert!(save_config_at(&tmp.0, &QuickAskConfig::default()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not json");
    }

    #[test]
    fn missing_config_loads_defaults() {
        let tmp = TempDir::new("missing");
        assert_eq!(load_config_at(&tmp.0).unwrap(), QuickAskConfig::default());
    }

    #[test]
    fn shortcut_validation_accepts_required_presets() {
        for (input, expected) in [
            ("Alt+Space", "Alt+Space"),
            ("Ctrl+Shift+K", "Ctrl+Shift+K"),
            ("alt+k", "Alt+K"),
            ("Control+Shift+KeyK", "Ctrl+Shift+K"),
        ] {
            let canonical = validate_shortcut(input).unwrap();
            assert_eq!(canonical, expected);
            assert!(
                Shortcut::from_str(&canonical).is_ok(),
                "canonical shortcut no longer parses: {canonical}"
            );
        }
    }

    #[test]
    fn shortcut_validation_rejects_empty_garbage_and_bare_keys() {
        for invalid in [
            "",
            "   ",
            "not-a-real-shortcut",
            "Alt+",
            "K",
            "Shift+Shift+K",
        ] {
            assert!(
                validate_shortcut(invalid).is_err(),
                "invalid shortcut accepted: {invalid:?}"
            );
        }
    }

    #[test]
    fn app_url_query_join_keeps_quick_ask_view() {
        let base = tauri::Url::parse("http://localhost:1420").unwrap();
        let joined = base.join("index.html?view=quick-ask").unwrap();
        assert_eq!(
            joined.as_str(),
            "http://localhost:1420/index.html?view=quick-ask"
        );
        assert_eq!(joined.query(), Some("view=quick-ask"));
    }
}
