//! B91：WebView2 文件拖入路径桥。
//!
//! ## 为什么需要它
//!
//! Windows 上 wry 的拖放处理器（`tauri.conf.json` 的 `dragDropEnabled`）会做两处劫持
//! （wry-0.55.1 源码位置与原文注释）：
//!
//! 1. `src/webview2/mod.rs`：`controller.SetAllowExternalDrop(false)` —— 注释原文是
//!    *"Disable file drops, so our handler can capture it"*。**这一刀才是页面内 HTML5
//!    拖放全废的真凶**：Chromium 直接拒绝一切 OLE 拖放，连自己发起的内部拖拽也一起废掉。
//! 2. `src/webview2/drag_drop.rs`：`EnumChildWindows` 遍历子窗口，逐个 `RevokeDragDrop`
//!    + `RegisterDragDrop`，把 WebView2 自己的拖放目标换成 wry 的；而 wry 的 target 只认
//!    `CF_HDROP`（`iterate_filenames` 取不到就回 `DROPEFFECT_NONE`）。
//!
//! 两条合起来就是一个窗口级二选一：**页面内拖放**（标签拖拽要的）或**文件真实路径**
//! （B24 要的，可写、可监听、可保存）。关掉 `dragDropEnabled` 能拿回前者，代价是后者。
//!
//! ## 桥怎么把路径补回来
//!
//! WebView2 有一条官方出口，不需要自研 CF_HDROP、也不需要全局鼠标钩子：页面把 drop 拿到
//! 的 `File` 对象原样交回宿主 —— `window.chrome.webview.postMessageWithAdditionalObjects`；
//! 宿主在 `WebMessageReceived` 里取 `ICoreWebView2WebMessageReceivedEventArgs2::
//! AdditionalObjects()`，把里面的对象 cast 成 `ICoreWebView2File`，`.Path()` 就是真实路径。
//!
//! 所以本模块是**关掉 wry 处理器之后的替代品**：事件名与载荷刻意与 Tauri 原生逐字一致
//! （`tauri://drag-drop` + `{ paths, position }`，`position` 同样是**物理像素**），
//! 前端 `onDragDropEvent` 的 drop 分支因此不用改一行（坐标换算 `dropPosOf` 也照旧）。
//!
//! ⚠️ 依赖较新的 WebView2 运行时（`AdditionalObjects` / `ICoreWebView2File` 是 2023 年那批
//! API）。拿不到时会表现为「文件拖进来了但没反应」；前端检测不到出口时会记一行日志。
//!
//! ⚠️ 不要改成「转发给 wry 的 target」：wry 那套是 `RevokeDragDrop` 抢来的独占目标，
//! 与页面内 HTML5 拖放互斥，正是我们要摆脱的东西。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs,
        ICoreWebView2WebMessageReceivedEventArgs2,
    },
    WebMessageReceivedEventHandler,
};
use windows::core::{Interface, PWSTR};

/// 前端往桥上打的消息标记（消息体是 JSON，见 `BridgeMessage`）。
pub const MSG_TAG: &str = "__litepad_file_drop__";

/// 与 Tauri 原生同名：前端 `onDragDropEvent` 直接复用，不必知道桥的存在。
const DRAG_DROP_EVENT: &str = "tauri://drag-drop";

/// 桥收到的消息体。
///
/// `x` / `y` 是**物理像素**（页面按 `devicePixelRatio` 换算后传上来）——与 Tauri 原生拖放
/// 事件的口径保持一致，前端那套 `dropPosOf` 换算才能原样复用。
#[derive(Deserialize)]
struct BridgeMessage {
    tag: String,
    x: f64,
    y: f64,
}

#[derive(Serialize, Clone)]
struct DropPayload {
    paths: Vec<String>,
    position: Position,
}

#[derive(Serialize, Clone)]
struct Position {
    x: f64,
    y: f64,
}

