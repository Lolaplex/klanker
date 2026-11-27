//! Lightweight startup splash window.
//!
//! The splash is an embedded data URL: no frontend asset, no network wait, no
//! JavaScript. React closes it after the main app mounts; a six-second native
//! deadline closes it even when the webview never gets that far.

use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SPLASH_LABEL: &str = "splash";
const SPLASH_TIMEOUT: Duration = Duration::from_secs(6);

// Same ten-bot D geometry as apps/web KlankerMark, inlined because the splash
// must paint before any web bundle asset exists.
const SPLASH_HTML: &str = r##"<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:#000000;overflow:hidden}
body{display:flex;align-items:center;justify-content:center}
.mark{animation:pulse 1.35s ease-in-out infinite;opacity:.82;transform:scale(.985)}
@keyframes pulse{0%,100%{opacity:.72;transform:scale(.985)}50%{opacity:1;transform:scale(1)}}
</style></head><body>
<svg class="mark" width="72" height="72" viewBox="0 0 24 24" role="img" aria-label="Klanker">
<rect width="24" height="24" rx="5" fill="#ffffff"/>
<g transform="rotate(45 12 12)" fill="#000000">
<rect x="7.15" y="5.9" width="2.2" height="2.2" rx=".66"/><rect x="7.15" y="8.4" width="2.2" height="2.2" rx=".66"/><rect x="7.15" y="10.9" width="2.2" height="2.2" rx=".66"/><rect x="7.15" y="13.4" width="2.2" height="2.2" rx=".66"/><rect x="7.15" y="15.9" width="2.2" height="2.2" rx=".66"/>
<rect x="9.65" y="10.9" width="2.2" height="2.2" rx=".66"/>
<rect x="12.15" y="8.4" width="2.2" height="2.2" rx=".66"/><rect x="12.15" y="13.4" width="2.2" height="2.2" rx=".66"/>
<rect x="14.65" y="5.9" width="2.2" height="2.2" rx=".66"/><rect x="14.65" y="15.9" width="2.2" height="2.2" rx=".66"/>
</g>
<g transform="rotate(45 12 12)" fill="#ffffff">
<circle cx="7.854" cy="6.824" r=".176"/><circle cx="8.646" cy="6.824" r=".176"/><circle cx="7.854" cy="9.324" r=".176"/><circle cx="8.646" cy="9.324" r=".176"/><circle cx="7.854" cy="11.824" r=".176"/><circle cx="8.646" cy="11.824" r=".176"/><circle cx="7.854" cy="14.324" r=".176"/><circle cx="8.646" cy="14.324" r=".176"/><circle cx="7.854" cy="16.824" r=".176"/><circle cx="8.646" cy="16.824" r=".176"/>
<circle cx="10.354" cy="11.824" r=".176"/><circle cx="11.146" cy="11.824" r=".176"/>
<circle cx="12.854" cy="9.324" r=".176"/><circle cx="13.646" cy="9.324" r=".176"/><circle cx="12.854" cy="14.324" r=".176"/><circle cx="13.646" cy="14.324" r=".176"/>
<circle cx="15.354" cy="6.824" r=".176"/><circle cx="16.146" cy="6.824" r=".176"/><circle cx="15.354" cy="16.824" r=".176"/><circle cx="16.146" cy="16.824" r=".176"/>
</g>
</svg>
</body></html>"##;

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub(crate) fn splash_data_url() -> String {
    format!(
        "data:text/html;charset=utf-8,{}",
        percent_encode(SPLASH_HTML)
    )
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(crate::tray::MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn close_splash_and_show_main(app: &AppHandle) {
    show_main(app);
    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.close();
    }
}

pub fn setup_splash(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        return Ok(());
    }
    let url =
        tauri::Url::parse(&splash_data_url()).map_err(|e| format!("parse splash data url: {e}"))?;
    WebviewWindowBuilder::new(app, SPLASH_LABEL, WebviewUrl::CustomProtocol(url))
        .title("Klanker")
        .inner_size(360.0, 220.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .center()
        .focused(false)
        .background_color(tauri::utils::config::Color(0, 0, 0, 255))
        .build()
        .map_err(|e| format!("create splash window: {e}"))?;

    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(SPLASH_TIMEOUT);
        let closer = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if closer.get_webview_window(SPLASH_LABEL).is_some() {
                close_splash_and_show_main(&closer);
            }
        });
    });
    Ok(())
}

#[tauri::command]
pub fn close_splash(app: AppHandle) {
    close_splash_and_show_main(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splash_payload_is_embedded_monochrome_and_scriptless() {
        assert!(SPLASH_HTML.contains("background:#000000"));
        assert!(SPLASH_HTML.contains("fill=\"#ffffff\""));
        assert!(SPLASH_HTML.contains("@keyframes pulse"));
        assert!(SPLASH_HTML.contains("<svg"));
        assert!(!SPLASH_HTML.contains("<script"));
        assert!(!SPLASH_HTML.contains("http://") && !SPLASH_HTML.contains("https://"));
    }

    #[test]
    fn splash_data_url_is_encoded_data_html() {
        let url = splash_data_url();
        assert!(url.starts_with("data:text/html;charset=utf-8,"));
        assert!(url.contains("%3Csvg"));
        assert!(!url.contains('<'));
        assert!(!url.contains('#'));
        tauri::Url::parse(&url).unwrap();
    }

    #[test]
    fn percent_encoding_leaves_only_unreserved_ascii() {
        let encoded = percent_encode("<tag a=\"#x\">ä");
        assert_eq!(encoded, "%3Ctag%20a%3D%22%23x%22%3E%C3%A4");
    }
}
