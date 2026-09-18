//! 暴露给前端的 Tauri 命令。
//!
//! 约定：字段一律 snake_case，前端按同名传递。
//! 大文件读取、跨文件搜索等重活后续改为流式 channel，控制面保持小消息。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use notify::{RecommendedWatcher, Watcher};
use tauri::State;

use crate::backup;
use crate::core::{atomic_write, codec, doc, eol};
use crate::session;

/// 进程启动时刻（在 `main()` 第一行写入），用于计算「点击图标 → 界面出现」的端到端耗时。
pub static BOOT: OnceLock<Instant> = OnceLock::new();

/// 应用级共享状态：打开文档集合的「真实状态」归 Rust 持有。
///
/// `docs` 的顺序即标签栏顺序；`next_id` 保证标签 id 在应用生命周期内唯一，
/// 前端一律按 id 寻址，不使用索引。
/// `watcher` 是全局文件监听器（M2：外部修改提示）。
#[derive(Default)]
pub struct AppState {
    pub docs: Mutex<Vec<doc::Doc>>,
    pub next_id: Mutex<u64>,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
}

fn alloc_id(state: &AppState) -> Result<u64, String> {
    let mut guard = state.next_id.lock().map_err(|e| e.to_string())?;
    *guard += 1;
    Ok(*guard)
}

fn watch_file(state: &AppState, path: &Path) {
    let guard = state.watcher.lock();
    if let Ok(mut bag) = guard {
        if let Some(w) = bag.as_mut() {
            // 重复 watch 同一路径会报错，忽略即可
            let _ = w.watch(path, notify::RecursiveMode::NonRecursive);
        }
    }
}

