//! Tray presence: close-to-tray, native menu, global hotkey.
//!
//! Menu: Open Klanker / Restart serve / Open logs / Quit.
//! Quit kills the local serve only when the app spawned it
//! (`serve::kill_owned`); foreign serves are left running.
//! Hotkey: Alt+Space raises the window and asks the frontend to focus
//! the chat composer (`klanker:focus-composer`).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const MAIN_LABEL: &str = "main";
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

fn open_logs(app: &AppHandle) {
    let Ok(path) = crate::serve::log_path(app) else {
        return;
    };
    let target = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(path);
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let prog = "xdg-open";
    let mut cmd = std::process::Command::new(prog);
    cmd.arg(&target);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd.spawn();
}

fn restart_serve(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::serve::serve_restart(app).await;
    });
}

fn register_hotkey(app: &AppHandle) {
    if let Err(err) = app
        .global_shortcut()
        .on_shortcut(HOTKEY, |app_handle, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                show_main(app_handle);
            }
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
    let restart = MenuItemBuilder::with_id("tray-restart", "Restart serve")
        .build(app)
        .map_err(|e| e.to_string())?;
    let logs = MenuItemBuilder::with_id("tray-logs", "Open logs")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit")
        .build(app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &restart, &logs])
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "no default window icon for tray".to_string())?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .tooltip("Klanker")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-restart" => restart_serve(app),
            "tray-logs" => open_logs(app),
            "tray-quit" => {
                QUITTING.store(true, Ordering::SeqCst);
                crate::serve::kill_owned(app);
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

    // Close-to-tray: window close hides, the serve keeps running.
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
