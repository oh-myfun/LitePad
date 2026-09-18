//! 配置持久化（%APPDATA%\LitePad\settings.json）。
//!
//! M0 只落地主题等少量偏好；会话/布局持久化属于 M2。
//! `#[serde(default)]` 保证旧版本配置文件缺字段时也能读出来（前向兼容）。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "system" | "light" | "dark"
    pub theme: String,
    /// 新建文件的默认行尾
    pub default_eol: String,
    /// 打开文件时编码识别失败后的兜底编码
    pub default_encoding: String,
    pub recent_files: Vec<String>,
    pub font_size: f64,
    /// 编辑器等宽字体族名；空串 = 用内置默认栈（Cascadia Code / Consolas…）
    pub font_family: String,
    /// 编辑器行距（1.0–2.5，默认 1.5），作用于 .cm-content
    pub editor_line_height: f64,
    pub word_wrap: bool,
    /// 自动保存：把脏文档写回**原文件**（对应 VS Code `files.autoSave`）。
    /// B68 起默认 **false**，对齐 VS Code 桌面版默认值——它和热退出是两件事，
    /// 详见 `backup` 模块头部注释。
    pub autosave: bool,
    /// 热退出：关窗时把未保存内容写进独立副本，于是不必再弹「未保存将丢失」的
    /// 确认框，下次启动还原成未保存标签（对应 VS Code `files.hotExit`）。
    /// B68 起默认 **true**，对齐 VS Code 桌面版的 `onExit`。
    pub hot_exit: bool,
    /// Markdown 预览行距（1.0–2.5，默认 1.7）
    pub preview_line_height: f64,
    /// 大纲（TOC）抽屉宽度（px，160–640，默认 240）。前端拖拽分隔条后回写。
    pub toc_width: f64,
    /// 快捷键覆盖表：命令 id → 键位串（空串 = 显式解绑）。
    /// 后端不解释内容，只负责存取；合法性由前端 keymap 模块过滤。
    pub keymap: HashMap<String, String>,
    /// 键位预设 id（"default" | "notepadpp" | "vscode"）。
    /// 优先级：keymap 覆盖 > keymap_preset > 命令默认值。未知值由前端回落默认，
    /// 后端不校验——预设是前端概念，放到后端枚举反而要跟着前端改。
    pub keymap_preset: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            default_eol: "CRLF".into(),
            default_encoding: "UTF-8".into(),
            recent_files: Vec::new(),
            font_size: 14.0,
            font_family: String::new(),
            editor_line_height: 1.5,
            word_wrap: true,
            // B68：两个开关各管一件事，默认值对齐 VS Code 桌面版
            // （自动保存关、热退出开）。别顺手把 autosave 改回 true——
            // 自动保存会写脏用户的文件，热退出只写自己的备份区。
            autosave: false,
            hot_exit: true,
            preview_line_height: 1.7,
            toc_width: 240.0,
            keymap: HashMap::new(),
            keymap_preset: "default".into(),
        }
    }
}

/// 配置文件路径。当前构建仅面向 Windows，直接使用 APPDATA。
pub fn settings_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("LitePad").join("settings.json"))
}

