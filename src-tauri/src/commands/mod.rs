//! 暴露给前端的 Tauri 命令。
//!
//! 约定：字段一律 snake_case，前端按同名传递。
//! 大文件读取、跨文件搜索等重活后续改为流式 channel，控制面保持小消息。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, Watcher};
use tauri::State;

use crate::core::{atomic_write, codec, doc, eol};
use crate::session;

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
    if meta.len() > doc::MAX_OPEN_BYTES {
        return Err(format!(
            "文件过大（{:.1} MB）。当前版本暂支持 {} MB 以内的文件，大文件分级模式将在 M4 提供。",
            meta.len() as f64 / 1024.0 / 1024.0,
            doc::MAX_OPEN_BYTES / 1024 / 1024
        ));
    }

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

#[tauri::command]
pub fn load_settings() -> session::Settings {
    smoke_log("load_settings called (IPC OK)");
    session::load()
}

/// 冒烟诊断：写入 %TEMP%\litepad-smoke.log。
/// 用文件而不是 stdout，是因为 GUI 子系统下 stdout 未必有接收端。
fn smoke_log(msg: &str) {
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

/// 冒烟诊断：前端 bootstrap 完成后回报关键状态（也接收 index.html 的启动错误上报）。
#[tauri::command]
pub fn frontend_ready(detail: Option<String>) {
    smoke_log(&format!("frontend: {}", detail.unwrap_or_default()));
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