fn unwatch_file(state: &AppState, path: &Path) {
    let guard = state.watcher.lock();
    if let Ok(mut bag) = guard {
        if let Some(w) = bag.as_mut() {
            let _ = w.unwatch(path);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub tab_id: u64,
    /// 未关联磁盘路径时为空字符串
    pub path: String,
    pub name: String,
    pub encoding: String,
    pub eol: String,
    pub readonly: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub tab_id: u64,
    /// true 表示该路径已在某个标签中打开（前端应激活既有标签并保留其编辑状态）
    pub reused: bool,
    pub path: String,
    pub name: String,
    /// 已归一化到 LF 的文本
    pub text: String,
    pub encoding: String,
    pub eol: String,
    pub mixed_eol: bool,
    pub readonly: bool,
    pub size: u64,
    /// 解码过程中出现无法映射的字节，提示用户可能选错编码
    pub lossy: bool,
    /// M4 大文件分级：`"normal" | "large" | "huge"`，前端据此裁剪编辑器特性。
    pub size_class: String,
    /// 分级提示文案（normal 为空串）：直接显示给用户，说明关掉了哪些特性。
    pub size_hint: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LossyChar {
    pub ch: String,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub tab_id: u64,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub encoding: String,
    pub eol: String,
    pub lossy: bool,
    pub lossy_chars: Vec<LossyChar>,
}

fn tab_info(d: &doc::Doc) -> TabInfo {
    TabInfo {
        tab_id: d.id,
        path: d.path.to_string_lossy().into_owned(),
        name: if d.path.as_os_str().is_empty() {
            "未命名".into()
        } else {
            d.path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "未命名".into())
        },
        encoding: d.encoding.label().into(),
        eol: d.eol.label().into(),
        readonly: d.readonly,
    }
}

/// 创建未命名标签（文档状态归 Rust，文本 buffer 在前端）。
#[tauri::command]
pub fn new_tab(encoding: Option<String>, state: State<'_, AppState>) -> Result<TabInfo, String> {
    let enc = match encoding.as_deref() {
        Some(s) if !s.is_empty() => codec::Encoding::from_label(s),
        _ => codec::Encoding::Utf8,
    };
    let d = doc::Doc {
        id: alloc_id(&state)?,
        path: PathBuf::new(),
        encoding: enc,
        eol: eol::Eol::from_label("CRLF"),
        readonly: false,
    };
    let info = tab_info(&d);
    let mut guard = state.docs.lock().map_err(|e| e.to_string())?;
    guard.push(d);
    Ok(info)
}

/// 读取文件。传入 `encoding` 表示「以指定编码重新载入」，优先级高于自动识别。
///
/// 同一路径已在某标签中时返回 `reused: true` 并激活语义（文本字段仍完整返回，
/// 但前端应保留既有标签的编辑状态，不覆盖）。
#[tauri::command]
pub async fn open_file(
    path: String,
    encoding: Option<String>,
    state: State<'_, AppState>,
) -> Result<OpenedFile, String> {
    let target = PathBuf::from(&path);

    let meta = fs::metadata(&target).map_err(|e| format!("无法访问文件：{}", e))?;
    // M4：不再一上来就拒绝大文件，而是先定档再降级。超过硬上限才拒绝。
    let class = doc::size_class(meta.len()).ok_or_else(|| {
        format!(
            "文件过大（{:.1} MB）。当前版本支持 {} MB 以内的文件。",
            meta.len() as f64 / 1024.0 / 1024.0,
            doc::SIZE_HUGE_MAX / 1024 / 1024
        )
    })?;

    let bytes = fs::read(&target).map_err(|e| format!("读取失败：{}", e))?;
    if doc::is_probably_binary(&bytes) {
        return Err("这看起来是二进制文件，暂不支持打开。".into());
    }

    // 编码决策：用户指定 > 自动识别
    let enc = match encoding.as_deref().map(|s| s.trim()) {
        Some(s) if !s.is_empty() => codec::Encoding::from_label(s),
        _ => codec::detect(&bytes),
    };

    let decoded = codec::decode(&bytes, enc);
    // 先分析原始行尾，再归一化到 LF
    let info = eol::analyze(&decoded.text);
    let text = eol::to_lf(&decoded.text);
    let readonly = doc::is_readonly(&target);
    let abs = fs::canonicalize(&target).unwrap_or(target.clone());

    let mut guard = state.docs.lock().map_err(|e| e.to_string())?;

    // 已打开的路径 → 复用标签
    if let Some(existing) = guard.iter_mut().find(|d| d.path == abs) {
        let tab_id = existing.id;
        existing.encoding = enc;
        existing.eol = info.dominant;
        existing.readonly = readonly;
        return Ok(OpenedFile {
            tab_id,
            reused: true,
            path: target.to_string_lossy().into_owned(),
            name: target
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            text,
            encoding: enc.label().into(),
            eol: info.dominant.label().into(),
            mixed_eol: info.mixed,
            readonly,
            size: meta.len(),
            lossy: decoded.lossy,
            size_class: class.as_str().into(),
            size_hint: doc::size_class_hint(class).into(),
        });
    }

    let tab_id = alloc_id(&state)?;
    guard.push(doc::Doc {
        id: tab_id,
        path: abs.clone(),
        encoding: enc,
        eol: info.dominant,
        readonly,
    });
    drop(guard);
    watch_file(&state, &abs);

    Ok(OpenedFile {
        tab_id,
        reused: false,
        path: target.to_string_lossy().into_owned(),
        name: target
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        text,
        encoding: enc.label().into(),
        eol: info.dominant.label().into(),
        mixed_eol: info.mixed,
        readonly,
        size: meta.len(),
        lossy: decoded.lossy,
        size_class: class.as_str().into(),
        size_hint: doc::size_class_hint(class).into(),
    })
}

/// 以指定编码重新载入某标签（覆盖用户在状态栏切换编码的场景）。
#[tauri::command]
pub async fn reload_file(
    tab_id: u64,
    encoding: Option<String>,
    state: State<'_, AppState>,
) -> Result<OpenedFile, String> {
    let path = {
        let guard = state.docs.lock().map_err(|e| e.to_string())?;
        let d = guard
            .iter()
            .find(|d| d.id == tab_id)
            .ok_or_else(|| format!("标签 {tab_id} 不存在"))?;
        if d.path.as_os_str().is_empty() {
            return Err("未命名文档没有磁盘来源，无法重新载入。".into());
        }
        d.path.clone()
    };
    open_file(path.to_string_lossy().into_owned(), encoding, state).await
}

/// 保存。`path` 为空表示保存到该标签已关联路径；尚无路径时提示改用「另存为」。
#[tauri::command]
pub async fn save_file(
    tab_id: u64,
    text: String,
    encoding: String,
    eol: String,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<SavedFile, String> {
    let target: PathBuf = match path.as_deref().map(|s| s.trim()) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            let guard = state.docs.lock().map_err(|e| e.to_string())?;
            match guard.iter().find(|d| d.id == tab_id) {
                Some(d) if !d.path.as_os_str().is_empty() => d.path.clone(),
                Some(_) => return Err("当前文件尚未关联磁盘路径，请先使用「另存为」。".into()),
                None => return Err(format!("标签 {tab_id} 不存在")),
            }
        }
    };

    if target.exists() && doc::is_readonly(&target) {
        return Err("目标文件为只读，无法覆盖保存，请使用「另存为」。".into());
    }

    let enc = codec::Encoding::from_label(&encoding);
    let eol_kind = eol::Eol::from_label(&eol);

    // 内存是 LF，落盘前还原为目标行尾
    let with_eol = eol::apply(&text, eol_kind);
    let (bytes, replacements) = codec::encode(&with_eol, enc);
    let had_errors = replacements > 0;

    // 不可逆保护：只在真的发生替换时才做逐字符扫描
    let lossy_chars = if had_errors {
        codec::unencodable_chars(&text, enc, 50)
            .into_iter()
            .map(|c| LossyChar {
                ch: c.ch,
                line: c.line,
                col: c.col,
            })
            .collect()
    } else {
        Vec::new()
    };

    atomic_write::atomic_write(&target, &bytes).map_err(|e| format!("保存失败：{}", e))?;

    let abs = fs::canonicalize(&target).unwrap_or(target.clone());
    let readonly = doc::is_readonly(&abs);

    {
        let mut guard = state.docs.lock().map_err(|e| e.to_string())?;
        match guard.iter_mut().find(|d| d.id == tab_id) {
            Some(d) => {
                let old_path = d.path.clone();
                d.path = abs.clone();
                d.encoding = enc;
                d.eol = eol_kind;
                d.readonly = readonly;
                if old_path != abs && !old_path.as_os_str().is_empty() {
                    unwatch_file(&state, &old_path);
                }
            }
            None => {
                // 另存为创建的新文档（标签由 new_tab 预先创建，理论上必命中）
                guard.push(doc::Doc {
                    id: tab_id,
                    path: abs.clone(),
                    encoding: enc,
                    eol: eol_kind,
                    readonly,
                });
            }
        }
    }
    watch_file(&state, &abs);

    Ok(SavedFile {
        tab_id,
        path: target.to_string_lossy().into_owned(),
        name: target
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: bytes.len() as u64,
        encoding: enc.label().into(),
        eol: eol_kind.label().into(),
        lossy: had_errors,
        lossy_chars,
    })
}

/// 关闭标签（脏检查由前端负责）。
#[tauri::command]
pub fn close_tab(tab_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    let path = {
        let mut guard = state.docs.lock().map_err(|e| e.to_string())?;
        let p = guard
            .iter()
            .find(|d| d.id == tab_id)
            .map(|d| d.path.clone());
        guard.retain(|d| d.id != tab_id);
        p
    };
    if let Some(p) = path {
        if !p.as_os_str().is_empty() {
            unwatch_file(&state, &p);
        }
    }
    Ok(())
}

/// 列出全部标签（调试 / 前端重同步用）。
#[tauri::command]
pub fn list_tabs(state: State<'_, AppState>) -> Result<Vec<TabInfo>, String> {
    let guard = state.docs.lock().map_err(|e| e.to_string())?;
    Ok(guard.iter().map(tab_info).collect())
}

// ---------------------------------------------------------------- 热退出（B68）

/// 从热退出副本还原出来的标签。与 `OpenedFile` 同形（少 reused/size/lossy），
/// 前端得以复用同一套建文档逻辑。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredBackup {
    pub tab_id: u64,
    pub path: String,
    pub name: String,
    /// LF 归一化的正文
    pub text: String,
    pub encoding: String,
    pub eol: String,
    pub mixed_eol: bool,
    pub readonly: bool,
    pub size_class: String,
    pub size_hint: String,
}

