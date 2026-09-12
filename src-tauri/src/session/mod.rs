//! 配置持久化（%APPDATA%\LiteMD\settings.json）。
//!
//! M0 只落地主题等少量偏好；会话/布局持久化属于 M2。
//! `#[serde(default)]` 保证旧版本配置文件缺字段时也能读出来（前向兼容）。

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
    pub word_wrap: bool,
    /// 自动保存已关联磁盘文件的脏文档（1.5s 防抖，M2 生效）
    pub autosave: bool,
    /// Markdown 预览行距（1.0–2.5，默认 1.7）
    pub preview_line_height: f64,
    /// 大纲（TOC）抽屉宽度（px，160–640，默认 240）。前端拖拽分隔条后回写。
    pub toc_width: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            default_eol: "CRLF".into(),
            default_encoding: "UTF-8".into(),
            recent_files: Vec::new(),
            font_size: 14.0,
            word_wrap: true,
            autosave: true,
            preview_line_height: 1.7,
            toc_width: 240.0,
        }
    }
}

/// 配置文件路径。当前构建仅面向 Windows，直接使用 APPDATA。
pub fn settings_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("LiteMD").join("settings.json"))
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TabSession {
    pub path: String,
    pub encoding: String,
    pub eol: String,
    pub cursor_line: u32,
    pub cursor_col: u32,
    /// Markdown 视图模式（source/split/preview），仅 md 文件有意义
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PanelSession {
    pub tabs: Vec<TabSession>,
    pub active: usize,
}

impl Default for PanelSession {
    fn default() -> Self {
        PanelSession {
            tabs: Vec::new(),
            active: 0,
        }
    }
}

/// 完整会话：面板列表 + 前端布局树 JSON（panelId 用 panels 的索引；Rust 纯透传）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionState {
    pub panels: Vec<PanelSession>,
    /// 前端布局树（leaf.panelId = panels 索引）；结构由前端定义
    pub layout: serde_json::Value,
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
    std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("LiteMD").join("session.json"))
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
