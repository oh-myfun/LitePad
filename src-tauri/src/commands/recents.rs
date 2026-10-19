//! B305 · 最近打开的 IPC 层：名单的唯一写点。
//!
//! ⚠️ 名单**只有这一处会改**（`note` 与 `on_window_destroyed` 两个口子），改完一律走
//! `publish`：落盘 + 广播 + 回传当前条目三件事同处。窗口身份取 `window.label()`
//! （Rust 侧自证），不接受前端传来的 `from` —— 前端那个字段是自证的，本模块不需要它。
//!
//! 为什么记账的输入是「各窗口的可见路径集合」而不是「谁关了标签」：见
//! `session::recent` 模块头部。落到 IPC 上的效果是 —— 子窗口关标签、关整个子窗口、
//! 标签拖出去又关掉，一条都不用各写一遍。

use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::core::logging::{self, Level};
use crate::session::recent::{self, key_of, prune_open, record_closed, RecentEntry, Recents};

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

/// 本窗口「此刻屏上看得见哪些文件」。可见实例的路径集合变了才调（前端那侧有 diff，
/// 见 `src/recents/store.ts`），没变它自己会早退。
///
/// ⚠️ 顺序必须是**先剪后记**：剪枝对着的是刚并进来的完整并集，若先记再剪，同一轮里
/// 「这个窗口刚关掉、另一个窗口报上来它其实还开着」的那条会先被记上、再被剪掉 ——
/// 名单会闪一条又没了。
#[tauri::command]
pub fn sync_open_paths(
    window: tauri::Window,
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Vec<RecentEntry> {
    let label = window.label().to_string();
    let (vanished, open_keys) = {
        let mut o = lock(&state.open_sets);
        let vanished = o.update(&label, &paths);
        (vanished, o.union_keys())
    };
    let quitting = state.quitting.load(Ordering::SeqCst);
    let now = now_ms();
    if vanished.is_empty() {
        logging::log(
            Level::Debug,
            "recents",
            &format!("同步 {label} 可见={} 无消失项", paths.len()),
        );
    } else {
        logging::log(
            Level::Info,
            "recents",
            &format!(
                "同步 {label} 可见={} 消失={} 退出中={}",
                paths.len(),
                vanished.len(),
                quitting
            ),
        );
    }
    note(&app, &state, "剪除+记录", |r| {
        let pruned = prune_open(r, &open_keys);
        let recorded = if quitting {
            false
        } else {
            record_closed(r, &vanished, now)
        };
        pruned || recorded
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

/// 主窗口没了 = 应用正在退出：立旗标，此后一律「只剪不记」。
///
/// 口径来自用户那句「（退出时还开着的）不算」——不立这面旗，正常关主窗口会先销毁各窗口，
/// 每条可见账清空时都把用户**正在用**的文件记成「刚关掉」。
pub fn mark_quitting(state: &AppState) {
    state.quitting.store(true, Ordering::SeqCst);
}

/// 某扇窗口销毁：清掉它那份可见账，并把它独有的路径记进名单。
///
/// 与 `sync_open_paths` 同一口径（先剪后记、退出中不记）。卫星窗口关窗即真关（B188），
/// 这条就是「文档只在子窗口并被关掉 ⇒ 主窗口的名单立刻刷新」的落点。
pub fn on_window_destroyed(app: &AppHandle, state: &AppState, label: &str) {
    let (vanished, open_keys) = {
        let mut o = lock(&state.open_sets);
        let vanished = o.drop_window(label);
        (vanished, o.union_keys())
    };
    let quitting = state.quitting.load(Ordering::SeqCst);
    let now = now_ms();
    logging::log(
        Level::Info,
        "recents",
        &format!(
            "窗口没了 {label} 消失={} 退出中={}",
            vanished.len(),
            quitting
        ),
    );
    note(app, state, "窗口销毁", |r| {
        let pruned = prune_open(r, &open_keys);
        let recorded = if quitting {
            false
        } else {
            record_closed(r, &vanished, now)
        };
        pruned || recorded
    });
}