/// 读取配置；任何异常都静默回落默认值，绝不让配置损坏导致启动失败。
pub fn load() -> Settings {
    if let Some(path) = settings_path() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&content) {
                return settings;
            }
        }
    }
    Settings::default()
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| "无法定位 %APPDATA% 目录".to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    atomic_write::atomic_write(&path, json.as_bytes()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- 会话状态（M2）

/// 单个会话标签：按路径恢复（未命名文档不参与会话）。
///
/// 线上格式是 **camelCase**（`cursorLine` / `viewMode`），与前端
/// `src/ipc/api.ts` 的 `TabSession` 一致。B49 之前这里漏了 `rename_all`，
/// 于是前端发来的 `cursorLine`/`viewMode` 被当作未知字段丢掉、Rust 落盘的
/// `cursor_line` 前端又读不到——表现为「重启后光标回到第 1 行、预览模式丢失」。
/// `alias` 用于继续兼容旧版本落盘的 snake_case 字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TabSession {
    pub path: String,
    pub encoding: String,
    pub eol: String,
    #[serde(alias = "cursor_line")]
    pub cursor_line: u32,
    #[serde(alias = "cursor_col")]
    pub cursor_col: u32,
    /// Markdown 视图模式（source/split/preview），仅 md 文件有意义
    #[serde(alias = "view_mode")]
    pub view_mode: Option<String>,
    /// 热退出副本 ID（B68）。跨会话稳定，一个文档一个。
    ///
    /// 恢复时**副本优先于路径**：副本还在就说明关闭时该文档是脏的，
    /// 要用副本内容而不是磁盘内容。副本不存在则退回按 `path` 打开。
    /// 于是「副本写失败」「副本被手动删了」这类情况都能自愈。
    #[serde(alias = "backup_id")]
    pub backup_id: Option<String>,
    /// 前端文档 ID（= Rust `doc::Doc::id`，B69）。
    ///
    /// 空的新建文档既没有 `path`、又不脏（没输入过内容，压根不会写副本），
    /// 光看 `path` / `backup_id` 两个字段是认不出它的，于是会被会话漏掉。
    /// 带上 `docId` 才能：① 把它记进会话；② 恢复时判断「哪些标签其实是同一个文档」
    /// ——同一个空文档被分屏成两个实例时，不能恢复成两份互不相干的文档。
    ///
    /// 旧版本落盘的会话没有这个字段，反序列化为 `None`，行为与 B69 之前一致。
    #[serde(alias = "doc_id")]
    pub doc_id: Option<u64>,
}

impl Default for TabSession {
    fn default() -> Self {
        TabSession {
            path: String::new(),
            encoding: "UTF-8".into(),
            eol: "CRLF".into(),
            cursor_line: 1,
            cursor_col: 1,
            view_mode: None,
            backup_id: None,
            doc_id: None,
        }
    }
}

/// 会话面板：标签有序列表 + 活动索引（索引指向 tabs）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PanelSession {
    pub tabs: Vec<TabSession>,
    pub active: usize,
}

/// 完整会话：面板列表 + 前端布局树 JSON（panelId 用 panels 的索引；Rust 纯透传）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionState {
    pub panels: Vec<PanelSession>,
    /// 前端布局树（leaf.panelId = panels 索引）；结构由前端定义
    pub layout: serde_json::Value,
    #[serde(alias = "active_panel")]
    pub active_panel: usize,
    /// B71 ④：**被搬到其他窗口**的标签（卫星窗口里那些）。
    ///
    /// 卫星窗口自己不写会话（两个窗口同时写就是互相覆盖），所以这些标签只能由主窗口
    /// 代为登记。少了这一段，「把未保存文档拖到新窗口 + 强杀进程」会让副本变成孤儿
    /// 被清理掉 —— 用户的字就真的没了。
    ///
    /// 启动时**不区分窗口**：这些标签一律并回主窗口（v1 不回放多窗口布局）。
    #[serde(alias = "satellite_tabs")]
    pub satellite_tabs: Vec<TabSession>,
}

impl Default for SessionState {
    fn default() -> Self {
        SessionState {
            panels: Vec::new(),
            layout: serde_json::json!({ "kind": "leaf", "panelId": 0 }),
            active_panel: 0,
            satellite_tabs: Vec::new(),
        }
    }
}

pub fn session_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("LitePad").join("session.json"))
}

/// 读取会话；异常静默返回 None（坏会话绝不阻塞启动）。
pub fn load_session() -> Option<SessionState> {
    let path = session_path()?;
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<SessionState>(&content).ok()
}

