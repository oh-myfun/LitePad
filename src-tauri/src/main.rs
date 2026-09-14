// release 隐藏控制台（debug 保留便于定位启动期错误）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod core;
mod session;

use tauri::window::Color;
use tauri::{Emitter, Manager, Theme};

// WebView2 渲染出第一帧之前的窗口底色（B50 启动白屏）。
//
// Chromium 默认一律用纯白填充这块区域，深色主题下就表现为「启动先白屏一下」。
// 取值必须与 `src/styles/global.css` 的 `--bg` 一致（深浅两套），改样式时一起改。
// `tauri.conf.json` 的 `backgroundColor` 是创建窗口时的兜底值（同样是深色），
// 这里在 setup 阶段再按用户设置纠正一次。
const BG_DARK: Color = Color(0x1b, 0x1d, 0x1f, 0xff);
const BG_LIGHT: Color = Color(0xff, 0xff, 0xff, 0xff);

/// 解析「该用哪套底色」：`theme=system` 时跟随系统，取不到就按浅色（Windows 默认）走。
fn boot_background(win: &tauri::WebviewWindow) -> Color {
    let dark = match session::load().theme.as_str() {
        "dark" => true,
        "light" => false,
        _ => matches!(win.theme(), Ok(Theme::Dark)),
    };
    if dark {
        BG_DARK
    } else {
        BG_LIGHT
    }
}

fn main() {
    // 启动计时基准（端到端耗时诊断用）
    let _ = commands::BOOT.set(std::time::Instant::now());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .setup(|app| {
            // B50 启动白屏：WebView2 渲染出第一帧之前，窗口客户区由 Chromium 用
            // 纯白填充，深色主题下就是「启动先白屏一下」。这里把预渲染底色刷成
            // 界面背景色：窗口一出现就是主题色，前端画出第一帧后无缝接管。
            //
            // 为什么不用「visible:false + 前端就绪后 show()」：那样窗口是否出现
            // 完全取决于前端能否跑完 bootstrap。一旦前端卡住/崩掉（实测出现过：
            // IPC 正常、界面却始终画不出来），用户就是「点了图标什么都没有」，
            // 比白屏严重得多。底色方案窗口永远在、永远不是白板。
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_background_color(Some(boot_background(&win)));
            }

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
            commands::export_file,
            commands::save_paste_image,
        ])
        .run(tauri::generate_context!())
        .expect("LitePad 启动失败");
}
