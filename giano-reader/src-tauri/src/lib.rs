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
    let guard = state.handle.lock().unwrap();
    guard.as_ref().map(|h| {
        let display_ip = h.lan_ip.unwrap_or(Ipv4Addr::LOCALHOST);
        let url = format!("http://{}:{}", display_ip, h.port);
        ServerInfo {
            port: h.port,
            lan_url: url.clone(),
            qr_url: url,
        }
    })
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
            start_web_server,
            stop_web_server,
            get_server_status
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

            let app_state = Arc::new(AppState {
                library_path,
                store,
            });
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
