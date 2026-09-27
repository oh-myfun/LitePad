//! 配置持久化（%APPDATA%\LitePad\settings.json）。
//!
//! M0 只落地主题等少量偏好；会话/布局持久化属于 M2。
//! `#[serde(default)]` 保证旧版本配置文件缺字段时也能读出来（前向兼容）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
    /// 标签样式（"connected" | "pill"）。前端不识别的值按 "connected" 处理，
    /// 后端不校验——理由同 keymap_preset。
    pub tab_style: String,
    /// 标签右侧 ●/× 操作槽位是否**恒定预留空位**（B115，对齐 VS Code 1.139
    /// `workbench.editor.tabActionReserveSpace`，默认 true）。false = 紧凑档：
    /// 已保存标签收紧文字，悬停时按钮浮出；未保存标签的 ● 指示器恒预留。
    pub tab_action_reserve_space: bool,
    /// 日志级别（B144）：`"error" | "warn" | "info" | "debug" | "trace"`。
    /// **空串 = 走内置默认**（发布版 info、debug 构建 debug），旧配置文件没有这个
    /// 字段时反序列化为空串，行为与加字段之前一致。
    pub log_level: String,
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
            tab_style: "connected".into(),
            tab_action_reserve_space: true,
            log_level: String::new(),
        }
    }
}

/// 配置根目录：默认 `%APPDATA%\LitePad`，可用 **`LITEPAD_CONFIG_DIR`** 整体覆盖。
///
/// ## 为什么必须能覆盖（不是"顺手加个 env"）
///
/// 补拍 `docs/screenshots/` 时应用必须跑**演示会话**，否则会拍到用户真实打开的文档。
/// 以前的做法是脚本把真实 `session.json` / `settings.json` 备份出来、覆盖成演示内容、
/// 拍完再还原 —— 每轮两次文件往返（含两处 `os.remove`），而且**进程被硬杀时真实会话会
/// 停在演示状态**（`finally` 兜不住 SIGKILL）。有了覆盖点，脚本只要把子进程的环境指向
/// 项目内 `.tmp/shot/config`，就**完全不碰用户目录**。
pub fn config_dir() -> Option<PathBuf> {
    pick_config_dir(
        std::env::var_os("LITEPAD_CONFIG_DIR"),
        std::env::var_os("APPDATA"),
    )
}

/// 纯函数版（不读全局环境，便于断言）：覆盖优先，且**空串不算覆盖**
/// （环境变量被设成空是很常见的手滑，静默当成"指向当前目录"会写得到处都是）。
fn pick_config_dir(
    override_dir: Option<std::ffi::OsString>,
    appdata: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    match override_dir {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => appdata.map(|d| PathBuf::from(d).join("LitePad")),
    }
}

/// 配置文件路径。当前构建仅面向 Windows，默认落在 APPDATA。
pub fn settings_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("settings.json"))
}

/// 读取配置；任何异常都静默回落默认值，绝不让配置损坏导致启动失败。
///
/// ⚠️ 「静默」只针对调用方：这里仍然记一条 warn（B144）。之前是连日志都没有的 ——
/// 用户抱怨「设置怎么老是被重置」，查了半天才发现是 `settings.json` 被人手改坏了。
pub fn load() -> Settings {
    if let Some(path) = settings_path() {
        match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<Settings>(&content) {
                Ok(settings) => return settings,
                Err(e) => logging::log(
                    Level::Warn,
                    "settings",
                    &format!("配置反序列化失败，回落默认值：{e} ← {}", path.display()),
                ),
            },
            Err(e) => logging::log(
                Level::Debug,
                "settings",
                &format!("读不到配置（按首次启动处理）：{e}"),
            ),
        }
    }
    Settings::default()
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let path = settings_path().ok_or_else(|| {
        "无法定位配置目录（需要 %APPDATA%，或显式给 LITEPAD_CONFIG_DIR）".to_string()
    })?;
    if let Err(e) = save_at(&path, settings) {
        logging::log(
            Level::Error,
            "settings",
            &format!("保存失败：{e} ← {}", path.display()),
        );
        return Err(e);
    }
    Ok(())
}