/// 写入热退出副本（前端在内容变化防抖后调用，关窗前再 flush 一次）。
///
/// ⚠️ 这里写的是 **LitePad 自己的备份区**，绝不碰 `path` 指向的原文件——
/// 写原文件是「自动保存」的职责。两者混起来就等于背着用户改他的文件。
#[tauri::command]
pub fn write_backup(
    id: String,
    text: String,
    path: String,
    name: String,
    encoding: String,
    eol: String,
    mixed_eol: bool,
) -> Result<(), String> {
    let meta = backup::BackupMeta {
        id,
        path,
        name,
        encoding,
        eol,
        mixed_eol,
    };
    backup::write(&meta, &text)
}

/// 把热退出副本还原成一个新标签（内容照旧是「未保存」状态）。
///
/// 返回 `Ok(None)` 表示「没有可用副本」（已被丢弃 / 写失败 / 格式坏了）——
/// 这是正常分支而非错误：调用方退回按原路径打开原文件即可。
#[tauri::command]
pub fn restore_backup(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<RestoredBackup>, String> {
    let Some(b) = backup::read(&id) else {
        return Ok(None);
    };

    // 正文体量决定编辑器降级档位（与打开文件同一套判定）
    let class = doc::size_class(b.text.len() as u64).unwrap_or(doc::SizeClass::Huge);

    let enc = codec::Encoding::from_label(&b.meta.encoding);
    let eol_kind = eol::Eol::from_label(&b.meta.eol);

    // 原路径还在就重新挂上，这样「保存」会写回原文件而不是弹另存为；
    // 未命名文档（path 为空）保持无路径，保存时自然走另存为。
    let raw = PathBuf::from(&b.meta.path);
    let abs = if raw.as_os_str().is_empty() {
        PathBuf::new()
    } else {
        fs::canonicalize(&raw).unwrap_or(raw)
    };
    let readonly = !abs.as_os_str().is_empty() && doc::is_readonly(&abs);

    let tab_id = alloc_id(&state)?;
    state
        .docs
        .lock()
        .map_err(|e| e.to_string())?
        .push(doc::Doc {
            id: tab_id,
            path: abs.clone(),
            encoding: enc,
            eol: eol_kind,
            readonly,
        });
    if !abs.as_os_str().is_empty() {
        watch_file(&state, &abs);
    }

    Ok(Some(RestoredBackup {
        tab_id,
        path: abs.to_string_lossy().into_owned(),
        name: b.meta.name,
        text: b.text,
        encoding: enc.label().into(),
        eol: eol_kind.label().into(),
        mixed_eol: b.meta.mixed_eol,
        readonly,
        size_class: class.as_str().into(),
        size_hint: doc::size_class_hint(class).into(),
    }))
}

/// 丢弃单个副本（文档保存成功 / 转干净 / 关闭标签选「不保存」）。
#[tauri::command]
pub fn discard_backup(id: String) -> Result<(), String> {
    backup::discard(&id)
}

/// 清理会话不再引用的孤儿副本，返回删除个数。
///
/// ⚠️ 前端只在**会话读成功之后**才调：会话文件坏掉时 `keep` 会是空表，
/// 那时候清理等于把用户全部未保存内容删掉。宁可漏删，不可错删。
#[tauri::command]
pub fn discard_orphan_backups(keep: Vec<String>) -> Result<u32, String> {
    backup::discard_orphans(&keep).map(|n| n as u32)
}

/// 保存前探测：列出目标编码无法表示的字符。
///
/// 这是方案 4.3「不可逆保护」的前置检查——先问再写，避免写完了才告诉用户丢字符。
/// 注意是 O(n) 逐字符扫描，前端应只对非 Unicode 目标调用。
#[tauri::command]
pub fn check_encodable(text: String, encoding: String) -> Vec<LossyChar> {
    let enc = codec::Encoding::from_label(&encoding);
    codec::unencodable_chars(&text, enc, 50)
        .into_iter()
        .map(|c| LossyChar {
            ch: c.ch,
            line: c.line,
            col: c.col,
        })
        .collect()
}

/// 列出可用编码，供状态栏菜单渲染。
#[tauri::command]
pub fn list_encodings() -> Vec<String> {
    codec::Encoding::all()
        .iter()
        .map(|e| e.label().into())
        .collect()
}

/// 列出可选行尾，供状态栏菜单渲染（与 list_encodings 保持同一数据源）。
#[tauri::command]
pub fn list_eols() -> Vec<String> {
    eol::Eol::all().iter().map(|e| e.label().into()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IPC 线上字段名契约。
    ///
    /// 这些结构体都带 `rename_all = "camelCase"`，于是 `tab_id` → `tabId`、
    /// `size_class` → `sizeClass`、`mixed_eol` → `mixedEol`。
    /// 前端**必须**按 camelCase 读：B49 整条会话恢复失效就是栽在
    /// 「前后端字段名不一致」上，而 `size_class` 这一次又踩了同一个坑
    /// （前端读 `file.size_class` 恒为 undefined，M4 大文件降级从未真正生效）。
    #[test]
    fn ipc_structs_use_camel_case_field_names() {
        let r = RestoredBackup {
            tab_id: 7,
            path: String::new(),
            name: "未命名".into(),
            text: "x".into(),
            encoding: "UTF-8".into(),
            eol: "CRLF".into(),
            mixed_eol: true,
            readonly: false,
            size_class: "large".into(),
            size_hint: "hint".into(),
        };
        let out = serde_json::to_string(&r).unwrap();
        assert!(out.contains("\"tabId\":7"), "tab_id 应为 tabId：{out}");
        assert!(
            out.contains("\"mixedEol\":true"),
            "mixed_eol 应为 mixedEol：{out}"
        );
        assert!(
            out.contains("\"sizeClass\":\"large\""),
            "size_class 应为 sizeClass：{out}"
        );
        assert!(
            out.contains("\"sizeHint\":\"hint\""),
            "size_hint 应为 sizeHint：{out}"
        );
        for snake in ["tab_id", "mixed_eol", "size_class", "size_hint"] {
            assert!(!out.contains(snake), "不该落盘 snake_case {snake}：{out}");
        }

        // TabInfo 同理（它是会话恢复之外最常用的回包）
        let t = TabInfo {
            tab_id: 1,
            path: "C:\\a.txt".into(),
            name: "a.txt".into(),
            encoding: "UTF-8".into(),
            eol: "CRLF".into(),
            readonly: false,
        };
        let tout = serde_json::to_string(&t).unwrap();
        assert!(tout.contains("\"tabId\":1"), "{tout}");
        assert!(!tout.contains("tab_id"), "{tout}");
    }
}

#[tauri::command]
pub fn load_settings() -> session::Settings {
    smoke_log("load_settings called (IPC OK)");
    session::load()
}

/// 冒烟诊断：写入 %TEMP%\litepad-smoke.log。
/// 用文件而不是 stdout，是因为 GUI 子系统下 stdout 未必有接收端。
pub(crate) fn smoke_log(msg: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("litepad-smoke.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{}", msg);
    }
}

/// 前端界面就绪后回报：显示主窗口 + 记录端到端启动耗时。
///
/// 前端启动阶段回报（B50：纯诊断用）。
///
/// 前端在「外壳就绪」和「全部就绪」各调一次，detail 里带上各阶段耗时，
/// 写进 `%TEMP%\litepad-smoke.log`，用来定位启动慢在哪一段。
/// 注意：这里**不负责显示窗口**——主窗口一直是可见的，白屏靠
/// `main.rs` 里 `set_background_color` 刷主题底色解决。
#[tauri::command]
pub fn frontend_ready(detail: Option<String>) {
    let elapsed = BOOT.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    smoke_log(&format!(
        "frontend: +{elapsed}ms {}",
        detail.unwrap_or_default()
    ));
}

/// 运行日志（方案 M1「日志与埋点」）：追加写 %TEMP%\litepad-app.log。
#[tauri::command]
pub fn log_event(level: String, event: String, detail: Option<String>) {
    use std::io::Write;
    let path = std::env::temp_dir().join("litepad-app.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{ts} [{level}] {event} {}", detail.unwrap_or_default());
    }
}

