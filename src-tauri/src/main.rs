// TextForge desktop (Tauri 2). The Rust side of `window.api`; the JavaScript side is tauri-api.js.
// It mirrors main.js (Electron): the same file reading, encodings, limits and Copilot rules.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::Response;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl, Window};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAX_BYTES: u64 = 500 * 1024 * 1024; // JavaScript strings top out near 512 million characters
const SAMPLE_LOG: &str = include_str!("../../samples/order-service.log");
const COPILOT: &str = "copilot";
// Same browser switches Tauri uses by default, plus a bigger JavaScript heap for big logs.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --js-flags=--max-old-space-size=6144";

// ---------- encoding ----------
fn decode(buf: &[u8]) -> Result<(String, &'static str), String> {
    if buf.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Ok((String::from_utf8_lossy(&buf[3..]).into_owned(), "utf8-bom"));
    }
    if buf.starts_with(&[0xff, 0xfe]) || buf.starts_with(&[0xfe, 0xff]) {
        let le = buf[0] == 0xff;
        let units: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        return Ok((String::from_utf16_lossy(&units), "utf16le"));
    }
    if buf[..buf.len().min(8000)].contains(&0) {
        return Err("This looks like a binary file, not text.".into());
    }
    match std::str::from_utf8(buf) {
        Ok(s) => Ok((s.to_owned(), "utf8")),
        Err(_) => Ok((buf.iter().map(|&b| b as char).collect(), "latin1")),
    }
}

fn encode(content: &str, enc: &str) -> Vec<u8> {
    match enc {
        "utf8-bom" => [&[0xef, 0xbb, 0xbf][..], content.as_bytes()].concat(),
        "utf16le" => {
            let mut out = vec![0xff, 0xfe];
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            out
        }
        "latin1" => content.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).collect(),
        _ => content.as_bytes().to_vec(),
    }
}

/// File contents go to the page as raw bytes (no JSON), in the form `<encoding>\n<UTF-8 text>`.
fn read_text(path: &str) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err("File is larger than 500 MB. Split it first (for example with a log rotation tool or: split -l 2000000).".into());
    }
    let buf = fs::read(path).map_err(|e| e.to_string())?;
    let (text, enc) = decode(&buf)?;
    let mut out = Vec::with_capacity(text.len() + 12);
    out.extend_from_slice(enc.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(text.as_bytes());
    Ok(out)
}

// ---------- files ----------
// Commands without `async` run on the window's own thread, so anything that touches the disk is async
// and does its work on a background thread: the window keeps responding while a 400 MB log loads.
async fn background<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(f).await.expect("background task failed")
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    background(move || read_text(&path).map(Response::new)).await
}

#[derive(Serialize)]
struct Stat {
    ok: bool,
    size: u64,
    mtime: f64,
    reason: Option<&'static str>,
}

#[tauri::command]
async fn stat(path: String) -> Stat {
    background(move || stat_sync(&path)).await
}
fn stat_sync(path: &str) -> Stat {
    match fs::metadata(path) {
        Ok(m) => Stat {
            ok: true,
            size: m.len(),
            mtime: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0),
            reason: None,
        },
        Err(e) => Stat {
            ok: false,
            size: 0,
            mtime: 0.0,
            reason: Some(if e.kind() == std::io::ErrorKind::NotFound { "missing" } else { "error" }),
        },
    }
}

/// Bytes appended after `offset` (live tail and reloads of growing logs), as
/// `<file size> <bytes read>\n<text>`. The byte count lets the caller continue exactly where this stopped.
#[tauri::command]
async fn read_from(path: String, offset: u64) -> Result<Response, String> {
    background(move || read_from_sync(&path, offset)).await
}
fn read_from_sync(path: &str, offset: u64) -> Result<Response, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let len = size.saturating_sub(offset).min(50 * 1024 * 1024);
    let mut buf = vec![0u8; len as usize];
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let mut out = format!("{size} {len}\n").into_bytes();
    out.extend_from_slice(text.as_bytes());
    Ok(Response::new(out))
}

#[derive(Serialize)]
struct SaveResult {
    ok: bool,
    path: Option<String>,
    error: Option<String>,
    canceled: bool,
    moved: bool,
}
impl SaveResult {
    fn ok(path: String) -> Self {
        Self { ok: true, path: Some(path), error: None, canceled: false, moved: false }
    }
    fn err(e: impl ToString) -> Self {
        Self { ok: false, path: None, error: Some(e.to_string()), canceled: false, moved: false }
    }
}