fn save_at<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    atomic_write::atomic_write(path, json.as_bytes()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- 会话状态（M2）

/// 视口位置按**浮点**收下再取整（B143）。
///
/// 浏览器里 `scrollTop` 是 double：系统缩放不是 100% 时，「滚到底」正好等于
/// `scrollHeight - clientHeight`，几乎必然带小数（125% / 150% 缩放是重灾区）。
/// 而本字段是 `Option<u32>` —— 一个小数会让**整份** `SessionState` 反序列化失败
/// ⇒ `save_session` 直接报错 ⇒ 前端那个 catch 静默吞掉 ⇒ 会话从此一次也写不进去，
/// 表现就是「滚到底之后再滚，位置再也不刷新」（往回滚的增量是整数，可基数还带着
/// 那个小数，于是连续失败）。
///
/// 宁可差 1px，也不能让整份会话落不下去。已经写了小数的历史文件也能被读回来。
fn de_scroll_top<'de, D>(d: D) -> Result<Option<u32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<f64>::deserialize(d)?;
    Ok(v.filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n.round() as u32))
}

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
    /// 视口滚动位置（px）。
    ///
    /// 光标只记到行列，视口不记的话恢复后文件停在开头、光标却在屏幕外，
    /// 看上去就跟「光标复位了」一样（B126）。
    ///
    /// ⚠️ **纯预览态（B129）下这个槽是预览容器的滚动位置**：编辑器此时是
    /// `display:none`，`scrollTop` 被浏览器清零，真正承载视图位置的是预览容器。
    /// 所以前端存取两端都按 `view_mode` 分流，别死盯编辑器。
    ///
    /// `None` = 这份标签从没显示过，由前端按光标位置自行定位。
    ///
    /// ⚠️ 反序列化走 `de_scroll_top`：浏览器给的是 double（见该函数注释，
    /// B143），裸 `u32` 会让整份会话读不出来。
    #[serde(alias = "scroll_top", deserialize_with = "de_scroll_top")]
    pub scroll_top: Option<u32>,
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
            scroll_top: None,
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
    config_dir().map(|d| d.join("session.json"))
}

/// 读取会话；异常静默返回 None（坏会话绝不阻塞启动）。
///
/// ⚠️ 静默是对调用方而言，日志照样记（B144）：B143 那个坑（小数 `scrollTop` 让整份
/// 会话反序列化失败）就是靠这条才看得见 —— 以前前端只看到「会话没保存」，
/// 后端这边连「读出来过、但解析失败了」都无从判断。
pub fn load_session() -> Option<SessionState> {
    let path = session_path()?;
    let Ok(content) = fs::read_to_string(&path) else {
        return None; // 首次启动：没有会话文件，很正常
    };
    match serde_json::from_str::<SessionState>(&content) {
        Ok(state) => {
            // B147：读成功了也要留一条。前端只能看到「恢复出几个标签」，看不出
            // 「盘上其实有 20 个、只恢复了 3 个」是解析时丢的，还是有意的（空未命名
            // 不进会话）。前端只能看到结果，看不到这个差别。
            let tabs: usize = state.panels.iter().map(|p| p.tabs.len()).sum();
            logging::log(
                Level::Debug,
                "session",
                &format!(
                    "会话读盘成功：面板={} 标签={} 卫星={} 活动面板={} ← {}",
                    state.panels.len(),
                    tabs,
                    state.satellite_tabs.len(),
                    state.active_panel,
                    path.display()
                ),
            );
            Some(state)
        }
        Err(e) => {
            logging::log(
                Level::Warn,
                "session",
                &format!("会话反序列化失败，按空会话启动：{e} ← {}", path.display()),
            );
            None
        }
    }
}

pub fn save_session(state: &SessionState) -> Result<(), String> {
    let path = session_path().ok_or_else(|| {
        "无法定位配置目录（需要 %APPDATA%，或显式给 LITEPAD_CONFIG_DIR）".to_string()
    })?;
    if let Err(e) = save_at(&path, state) {
        // 前端 `persistSession` 的 catch 会把它吞掉，所以后端这里必须自己留一条，
        // 否则「会话一次都没落下去」只能靠猜（B143 / B144）。
        logging::log(
            Level::Error,
            "session",
            &format!("会话保存失败：{e} ← {}", path.display()),
        );
        return Err(e);
    }
    // B147：成功也留一条。**成功不留痕**是这个模块以前最难查的地方 —— 前端那边
    // 只看到「save 没抛错」，可 `session_path()` 拿不到时这里直接 Err 出去、
    // 一行字都不写，界面上和「写成功了」一模一样。留下这条就能对上时间线。
    let tabs: usize = state.panels.iter().map(|p| p.tabs.len()).sum();
    logging::log(
        Level::Debug,
        "session",
        &format!(
            "会话已落盘：面板={} 标签={} 卫星={} 活动面板={} ← {}",
            state.panels.len(),
            tabs,
            state.satellite_tabs.len(),
            state.active_panel,
            path.display()
        ),
    );
    Ok(())
}