pub fn save_session(state: &SessionState) -> Result<(), String> {
    let path = session_path().ok_or_else(|| "无法定位 %APPDATA% 目录".to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    atomic_write::atomic_write(&path, json.as_bytes()).map_err(|e| e.to_string())
}

use crate::core::atomic_write;

#[cfg(test)]
mod tests {
    use super::*;

    /// B49：会话线上格式必须是 camelCase（与前端 `src/ipc/api.ts` 对齐）。
    /// 之前漏了 `rename_all`，导致光标/预览模式/活动面板跨会话恢复全部失效。
    #[test]
    fn session_round_trip_uses_camel_case() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "encoding": "UTF-8", "eol": "LF",
                  "cursorLine": 12, "cursorCol": 5, "viewMode": "preview" }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;

        let state: SessionState = serde_json::from_str(json).expect("应能读入前端 camelCase 会话");
        let tab = &state.panels[0].tabs[0];
        assert_eq!(tab.cursor_line, 12, "cursorLine 必须被读到");
        assert_eq!(tab.cursor_col, 5, "cursorCol 必须被读到");
        assert_eq!(
            tab.view_mode.as_deref(),
            Some("preview"),
            "viewMode 必须被读到"
        );

        // 落盘也必须用 camelCase，否则前端 st.viewMode 永远是 undefined
        let out = serde_json::to_string(&state).unwrap();
        assert!(out.contains("\"cursorLine\""), "落盘应为 cursorLine：{out}");
        assert!(out.contains("\"viewMode\""), "落盘应为 viewMode：{out}");
        assert!(
            out.contains("\"activePanel\""),
            "落盘应为 activePanel：{out}"
        );
        assert!(!out.contains("cursor_line"), "不应再落盘 snake_case：{out}");
    }

    /// 旧版本（B48 及更早）落盘的是 snake_case，升级后仍要能读出来。
    #[test]
    fn legacy_snake_case_session_still_loads() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "encoding": "UTF-8", "eol": "LF",
                  "cursor_line": 7, "cursor_col": 3, "view_mode": "preview" }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "active_panel": 1
        }"#;

        let state: SessionState = serde_json::from_str(json).expect("旧会话应兼容读入");
        let tab = &state.panels[0].tabs[0];
        assert_eq!(tab.cursor_line, 7);
        assert_eq!(tab.view_mode.as_deref(), Some("preview"));
        assert_eq!(state.active_panel, 1);
    }

    /// M4：Settings 新增 `keymap_preset`。
    /// 老配置文件里没有这个字段——`#[serde(default)]` 必须让它回落 "default"，
    /// 否则 `load()` 会因为缺字段直接整体失败、用户所有偏好一起丢。
    #[test]
    fn settings_without_keymap_preset_falls_back_to_default() {
        let json = r#"{
          "theme": "dark",
          "keymap": { "file.save": "Ctrl+Q" }
        }"#;

        let s: Settings = serde_json::from_str(json).expect("缺 keymap_preset 也应能读入");
        assert_eq!(s.keymap_preset, "default", "未知/缺失应回落 default");
        assert_eq!(
            s.keymap.get("file.save").map(String::as_str),
            Some("Ctrl+Q")
        );
        assert_eq!(Settings::default().keymap_preset, "default");
    }

    /// 落盘的字段名必须是 keymap_preset（前端按同名读取）。
    /// 注意：Settings 走 snake_case（只有会话结构 TabSession/PanelSession 是 camelCase），
    /// 前端 `settings?.keymap_preset` 与之对应，别顺手加 rename_all。
    #[test]
    fn settings_keymap_preset_round_trip() {
        let s = Settings {
            keymap_preset: "notepadpp".into(),
            ..Settings::default()
        };
        let out = serde_json::to_string(&s).unwrap();
        assert!(
            out.contains("\"keymap_preset\":\"notepadpp\""),
            "落盘字段应为 snake_case keymap_preset：{out}"
        );
    }

    /// B68：会话必须带上热退出副本 ID。
    ///
    /// 这是「关窗不弹确认框」的命脉：副本文件本身不含「属于哪个标签」的索引，
    /// 全靠会话里的 backupId 把副本认领回来。少了它，副本就是一堆孤儿文件。
    #[test]
    fn session_carries_hot_exit_backup_id() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "encoding": "UTF-8", "eol": "LF",
                  "cursorLine": 3, "cursorCol": 2, "viewMode": null,
                  "backupId": "0f2b1c34-abcd-4e11-9a55-0123456789ab" }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;

        let state: SessionState = serde_json::from_str(json).expect("带 backupId 的会话应能读入");
        assert_eq!(
            state.panels[0].tabs[0].backup_id.as_deref(),
            Some("0f2b1c34-abcd-4e11-9a55-0123456789ab"),
            "backupId 必须被读到"
        );

        let out = serde_json::to_string(&state).unwrap();
        assert!(out.contains("\"backupId\""), "落盘应为 camelCase：{out}");
        assert!(!out.contains("backup_id"), "不该落盘 snake_case：{out}");

        // 旧会话（B67 及更早）没有 backupId —— 必须能读入并回落 None，
        // 否则升级后所有用户的老会话都会解析失败、标签全丢。
        let legacy = r#"{"panels":[{"tabs":[{"path":"a.md"}],"active":0}],
                         "layout":{},"activePanel":0}"#;
        let old: SessionState = serde_json::from_str(legacy).expect("老会话要能读入");
        assert_eq!(old.panels[0].tabs[0].backup_id, None, "缺字段应回落 None");
    }

    /// B69：空的未命名文档靠 `docId` 进会话。
    ///
    /// 它既没有 `path`、也不脏（没输入过内容 → 不会写副本），光看
    /// `path` / `backup_id` 两个字段认不出它，于是整条被会话漏掉，
    /// 表现为「新建了但还没打字」的标签重启后凭空消失。
    #[test]
    fn session_carries_doc_id_for_empty_untitled() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "", "encoding": "UTF-8", "eol": "LF",
                  "cursorLine": 1, "cursorCol": 1, "docId": 7 }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;

        let state: SessionState =
            serde_json::from_str(json).expect("带 docId 的空文档会话应能读入");
        assert_eq!(state.panels[0].tabs[0].doc_id, Some(7), "docId 必须被读到");

        let out = serde_json::to_string(&state).unwrap();
        assert!(out.contains("\"docId\""), "落盘应为 camelCase：{out}");
        assert!(!out.contains("doc_id"), "不该落盘 snake_case：{out}");

        // 旧会话没有 docId → None，行为与 B69 之前一致（这类标签本来就没进过会话）
        let legacy = r#"{"panels":[{"tabs":[{"path":""}],"active":0}],
                         "layout":{},"activePanel":0}"#;
        let old: SessionState = serde_json::from_str(legacy).expect("老会话要能读入");
        assert_eq!(old.panels[0].tabs[0].doc_id, None, "缺字段应回落 None");
    }

    /// B68：`autosave` 与 `hot_exit` 是两个独立开关，默认值对齐 VS Code 桌面版。
    ///
    /// 写成断言是为了挡住「顺手改默认值」：自动保存会**写脏用户的文件**，
    /// 而热退出只写 LitePad 自己的备份区——两者默认值的取舍完全不是一回事。
    #[test]
    fn save_related_defaults_match_vscode_desktop() {
        let s = Settings::default();
        assert!(
            !s.autosave,
            "自动保存默认关（VS Code files.autoSave 桌面默认 off）"
        );
        assert!(
            s.hot_exit,
            "热退出默认开（VS Code files.hotExit 桌面默认 onExit）"
        );

        // 老配置文件里没有 hot_exit —— 必须回落 true 而不是让整个配置读失败。
        let legacy = r#"{ "theme": "dark", "autosave": true }"#;
        let old: Settings = serde_json::from_str(legacy).expect("缺 hot_exit 也应能读入");
        assert!(old.hot_exit, "缺失 hot_exit 应回落 true");
        assert!(
            old.autosave,
            "用户显式存过的 autosave=true 必须保留（不能被默认值覆盖）"
        );

        let out = serde_json::to_string(&s).unwrap();
        assert!(
            out.contains("\"hot_exit\":true"),
            "落盘应为 snake_case hot_exit：{out}"
        );
    }
}