#[tauri::command]
pub fn save_settings(settings: session::Settings) -> Result<(), String> {
    session::save(&settings)
}

// ---------------------------------------------------------------- 会话（M2）

#[tauri::command]
pub fn load_session() -> Option<session::SessionState> {
    session::load_session()
}

#[tauri::command]
pub fn save_session(state: session::SessionState) -> Result<(), String> {
    session::save_session(&state)
}

// ---------------------------------------------------------------- 导出 / 粘贴图片（M3）

/// 导出文本文件（自包含 HTML 等）。目录不存在时自动创建。
#[tauri::command]
pub async fn export_file(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("导出路径为空".into());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{}", e))?;
        }
    }
    fs::write(&target, contents).map_err(|e| format!("写入失败：{}", e))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastedImage {
    /// 绝对路径
    pub path: String,
    /// 相对 md 文件的引用路径（assets/xxx.png）
    pub rel: String,
}

/// 把剪贴板粘贴的图片保存到 md 文件同级的 assets/ 目录，返回引用相对路径。
#[tauri::command]
pub async fn save_paste_image(
    tab_id: u64,
    data_b64: String,
    ext: String,
    state: State<'_, AppState>,
) -> Result<PastedImage, String> {
    use base64::Engine as _;

    let doc_dir = {
        let guard = state.docs.lock().map_err(|e| e.to_string())?;
        let d = guard
            .iter()
            .find(|d| d.id == tab_id)
            .ok_or_else(|| format!("标签 {tab_id} 不存在"))?;
        let path = d.path.clone();
        if path.as_os_str().is_empty() {
            return Err("请先把 Markdown 文件保存到磁盘后再粘贴图片".into());
        }
        drop(guard);
        path.parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "无法确定文件所在目录".to_string())?
    };

    let ext = {
        let e = ext.trim().to_lowercase();
        let e = e.strip_prefix('.').unwrap_or(&e);
        match e {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => e.to_string(),
            _ => "png".to_string(),
        }
    };

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| format!("图片数据解码失败：{}", e))?;
    if bytes.is_empty() {
        return Err("图片数据为空".into());
    }

    let assets = doc_dir.join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("无法创建 assets 目录：{}", e))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("paste-{stamp}.{}", ext);
    let full = assets.join(&name);
    fs::write(&full, &bytes).map_err(|e| format!("图片写入失败：{}", e))?;

    Ok(PastedImage {
        path: full.to_string_lossy().into_owned(),
        rel: format!("assets/{}", name),
    })
}