use crate::core::{
    atomic_write,
    logging::{self, Level},
};

#[cfg(test)]
mod tests {
    use super::*;

    // 配置目录覆盖（截图隔离用）。断言走纯函数 `pick_config_dir`，
    // **不去改进程级环境变量** —— 测试并行跑，改 env 会互相干扰。
    #[test]
    fn config_dir_override_wins_over_appdata() {
        assert_eq!(
            pick_config_dir(
                Some(r"E:\p\.tmp\shot\config".into()),
                Some(r"C:\Roaming".into())
            ),
            Some(PathBuf::from(r"E:\p\.tmp\shot\config"))
        );
    }

    #[test]
    fn config_dir_empty_override_is_not_an_override() {
        // 环境变量被设成空串是常见手滑，静默当成「指向当前目录」会写得到处都是。
        assert_eq!(
            pick_config_dir(Some("".into()), Some(r"C:\Roaming".into())),
            Some(PathBuf::from(r"C:\Roaming").join("LitePad"))
        );
    }

    #[test]
    fn config_dir_without_appdata_is_none() {
        assert_eq!(pick_config_dir(None, None), None);
    }

    /// B144：`log_level` 是**后加**的设置项，旧配置文件里没有这个字段。
    /// 反序列化出来是空串，直接 `Level::parse("")` 会拿到 info —— 那会把
    /// debug 构建默认的 debug 也抹掉，于是「开发版该有的日志凭空少了一档」。
    #[test]
    fn log_level_defaults_to_the_builtin_one_when_unset() {
        assert_eq!(
            Settings::default().log_level,
            "",
            "默认必须是空串：它代表「没配过，走内置默认」"
        );
        assert_eq!(
            Level::parse_or_default(&Settings::default().log_level),
            logging::default_level()
        );
        // 配了就得认：用户/manual 手动下调的级别不能被内置默认盖掉
        assert_eq!(Level::parse_or_default("trace"), Level::Trace);
        assert_eq!(Level::parse_or_default("debug"), Level::Debug);
    }

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

