// release 隐藏控制台（debug 保留便于定位启动期错误）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod commands;
mod core;
mod dropbridge;
mod session;
mod windows;

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

    // 文件关联（首启带参）：双击 .md/.markdown 且当前没有运行中的实例时，单实例插件的
    // on_args 回调不会触发（它只在「已有实例」时把参数转发给主实例），所以这里手动把
    // 启动命令行里的文档塞进待打开队列，交给前端在就绪时取走打开。
    // ⚠️ 已有实例时双击：新进程会探测到主实例后退出，参数经 on_args 转发由主实例处理，
    //    本进程这里的 push 随退出而丢弃，不会重复打开。
    commands::capture_boot_assoc_files();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // 双击关联文件且**应用已在运行**时，Windows 以 `"litepad.exe" "<path>"`
            // 启动新进程；单实例插件把它探测到后转发到这里，挑出应接管的 .md/.markdown
            // 路径入队并通知已运行的主窗口。（首启没有运行中实例、不会走到这里，
            // 那条路径由 `capture_boot_assoc_files` 在 main 启动期补抓。）
            let files = commands::assoc_args_to_open(&argv, &cwd);
            if files.is_empty() {
                return;
            }
            commands::push_pending_files(files.clone());
            // 应用已运行时：拉起主窗口并转发事件（前端据此开新标签）
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            let _ = app.emit("open-file", serde_json::json!({ "paths": files }));
        }))
        .manage(commands::AppState::default())
        // B71 ④ 多窗口：label → 待投递载荷（见 windows 模块头部）
        .manage(windows::WindowRegistry::default())
        // B71 ④：卫星窗口被销毁时，把它的 label 广播出去。
        // 主窗口据此收尾（把它承载的标签接回来）——只靠前端的 onCloseRequested 不够：
        // 进程退出、崩溃、被任务管理器结束都拿不到那个回调，事件是最后一道保险。
        .on_window_event(|win, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            if win.label() == windows::MAIN_LABEL {
                return;
            }
            let app = win.app_handle();
            if let Some(reg) = app.try_state::<windows::WindowRegistry>() {
                reg.forget_pending(win.label());
            }
            let _ = app.emit(
                "satellite-closed",
                serde_json::json!({ "label": win.label() }),
            );
        })
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

            // B91：关掉 wry 的原生拖放处理器（`dragDropEnabled: false`）之后，文件拖入的
            // 真实路径由这条桥补回来（原理见 `dropbridge` 模块头）。每个窗口都要装 ——
            // 文件落在哪个窗口上，就是那个窗口的 webview 收到 drop。
            dropbridge::install(app.handle(), windows::MAIN_LABEL);

            // B72 启动自检：记一行「实际生效的 WebView2 附加浏览器参数」。
            // 这组参数必须被**所有**窗口照抄 —— 共用同一用户数据目录时 EnvironmentOptions
            // 不一致会让新建 WebView 直接失败（见 `windows::pick_browser_args`），而这类
            // 不一致在界面上只表现为「新窗口没能打开」，没有别的线索。落一行日志，
            // 下次出问题一条命令就能定位（`%TEMP%\litepad-smoke.log`）。
            commands::smoke_log(&format!(
                "browser args = {:?}",
                windows::shared_browser_args(app.handle())
            ));

            // M2 文件监听：单个全局 watcher，内容变更 → file-changed 事件 → 前端刷新/弹冲突。
            //
            // ⚠️ 事件里带的是 **tabId + 磁盘版本号（mtime+size）**，不是路径：
            //   1) 路径匹配本来就脆 —— 监听用的是 `fs::canonicalize` 之后的，
            //      `doc.path` 却可能是用户给的原始写法，两端对不上就永远收不到事件；
            //   2) 版本号是前端抑制回声的唯一依据（自己保存也会激起事件）。
            // 于是匹配在这里一次性做完（Rust 持有全部 doc），前端只认 tabId。
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
                        // 事件路径也要规范化：它与监听时登记的那条必须是同一种写法才比得出来
                        let norm = std::fs::canonicalize(&path).unwrap_or(path.clone());
                        let Some(state) = handle.try_state::<commands::AppState>() else {
                            continue;
                        };
                        let tab_id = {
                            let Ok(guard) = state.docs.lock() else {
                                continue;
                            };
                            match guard
                                .iter()
                                .find(|d| !d.path.as_os_str().is_empty() && d.path == norm)
                            {
                                Some(d) => d.id,
                                None => continue,
                            }
                        };
                        let (mtime_ms, size) = commands::disk_version(&norm);
                        let _ = handle.emit(
                            "file-changed",
                            serde_json::json!({
                                "tabId": tab_id,
                                "mtimeMs": mtime_ms,
                                "size": size,
                            }),
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
            commands::write_backup,
            commands::restore_backup,
            commands::discard_backup,
            commands::discard_orphan_backups,
            commands::export_file,
            commands::save_paste_image,
            commands::take_pending_files,
            windows::window_payload,
            windows::open_satellite_window,
        ])
        .run(tauri::generate_context!())
        .expect("LitePad 启动失败");
}
