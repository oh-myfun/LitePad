// release 隐藏控制台（debug 保留便于定位启动期错误）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod core;
mod session;

use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .setup(|app| {
            // M2 文件监听：单个全局 watcher，内容变更 → file-changed 事件 → 前端提示
            let handle = app.handle().clone();
            let (tx, rx) = std::sync::mpsc::channel();
            let watcher =
                notify::recommended_watcher(tx).map_err(|e| format!("文件监听初始化失败：{e}"))?;
            if let Some(state) = app.try_state::<commands::AppState>() {
                *state.watcher.lock().map_err(|e| e.to_string())? = Some(watcher);
            }
            std::thread::spawn(move || {
                use notify::EventKind;
                // recommended_watcher 的 channel 传 Result<Event, Error>
                while let Ok(Ok(event)) = rx.recv() {
                    if !matches!(event.kind, EventKind::Modify(_)) {
                        continue;
                    }
                    for path in event.paths {
                        let _ = handle.emit(
                            "file-changed",
                            serde_json::json!({ "path": path.to_string_lossy() }),
                        );
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::new_tab,
            commands::open_file,
            commands::reload_file,
            commands::save_file,
            commands::close_tab,
            commands::list_tabs,
            commands::check_encodable,
            commands::list_encodings,
            commands::list_eols,
            commands::load_settings,
            commands::save_settings,
            commands::log_event,
            commands::frontend_ready,
            commands::load_session,
            commands::save_session,
            commands::search_files,
            commands::export_file,
            commands::save_paste_image,
        ])
        .run(tauri::generate_context!())
        .expect("LitePad 启动失败");
}