    /// B126 / B129：视图位置要跟着会话走。
    ///
    /// 编辑器侧与纯预览侧**共用 `scrollTop` 这一个槽**（B136 试过拆成 `topLine` +
    /// `scrollTop` 两个字段各管一段，结果两端都得靠 `view_mode` 猜是谁的，又绕回
    /// B129 那个「编辑器顶行被污染成 0」的坑 —— 已回退），由前端按 `view_mode`
    /// 决定它眼下记的是编辑器还是预览容器的位置。
    ///
    /// 只记光标行列是不够的：恢复后文件停在开头、光标却在第 N 行（屏幕外），
    /// 用户看到的就是「光标丢了」。缺字段时回落 None，前端按光标位置自行定位。
    #[test]
    fn session_carries_viewport_position() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "encoding": "UTF-8", "eol": "LF",
                  "cursorLine": 12, "cursorCol": 5,
                  "scrollTop": 842 }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;

        let state: SessionState = serde_json::from_str(json).expect("应能读入带 scrollTop 的会话");
        let tab = &state.panels[0].tabs[0];
        assert_eq!(tab.scroll_top, Some(842), "视口位置应原样读到");
        let out = serde_json::to_string(&state).unwrap();
        assert!(
            out.contains("\"scrollTop\":842"),
            "落盘应为 scrollTop：{out}"
        );
        assert!(
            !out.contains("topLine"),
            "不应再落盘已回退的 topLine：{out}"
        );

        // 旧会话没有这个字段 → None，不能因为缺字段把整份会话判死
        let old = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "encoding": "UTF-8", "eol": "LF",
                  "cursorLine": 3, "cursorCol": 1 }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;
        let old_state: SessionState = serde_json::from_str(old).expect("旧会话应照旧可读");
        let old_tab = &old_state.panels[0].tabs[0];
        assert_eq!(old_tab.scroll_top, None);
    }

    /// B143：视口位置**带小数**时也必须能读进来。
    ///
    /// 浏览器 `scrollTop` 是 double：系统缩放不是 100% 时，「滚到底」= `scrollHeight
    /// - clientHeight` 几乎必然是小数（125% 缩放尤其）。以前这个字段是裸 `u32`：
    /// 一个 `842.4` 就让**整份** `SessionState` 反序列化失败 ⇒ `save_session` 报错 ⇒
    /// 前端静默吞掉 ⇒ 会话从此一次也写不进去，用户只看到「位置不再刷新」。
    ///
    /// 所以：整数照旧、小数四舍五入、`null` 仍是 None。
    #[test]
    fn scroll_top_accepts_fractional_pixels() {
        let mk = |scroll: &str| -> String {
            format!(
                r#"{{
                  "panels": [
                    {{ "tabs": [
                        {{ "path": "a.md", "encoding": "UTF-8", "eol": "LF",
                          "cursorLine": 12, "cursorCol": 5,
                          "scrollTop": {scroll} }}
                      ], "active": 0 }}
                  ],
                  "layout": {{ "kind": "leaf", "panelId": 0 }},
                  "activePanel": 0
                }}"#
            )
        };

        // 反向印证：裸 `u32` 确实接不住小数 —— 这正是「整份会话读不出来」的原因，
        // 也是必须挂 `de_scroll_top` 的理由（修法不是拍脑袋来的）。
        assert!(
            serde_json::from_str::<Option<u32>>("842.4").is_err(),
            "裸 u32 应拒绝小数（否则本用例就没有意义）"
        );

        let frac: SessionState =
            serde_json::from_str(&mk("842.4")).expect("小数 scrollTop 不能让整份会话读不出来");
        assert_eq!(frac.panels[0].tabs[0].scroll_top, Some(842));

        let frac_up: SessionState = serde_json::from_str(&mk("842.6")).unwrap();
        assert_eq!(
            frac_up.panels[0].tabs[0].scroll_top,
            Some(843),
            "四舍五入，不是截断"
        );

        // 整数那条老路径不能因为改了反序列化就走样
        let int: SessionState = serde_json::from_str(&mk("842")).unwrap();
        assert_eq!(int.panels[0].tabs[0].scroll_top, Some(842));

        let none: SessionState = serde_json::from_str(&mk("null")).unwrap();
        assert_eq!(none.panels[0].tabs[0].scroll_top, None);

        // 负数（异常值）按「没位置」处理，不许把整份会话判死
        let neg: SessionState = serde_json::from_str(&mk("-3.5")).unwrap();
        assert_eq!(neg.panels[0].tabs[0].scroll_top, None);
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

    /// B114：Settings 新增 `tab_style`。
    /// 老配置文件里没有这个字段——`#[serde(default)]` 必须让它回落 "connected"，
    /// 否则 `load()` 会因为缺字段直接整体失败、用户所有偏好一起丢。
    #[test]
    fn settings_without_tab_style_falls_back_to_connected() {
        let json = r#"{ "theme": "dark" }"#;

        let s: Settings = serde_json::from_str(json).expect("缺 tab_style 也应能读入");
        assert_eq!(s.tab_style, "connected", "未知/缺失应回落 connected");
        assert_eq!(Settings::default().tab_style, "connected");
    }

    /// 落盘的字段名必须是 tab_style（前端按同名读取，理由同 keymap_preset）。
    #[test]
    fn settings_tab_style_round_trip() {
        let s = Settings {
            tab_style: "pill".into(),
            ..Settings::default()
        };
        let out = serde_json::to_string(&s).unwrap();
        assert!(
            out.contains("\"tab_style\":\"pill\""),
            "落盘字段应为 snake_case tab_style：{out}"
        );
    }

    /// B115：Settings 新增 `tab_action_reserve_space`。老配置缺字段必须回落
    /// true（对齐 VS Code 默认），否则 load() 整体失败、用户偏好一起丢。
    #[test]
    fn settings_without_tab_action_reserve_space_falls_back_to_true() {
        let json = r#"{ "theme": "dark" }"#;

        let s: Settings =
            serde_json::from_str(json).expect("缺 tab_action_reserve_space 也应能读入");
        assert!(
            s.tab_action_reserve_space,
            "缺失应回落 true（VS Code 默认）"
        );
        assert!(Settings::default().tab_action_reserve_space);
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
