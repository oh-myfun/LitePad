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
    /// 自动保存已关联磁盘文件的脏文档（1.5s 防抖，M2 生效）
    pub autosave: bool,
    /// Markdown 预览行距（1.0–2.5，默认 1.7）
    pub preview_line_height: f64,
    /// 大纲（TOC）抽屉宽度（px，160–640，默认 240）。前端拖拽分隔条后回写。
    pub toc_width: f64,
    /// 快捷键覆盖表：命令 id → 键位串（空串 = 显式解绑）。
    /// 后端不解释内容，只负责存取；合法性由前端 keymap 模块过滤。
    pub keymap: HashMap<String, String>,
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
            autosave: true,
            preview_line_height: 1.7,
            toc_width: 240.0,
            keymap: HashMap::new(),
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
}

impl Default for SessionState {
    fn default() -> Self {
        SessionState {
            panels: Vec::new(),
            layout: serde_json::json!({ "kind": "leaf", "panelId": 0 }),
            active_panel: 0,
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
}