/// 给某个窗口的 webview 装上路径桥。
///
/// 每个窗口都要装（主窗口与每个卫星窗口）：drop 是落在具体那个窗口上的。
/// 窗口还没建好时静默返回 —— 调用点在建窗之后，正常运行不会走到那个分支。
pub fn install<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let app = app.clone();
    let label = label.to_string();
    let _ = win.with_webview(move |platform_webview| {
        // SAFETY: with_webview 的回调在主线程、且 webview 已建好；controller 由 Tauri 持有。
        let Ok(webview) = (unsafe { platform_webview.controller().CoreWebView2() }) else {
            return;
        };
        register(&webview, app, label);
    });
}

/// 在 WebView2 上挂 web message 监听。**只加不删**：窗口销毁时 WebView2 自己回收。
fn register<R: Runtime>(webview: &ICoreWebView2, app: AppHandle<R>, label: String) {
    let mut token = 0;
    // SAFETY: 事件回调在 WebView2 的 UI 线程上同步触发，闭包只捕获 Send 的 AppHandle 与 label。
    let _ = unsafe {
        webview.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    dispatch(&app, &label, &args);
                }
                Ok(())
            })),
            &mut token,
        )
    };
}

/// 判断这条 web message 是不是桥的消息；是就取出路径并原样 emit 出去。
///
/// 注意：Tauri 自己的 ipc 处理器也会收到**同一条**消息（wry 转发 web message 时不区分
/// 来源），它解析失败会在页面控制台留一行 JSON 报错 —— 只是噪音，不影响本桥。
fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    args: &ICoreWebView2WebMessageReceivedEventArgs,
) {
    let Some(message) = message_of(args) else {
        return;
    };
    let Ok(message) = serde_json::from_str::<BridgeMessage>(&message) else {
        return;
    };
    if message.tag != MSG_TAG {
        return;
    }
    let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() else {
        return;
    };
    let paths = paths_of(&args2);
    if paths.is_empty() {
        return;
    }
    let payload = DropPayload {
        paths,
        position: Position {
            x: message.x,
            y: message.y,
        },
    };
    // 与 Tauri 原生一致：发到「该 label 的所有目标」（窗口与其 webview 都收得到）。
    let _ = app.emit_to(
        EventTarget::AnyLabel {
            label: label.to_string(),
        },
        DRAG_DROP_EVENT,
        payload,
    );
}

fn message_of(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Option<String> {
    let mut raw = PWSTR::null();
    // SAFETY: 只在这一条消息的生命周期内读指针，读完立刻转成 String。
    unsafe { args.TryGetWebMessageAsString(&mut raw) }.ok()?;
    // SAFETY: PWSTR::to_string 读到 NUL 为止；上面的 API 保证给的是以 NUL 结尾的串。
    unsafe { raw.to_string() }.ok()
}

/// 把 `AdditionalObjects` 里的 `File` 逐个还原成路径。
///
/// 非文件对象（比如拖进来一段文本）cast 不成 `ICoreWebView2File`，直接跳过 ——
/// 那种情况由页面内的 HTML5 拖放自己处理，与 B24 的「拖文件进来打开」无关。
fn paths_of(args: &ICoreWebView2WebMessageReceivedEventArgs2) -> Vec<String> {
    let mut paths = Vec::new();
    // SAFETY: 集合索引都在 Count 范围内取；每个对象只在本次循环内使用。
    let Ok(objects) = (unsafe { args.AdditionalObjects() }) else {
        return paths;
    };
    let mut count = 0u32;
    if unsafe { objects.Count(&mut count) }.is_err() {
        return paths;
    }
    for i in 0..count {
        let Ok(value) = (unsafe { objects.GetValueAtIndex(i) }) else {
            continue;
        };
        let Ok(file) = value.cast::<ICoreWebView2File>() else {
            continue;
        };
        let mut path = PWSTR::null();
        if unsafe { file.Path(&mut path) }.is_err() {
            continue;
        }
        // SAFETY: 同 message_of：API 给的路径串以 NUL 结尾，只读一次。
        if let Ok(path) = unsafe { path.to_string() } {
            if !path.is_empty() {
                paths.push(path);
            }
        }
    }
    paths
}
