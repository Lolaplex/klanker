//! Tray presence: close-to-tray, native menu, global hotkey.
//!
//! Ported from dumbo `overlay.rs` mechanics (setup_tray, tray menu,
//! Alt+Space hotkey, always-on raise). Dumbo's webview popup menu is
//! deliberately not ported — a native menu covers the oracle.
//!
//! Daemon ownership: spawned `klanker serve` processes are detached and
//! NOT owned by the window (see commands.rs spawn). Quit exits the UI
//! only; daemons keep serving. "Stop running daemons" is the explicit
//! kill switch for locally-tracked instances.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::commands::{self, AppState};

pub const MAIN_LABEL: &str = "main";
/// Hotkey: Alt+Space parity with dumbo. Registration failure is logged
/// loudly; the rest of the tray still works.
const HOTKEY: &str = "Alt+Space";

static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Raise the workbench and ask the frontend to focus the chat composer.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("klanker:focus-composer", ());
    }
}

/// Kill every locally-tracked daemon PID. Detached or foreign relays are
/// untouched — the ownership map is the boundary.
fn stop_all_owned(app: &AppHandle) {
    let state = app.state::<AppState>();
    let entries: Vec<(String, u32)> = state
        .running_processes
        .lock()
        .map(|m| m.iter().map(|(id, pid)| (id.clone(), *pid)).collect())
        .unwrap_or_default();
    for (id, pid) in entries {
        if !commands::pid_alive(pid) {
            continue;
        }
        let Ok(mut inst) = commands::read_instance(&id) else {
            continue;
        };
        if commands::is_our_process(pid, &inst).is_err() {
            continue;
        }
        if commands::kill_tree(pid).is_ok() {
            let _ = commands::store_pid(&mut inst, None);
            commands::remember(&state, &id, None);
        }
    }
}

fn register_hotkey(app: &AppHandle) {
    if let Err(err) = app
        .global_shortcut()
        .on_shortcut(HOTKEY, |app_handle, _shortcut, _event| {
            show_main(app_handle);
        })
    {
        eprintln!("tray: global shortcut {HOTKEY} not registered: {err}");
    }
}

/// Wire the tray icon, menu, close-to-tray, and the global hotkey.
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let open = MenuItemBuilder::with_id("tray-open", "Open Klanker")
        .build(app)
        .map_err(|e| e.to_string())?;
    let stop = MenuItemBuilder::with_id("tray-stop", "Stop running daemons")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit")
        .build(app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &stop])
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "no default window icon for tray".to_string())?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Klanker")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-stop" => stop_all_owned(app),
            "tray-quit" => {
                QUITTING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    // Close-to-tray: window close hides, daemons keep running.
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let w = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !is_quitting() {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        });
    }

    register_hotkey(app);
    Ok(())
}
