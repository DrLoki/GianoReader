use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};

use sysinfo::System;
use tauri::Manager;

mod web_server;

use web_server::handlers::books::AppState;
use web_server::models::{ServerInfo, ServerState};
use web_server::persistence::PersistenceStore;

#[tauri::command]
fn get_system_ram() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.total_memory() / 1_048_576 // byte → MB
}

/// Translates a single pre-batched text chunk using the free Google Translate
/// endpoint from the Rust backend (via `reqwest`), bypassing the webview's
/// CORS restrictions that apply to `fetch()` calls made directly from the
/// frontend. The frontend (`src/translator.js`) already handles chunk
/// batching/splitting and paragraph realignment, so this command performs a
/// single raw translation request and returns the raw translated string.
#[tauri::command]
async fn translate_free(
    text: String,
    source_lang: String,
    target_lang: String,
) -> Result<String, String> {
    web_server::translator::translate_chunk_raw(&text, &source_lang, &target_lang)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_web_server(
    port: u16,
    state: tauri::State<'_, ServerState>,
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Result<ServerInfo, String> {
    println!("[start_web_server] Command invoked with port {}", port);
    let result = web_server::start(port, &state, app_state.inner().clone()).await;
    match &result {
        Ok(info) => println!("[start_web_server] Server started successfully: {:?}", info.lan_url),
        Err(e) => eprintln!("[start_web_server] Failed to start server: {}", e),
    }
    result
}

#[tauri::command]
async fn stop_web_server(
    state: tauri::State<'_, ServerState>,
) -> Result<(), String> {
    web_server::stop(&state).await
}

#[tauri::command]
fn get_server_status(
    state: tauri::State<'_, ServerState>,
) -> Option<ServerInfo> {
    let mut guard = state.handle.lock().unwrap();
    // The server task ends on its own if axum fails: report it as stopped.
    if guard.as_ref().map_or(false, |h| h.server_task.is_finished()) {
        *guard = None;
    }
    guard.as_ref().map(|h| {
        let display_ip = h.lan_ip.unwrap_or(Ipv4Addr::LOCALHOST);
        let lan_url = format!("http://{}:{}", display_ip, h.port);
        let qr_url = h.hostname_url.as_ref().unwrap_or(&lan_url).clone();
        ServerInfo {
            port: h.port,
            lan_url,
            hostname_url: h.hostname_url.clone(),
            qr_url,
        }
    })
}

/// Sets the Web Server secrets (access password and Google Cloud API key).
/// This is the only way to change them: the HTTP API rejects these fields so a
/// LAN client cannot remove the password or replace the key. `None` leaves a
/// value unchanged; an empty string clears it. Works whether or not the server
/// is running, since it writes straight to the persistence store.
#[tauri::command]
fn set_web_server_secrets(
    password: Option<String>,
    gcloud_api_key: Option<String>,
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    web_server::handlers::prefs::set_secrets(&app_state.store, password, gcloud_api_key)
}

/// Validates a URL before handing it to the OS: only absolute http(s) URLs with
/// a host are accepted, and the normalised (percent-encoded) form is returned.
/// The URL can come from links inside an untrusted EPUB.
fn validate_external_url(url: &str) -> Result<String, String> {
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Invalid URL".to_string());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().map_or(false, |h| !h.is_empty()) => {
            Ok(parsed.to_string())
        }
        _ => Err("Only http(s) URLs can be opened".to_string()),
    }
}

#[tauri::command]
fn open_browser_url(url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    #[cfg(target_os = "windows")]
    {
        // Not `cmd /C start`: cmd.exe would interpret `&`, `|`, `^` in the URL
        // as shell operators (command injection from a crafted EPUB link).
        // rundll32 receives the URL as a plain argument, with no shell parsing.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_system_ram,
            translate_free,
            start_web_server,
            stop_web_server,
            get_server_status,
            set_web_server_secrets,
            open_browser_url
        ])
        .setup(|app| {
            // Initialize ServerState (empty — no server running yet)
            let server_state = ServerState {
                handle: Arc::new(Mutex::new(None)),
            };
            app.manage(server_state);

            // Initialize AppState with library path and persistence store
            let app_data_dir = app.path().app_local_data_dir().map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to resolve app local data dir: {}", e),
                )) as Box<dyn std::error::Error>
            })?;

            // Ensure the app data directory exists
            std::fs::create_dir_all(&app_data_dir).map_err(|e| {
                Box::new(e) as Box<dyn std::error::Error>
            })?;

            let library_path = app_data_dir.join("library");
            std::fs::create_dir_all(&library_path).map_err(|e| {
                Box::new(e) as Box<dyn std::error::Error>
            })?;

            let store = PersistenceStore::open(app_data_dir).map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Failed to open persistence store: {}", e),
                )) as Box<dyn std::error::Error>
            })?;

            let app_state = Arc::new(AppState::new(library_path, store));
            app.manage(app_state);

            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            // In release builds, open DevTools if launched with --dev flag
            #[cfg(not(debug_assertions))]
            {
                if std::env::args().any(|a| a == "--dev") {
                    if let Some(win) = app.get_webview_window("main") {
                        win.open_devtools();
                    }
                }
            }
            // Custom window icon
            {
                use image::ImageReader;
                use std::io::Cursor;
                if let Some(win) = app.get_webview_window("main") {
                    let bytes = include_bytes!("../icons/windows-icon.png");
                    let img = ImageReader::new(Cursor::new(bytes))
                        .with_guessed_format()
                        .unwrap()
                        .decode()
                        .unwrap()
                        .into_rgba8();
                    let (w, h) = img.dimensions();
                    let icon = tauri::image::Image::new_owned(img.into_raw(), w, h);
                    let _ = win.set_icon(icon);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Errore avvio applicazione");
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;

    #[test]
    fn accepts_plain_http_urls() {
        assert_eq!(
            validate_external_url("https://example.com/a?x=1&y=2").unwrap(),
            "https://example.com/a?x=1&y=2"
        );
        assert!(validate_external_url("http://example.com").is_ok());
    }

    #[test]
    fn rejects_non_http_schemes_and_shell_tricks() {
        for bad in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "ms-settings:",
            "calc.exe",
            "https://example.com/ &calc",
            "https://example.com/\n",
            "",
        ] {
            assert!(validate_external_url(bad).is_err(), "accepted: {:?}", bad);
        }
    }

    #[test]
    fn quotes_are_percent_encoded() {
        let url = validate_external_url("https://example.com/?q=\"x\"").unwrap();
        assert!(!url.contains('"'), "{}", url);
    }
}