#[tauri::command]
async fn save_file(path: String, content: String, enc: String) -> SaveResult {
    background(move || match fs::write(&path, encode(&content, &enc)) {
        Ok(_) => SaveResult::ok(path),
        Err(e) => SaveResult::err(e),
    })
    .await
}

#[tauri::command]
async fn save_as(app: AppHandle, default_path: Option<String>, content: String, enc: String) -> SaveResult {
    let mut dlg = app.dialog().file();
    if let Some(dp) = default_path.filter(|s| !s.is_empty()) {
        let p = PathBuf::from(&dp);
        if let Some(name) = p.file_name() {
            dlg = dlg.set_file_name(name.to_string_lossy());
        }
        if let Some(dir) = p.parent().filter(|d| d.is_absolute()) {
            dlg = dlg.set_directory(dir);
        }
    }
    let Some(target) = dlg.blocking_save_file().and_then(|f| f.into_path().ok()) else {
        return SaveResult { canceled: true, ..SaveResult::err("") };
    };
    match fs::write(&target, encode(&content, &enc)) {
        Ok(_) => SaveResult::ok(target.to_string_lossy().into_owned()),
        Err(e) => SaveResult::err(e),
    }
}

#[tauri::command]
async fn rename_file(path: String, name: String) -> SaveResult {
    background(move || rename_sync(path, name)).await
}
fn rename_sync(path: String, name: String) -> SaveResult {
    let bad = name.is_empty() || name.chars().any(|c| "\\/:*?\"<>|".contains(c)) || name.chars().all(|c| c == '.');
    if bad {
        return SaveResult::err("That name has characters a file name cannot use.");
    }
    let src = PathBuf::from(&path);
    let target = src.with_file_name(&name);
    if target == src {
        return SaveResult::ok(path);
    }
    let same_other_case = target.to_string_lossy().to_lowercase() == path.to_lowercase();
    if !same_other_case && target.exists() {
        return SaveResult::err(format!("{name} already exists in that folder."));
    }
    match fs::rename(&src, &target) {
        Ok(_) => SaveResult { moved: true, ..SaveResult::ok(target.to_string_lossy().into_owned()) },
        Err(e) => SaveResult::err(e),
    }
}

#[derive(Serialize)]
struct Picked {
    path: String,
    size: u64,
}

#[tauri::command]
async fn open_dialog(app: AppHandle) -> Vec<Picked> {
    let files = app.dialog().file().blocking_pick_files().unwrap_or_default();
    files
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| Picked { size: fs::metadata(&p).map(|m| m.len()).unwrap_or(0), path: p.to_string_lossy().into_owned() })
        .collect()
}

fn file_args(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| Path::new(a).is_file())
        .map(|a| fs::canonicalize(a).map(|p| strip_unc(&p)).unwrap_or_else(|_| a.clone()))
        .collect()
}
fn strip_unc(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

#[tauri::command]
fn startup_files() -> Vec<String> {
    file_args(&std::env::args().collect::<Vec<_>>())
}

#[tauri::command]
fn sample() -> String {
    SAMPLE_LOG.to_string()
}

// ---------- session ----------
fn session_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("session.json"))
}

#[tauri::command]
async fn load_session(app: AppHandle) -> Option<String> {
    background(move || fs::read_to_string(session_path(&app)?).ok()).await
}

#[tauri::command]
async fn save_session(app: AppHandle, data: String) -> bool {
    background(move || session_path(&app).map(|p| fs::write(p, data).is_ok()).unwrap_or(false)).await
}

