//! klanker provisioning via a downloaded `uv` binary.
//!
//! `uv` is a single static executable — no Python needed on the host.
//! We download a pinned release into `app_data/uv/`, then use it for
//! `uv tool install klanker` / `uv tool upgrade klanker`. Download and
//! checksum verification shell out to system tools (`curl`, `tar`,
//! `certutil`/`shasum`) to keep the crate zero-dep here.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Pinned uv release. Bump deliberately.
const UV_VERSION: &str = "0.9.16";

#[derive(Clone, Debug, Serialize)]
pub struct ProvisionStatus {
    pub uv_path: Option<String>,
    pub klanker_version: Option<String>,
    pub detail: Option<String>,
}

fn silent(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn uv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("uv");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The managed uv binary if downloaded earlier; else uv on PATH.
pub fn uv_bin(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) { "uv.exe" } else { "uv" };
    if let Ok(dir) = uv_dir(app) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    let mut cmd = Command::new("uv");
    cmd.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
    if silent(&mut cmd).status().map(|s| s.success()).unwrap_or(false) {
        return Some(PathBuf::from("uv"));
    }
    None
}

fn uv_target() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

fn download(url: &str, out: &PathBuf) -> Result<(), String> {
    let status = silent(Command::new("curl").args(["-fL", "-o"]))
        .arg(out)
        .arg(url)
        .status()
        .map_err(|e| format!("curl: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("curl exited {status}"))
    }
}

fn sha256_file(path: &PathBuf) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let out = silent(Command::new("certutil").args(["-hashfile"]))
            .arg(path)
            .arg("SHA256")
            .output()
            .map_err(|e| format!("certutil: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().nth(1).unwrap_or("").replace(' ', "");
        if line.len() == 64 {
            return Ok(line.to_lowercase());
        }
        Err("certutil: no sha256".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("shasum")
            .args(["-a", "256"])
            .arg(path)
            .output()
            .map_err(|e| format!("shasum: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        Ok(text.split_whitespace().next().unwrap_or("").to_lowercase())
    }
}

fn unzip(zip: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // bsdtar ships with Windows 10+ and handles zip fine.
        let status = silent(Command::new("tar").args(["-xf"]))
            .arg(zip)
            .arg("-C")
            .arg(dest)
            .status()
            .map_err(|e| format!("tar: {e}"))?;
        if status.success() {
            return Ok(());
        }
        Err(format!("tar exited {status}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("unzip")
            .args(["-o", "-q"])
            .arg(zip)
            .arg("-d")
            .arg(dest)
            .status()
            .map_err(|e| format!("unzip: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("unzip exited {status}"))
        }
    }
}

/// Download the pinned uv release + its sha256, verify, extract.
fn ensure_uv(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(bin) = uv_bin(app) {
        return Ok(bin);
    }
    let dir = uv_dir(app)?;
    let target = uv_target();
    let base = format!(
        "https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-{target}.zip"
    );
    let zip = dir.join("uv.zip");
    download(&base, &zip)?;
    let sum_file = dir.join("uv.sha256");
    download(&format!("{base}.sha256"), &sum_file)?;
    let want = fs::read_to_string(&sum_file)
        .map_err(|e| e.to_string())?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    let got = sha256_file(&zip)?;
    if !want.is_empty() && want != got {
        return Err("uv checksum mismatch — aborted".into());
    }
    unzip(&zip, &dir)?;
    let bin = dir.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    if !bin.is_file() {
        return Err("uv binary missing after extract".into());
    }
    Ok(bin)
}

fn run_uv(bin: &PathBuf, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    let out = silent(&mut cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("uv: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn klanker_version_probe() -> Option<String> {
    for argv in [
        vec!["klanker"],
        vec!["py", "-m", "klanker"],
        vec!["python", "-m", "klanker"],
    ] {
        let mut cmd = Command::new(argv[0]);
        cmd.args(&argv[1..]).arg("--version");
        if let Ok(out) = silent(&mut cmd).stdout(Stdio::piped()).stderr(Stdio::null()).output() {
            if out.status.success() {
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn klanker_version(app: AppHandle) -> Result<ProvisionStatus, String> {
    Ok(ProvisionStatus {
        uv_path: uv_bin(&app).map(|p| p.to_string_lossy().into_owned()),
        klanker_version: klanker_version_probe(),
        detail: None,
    })
}

#[tauri::command]
pub async fn klanker_install(app: AppHandle) -> Result<ProvisionStatus, String> {
    let bin = ensure_uv(&app)?;
    let log = run_uv(&bin, &["tool", "install", "klanker"])?;
    Ok(ProvisionStatus {
        uv_path: Some(bin.to_string_lossy().into_owned()),
        klanker_version: klanker_version_probe(),
        detail: Some(log.lines().last().unwrap_or("installed").to_string()),
    })
}

#[tauri::command]
pub async fn klanker_upgrade(app: AppHandle) -> Result<ProvisionStatus, String> {
    let bin = ensure_uv(&app)?;
    let log = run_uv(&bin, &["tool", "upgrade", "klanker"])?;
    Ok(ProvisionStatus {
        uv_path: Some(bin.to_string_lossy().into_owned()),
        klanker_version: klanker_version_probe(),
        detail: Some(log.lines().last().unwrap_or("upgraded").to_string()),
    })
}
