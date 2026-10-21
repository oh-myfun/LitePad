//! B305 · 最近打开的 IPC 层：名单的唯一写点。
//!
//! ⚠️ 名单**只有这一处会改**（`note` 这一个口子），改完一律走 `publish`：落盘 + 广播 +
//! 回传当前条目三件事同处。窗口身份取 `window.label()`（Rust 侧自证），不接受前端传来的
//! `from` —— 前端那个字段是自证的，本模块不需要它。
//!
//! B308：语义是「**打开过就在册，以 LRU 维护**」（用户口径，覆盖了旧版「只放已关掉的」）。
//! 记账的输入是「**用户打开了一份文件**」这个动作本身（`note_opened(path)` 一次一发），
//! 不是「某条路径从可见集合里冒出来」那个结果 —— 后者会把会话恢复也记成一次打开，
//! 而用户明确裁决「恢复不算打开」。名单里因此可以同时躺着正开着的文件，
//! 重新打开只是把它顶到最前，而不是把它划掉。

use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::core::logging::{self, Level};
use crate::session::recent::{self, key_of, touch_opened, RecentEntry, RecentKind, Recents};

/// 广播名。**必须与前端 `src/core/events.ts` 的 `EVT_RECENTS_CHANGED` 一字不差** ——
/// 事件名跨语言拼错不会有任何报错，只会表现为「名单不刷新」（`tests/recents-ipc.test.ts` 钉这条）。
const EVT_RECENTS_CHANGED: &str = "recents-changed";

/// 取锁。中毒（持有者 panic 过）时继续用：名单坏了顶多记错一条，把进程 panic 在关窗
/// 那一刻是可接受的代价的反面 —— 关窗链上一次 panic 会连带丢掉会话落盘。
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn entries_of(state: &AppState) -> Vec<RecentEntry> {
    lock(&state.recents).entries.clone()
}

/// 落盘 + 广播 + 回传当前条目。**写盘失败不许把界面卡住**：只记一条 warn
/// （与 `session::save` 同口径），内存里那份照样是对的，下一次变更会再试一次。
fn publish(app: &AppHandle, state: &AppState) -> Vec<RecentEntry> {
    let file = lock(&state.recents).clone();
    if let Err(e) = recent::save(&file) {
        logging::log(Level::Warn, "recents", &format!("名单写盘失败：{e}"));
    }
    let _ = app.emit(
        EVT_RECENTS_CHANGED,
        serde_json::json!({ "entries": &file.entries }),
    );
    file.entries
}

/// 改名单的唯一入口：`mutate` 返回「是否真变了」，没变就不写盘、不广播
/// （否则一次无意义的同步就能把用户的日志刷满）。
fn note(
    app: &AppHandle,
    state: &AppState,
    what: &str,
    mutate: impl FnOnce(&mut Recents) -> bool,
) -> Vec<RecentEntry> {
    let changed = {
        let mut r = lock(&state.recents);
        let before = r.entries.len();
        let changed = mutate(&mut r);
        if changed {
            logging::log(
                Level::Info,
                "recents",
                &format!(
                    "{what}：{before} 条 → {} 条（上限 {}）",
                    r.entries.len(),
                    r.limit
                ),
            );
        }
        changed
    };
    if changed {
        publish(app, state)
    } else {
        entries_of(state)
    }
}

/// 用户打开了一份文件 ⇒ 记一笔（LRU 顶到最前）。
///
/// ⚠️ 记入源是**打开这个动作**，不是「某条路径从可见集合里冒出来」：会话恢复同样会让文件
/// 冒出来，可没人打开它（用户裁决「恢复不算打开」）。前端那条唯一的打开漏斗是 `doOpen`
/// （文件对话框、拖放、文件关联、点名单那一行、设置页打开日志都从那儿走），而恢复走
/// `session/rebuild` 直接调 `open_file`，压根不经那一扇 —— 语义对了就不需要「启动首报只登记」
/// 那种时间窗或旗标，也不需要有 per-window 的上一份账来算差集。
///
/// 显示路径用调用方给的那一条（`doOpen` 传的是 Rust 自己回的那条，已归一化）；
/// 身份键在 `touch_opened` 里现算，与名单里既有条目同一口径比。
#[tauri::command]
pub fn note_opened(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    kind: RecentKind,
) -> Vec<RecentEntry> {
    let label = window.label().to_string();
    logging::log(
        Level::Info,
        "recents",
        &format!("{label} 打开 {path}（{kind:?}）"),
    );
    let now = now_ms();
    note(&app, &state, "记录打开", |r| {
        touch_opened(r, &[(key_of(&path), path)], kind, now)
    })
}

/// 列名单。顺手把磁盘上已经不存在的条目剔掉并落盘 —— 这是「文件被外部删除/挪走 ⇒
/// 自动不见」的唯一出口，渲染端不再判存在性（多判一次就多一处与 Rust 不一致的机会）。
#[tauri::command]
pub fn list_recents(app: AppHandle, state: State<'_, AppState>) -> Vec<RecentEntry> {
    note(&app, &state, "剔除失效", |r| {
        recent::drop_missing(r, |p| std::path::Path::new(p).exists())
    })
}

/// 单条清除（行上那颗 ✕）。
#[tauri::command]
pub fn forget_recent(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Vec<RecentEntry> {
    let label = window.label().to_string();
    note(&app, &state, &format!("{label} 清除单条"), |r| {
        recent::forget(r, &key_of(&path))
    })
}

/// B315 · 资源管理器里改名 / 挪走 ⇒ 名单里那一条**就地改写**（目录会牵到它里面每一条）。
/// 不新增、不换位置、不改时间戳：那三样一起改了，用户看到的就是「我明明只是改了个名，
/// 最近打开的顺序全乱了」。
#[tauri::command]
pub fn retitle_recent(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    old: String,
    new: String,
) -> Vec<RecentEntry> {
    let label = window.label().to_string();
    note(&app, &state, &format!("{label} 改写路径"), |r| {
        recent::retitle(r, &old, &new)
    })
}

/// 清空全部（标题栏那颗垃圾桶）。不弹确认框 —— 名单会自己长回来。
#[tauri::command]
pub fn clear_recents(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Vec<RecentEntry> {
    let label = window.label().to_string();
    note(&app, &state, &format!("{label} 清空名单"), |r| {
        recent::clear(r)
    })
}

#[tauri::command]
pub fn get_recent_limit(state: State<'_, AppState>) -> usize {
    lock(&state.recents).limit
}

/// 改「保存数量上限」。回包是**生效后的上限**（可能被别的窗口抢先写过，以 Rust 为准）。
#[tauri::command]
pub fn set_recent_limit(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    limit: usize,
) -> usize {
    let label = window.label().to_string();
    logging::log(Level::Info, "recents", &format!("{label} 改上限 ⇒ {limit}"));
    note(&app, &state, "改上限", |r| recent::apply_limit(r, limit));
    lock(&state.recents).limit
}

// B305 那版在这里有两个函数：`mark_quitting`（立「退出中」旗）与 `on_window_destroyed`
// （窗口销毁时清那本可见账并把独有路径记进名单）。它们存在的唯一理由是把「从可见集合里
// 消失」认成「刚关掉」——不立那面旗，正常关主窗口会先把各窗口销毁，把用户**正在用**的文件
// 全记成刚关掉。B308 起记的是「出现」，关窗不产生任何事件，两个函数与 `WindowEvent::Destroyed`
// 那个钩子一起删掉：少一处「窗口生命周期里偷偷改名单」的地方。