// ---------- clipboard, links ----------
#[tauri::command]
fn clipboard_write(app: AppHandle, text: String, html: Option<String>) -> bool {
    let cb = app.clipboard();
    match html {
        Some(h) if !h.is_empty() => cb.write_html(h, Some(text)).is_ok(),
        _ => cb.write_text(text).is_ok(),
    }
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) {
    if url.to_ascii_lowercase().starts_with("https://") {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

// ---------- embedded Copilot (a second webview inside the main window) ----------
// It has its own profile folder, so its sign-in is kept between restarts and "Sign out" can wipe it
// without touching TextForge's own settings. It gets no access to TextForge's commands (see capabilities).
fn sign_in_host(host: &str) -> bool {
    const HOSTS: [&str; 13] = [
        "microsoft.com", "microsoftonline.com", "live.com", "office.com", "office.net", "cloud.microsoft",
        "microsoft365.com", "sharepoint.com", "bing.com", "msauth.net", "msftauth.net", "windows.net", "azure.com",
    ];
    let host = host.to_ascii_lowercase();
    HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

fn copilot_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("copilot"))
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

// Creating a webview from a command that runs on the window's thread deadlocks on Windows, so this is async.
#[tauri::command]
async fn copilot_show(app: AppHandle, window: Window, url: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(COPILOT) {
        wv.set_bounds(rect(x, y, w, h)).map_err(|e| e.to_string())?;
        return wv.show().map_err(|e| e.to_string());
    }
    let parsed: tauri::Url = url.parse().map_err(|_| "Bad Copilot address".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Copilot must be an https address".into());
    }
    let opener = app.clone();
    let mut b = WebviewBuilder::new(COPILOT, WebviewUrl::External(parsed))
        .additional_browser_args(BROWSER_ARGS)
        .on_new_window(move |u, _features| {
            if u.host_str().map(sign_in_host).unwrap_or(false) {
                return NewWindowResponse::Allow; // sign-in popups
            }
            if u.scheme() == "https" {
                let _ = opener.opener().open_url(u.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        });
    if let Some(dir) = copilot_dir(&app) {
        b = b.data_directory(dir);
    }
    window
        .add_child(b, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn copilot_bounds(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    if let Some(wv) = app.get_webview(COPILOT) {
        let _ = wv.set_bounds(rect(x, y, w, h));
    }
}

#[tauri::command]
async fn copilot_hide(app: AppHandle) {
    if let Some(wv) = app.get_webview(COPILOT) {
        let _ = wv.hide();
    }
}

#[tauri::command]
async fn copilot_reload(app: AppHandle) {
    if let Some(wv) = app.get_webview(COPILOT) {
        let _ = wv.eval("location.reload()");
    }
}

/// Put a prompt into Copilot's message box. The user still presses Enter.
#[tauri::command]
async fn copilot_insert(app: AppHandle, text: String) -> bool {
    let Some(wv) = app.get_webview(COPILOT) else { return false };
    let _ = wv.set_focus();
    let js = format!(
        r#"(() => {{
  const c = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter((e) => {{ const r = e.getBoundingClientRect(); return r.width > 120 && r.height > 14; }});
  const el = c.find((e) => /ask|message|chat|prompt|copilot|type/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || ''))) || c[c.length - 1];
  if (!el) return false;
  el.focus();
  return document.execCommand('insertText', false, {});
}})()"#,
        serde_json::to_string(&text).unwrap_or_default()
    );
    let (tx, rx) = mpsc::channel();
    if wv.eval_with_callback(js, move |r| { let _ = tx.send(r); }).is_err() {
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(3)))
        .await
        .ok()
        .and_then(|r| r.ok())
        .map(|r| r.trim() == "true")
        .unwrap_or(false)
}

/// Forget the Copilot sign-in (cookies and site data of the embedded Copilot only).
#[tauri::command]
async fn copilot_sign_out(app: AppHandle) -> bool {
    if let Some(wv) = app.get_webview(COPILOT) {
        let _ = wv.clear_all_browsing_data();
        let _ = wv.close();
        return true;
    }
    copilot_dir(&app).map(|d| !d.exists() || fs::remove_dir_all(d).is_ok()).unwrap_or(false)
}

// ---------- app ----------
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let files = file_args(&argv);
            if !files.is_empty() {
                let _ = app.emit_to("main", "open-paths", files);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // One window with two webviews: TextForge itself, and Copilot when it is opened.
            let win = tauri::window::WindowBuilder::new(app, "main")
                .title("TextForge")
                .inner_size(1200.0, 780.0)
                .min_inner_size(640.0, 400.0)
                .decorations(false)
                .background_color(tauri::window::Color(0x1a, 0x20, 0x29, 0xff))
                .build()?;
            let size = win.inner_size()?.to_logical::<f64>(win.scale_factor()?);
            let main = WebviewBuilder::new("main", WebviewUrl::App("index.html".into()))
                .additional_browser_args(BROWSER_ARGS)
                .disable_drag_drop_handler() // keeps HTML drag and drop working (tabs, snap layouts)
                .auto_resize();
            win.add_child(main, LogicalPosition::new(0.0, 0.0), size)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file, stat, read_from, save_file, save_as, rename_file, open_dialog, startup_files, sample,
            load_session, save_session, clipboard_write, open_external,
            copilot_show, copilot_bounds, copilot_hide, copilot_reload, copilot_insert, copilot_sign_out
        ])
        .run(tauri::generate_context!())
        .expect("error while running TextForge");
}
