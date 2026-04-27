#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                app.get_webview_window("main").unwrap().open_devtools();
            }
            // Icona finestra diversa dall'icona app/desktop
            {
                use tauri::Manager;
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
