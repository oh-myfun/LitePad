//! 配置持久化（%APPDATA%\LitePad\settings.json）。
//!
//! M0 只落地主题等少量偏好；会话/布局持久化属于 M2。
//! `#[serde(default)]` 保证旧版本配置文件缺字段时也能读出来（前向兼容）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// B305：最近打开名单（独立文件 `recents.json`，理由见 `recent.rs` 头部）。
pub mod recent;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// "system" | "light" | "dark"
    pub theme: String,
    /// B377：VS Code 默认主题族（"2026" | "modern" | "plus" | "classic" | "hc"）。
    ///
    /// 只影响配色，不参与「深/浅」判定（那一档仍由 `theme` + 系统主题决定）。
    /// 旧配置缺这一格 ⇒ `#[serde(default)]` 给默认 "2026"（本版起的默认配色）。
    pub theme_family: String,
    /// 新建文件的默认行尾
    pub default_eol: String,
    /// 打开文件时编码识别失败后的兜底编码
    pub default_encoding: String,
    /// B372：新建空白文档的默认语言（VS Code `files.defaultLanguage`）。
    /// 空串 = 不指定（未命名文档按纯文本起）；否则是前端语言注册表的标签。
    /// 后端不校验取值 —— 未知标签由前端按自动处理（同 `keymap_preset` 的口径）。
    pub default_lang: String,
    pub recent_files: Vec<String>,
    pub font_size: f64,
    /// 编辑器等宽字体族名；空串 = 用内置默认栈（Cascadia Code / Consolas…）
    pub font_family: String,
    /// B227：代码字体族名（预览 code / pre）；空串 = 用内嵌 Cascadia Mono
    pub code_font_family: String,
    /// B347：界面字体族名（只有窗口外壳）；空串 = 用内嵌那颗度量别名 face
    pub ui_font_family: String,
    /// 编辑器行距（1.0–2.5，默认 1.5），作用于 .cm-content
    pub editor_line_height: f64,
    pub word_wrap: bool,
    /// 查看 → 显示不可见字符（VS Code 的 `editor.renderWhitespace = all`），默认关。
    pub show_invisibles: bool,
    /// 自动保存：把脏文档写回**原文件**（对应 VS Code `files.autoSave`）。
    /// B68 起默认 **false**，对齐 VS Code 桌面版默认值——它和热退出是两件事，
    /// 详见 `backup` 模块头部注释。
    pub autosave: bool,
    /// 热退出：关窗时把未保存内容写进独立副本，于是不必再弹「未保存将丢失」的
    /// 确认框，下次启动还原成未保存标签（对应 VS Code `files.hotExit`）。
    /// B68 起默认 **true**，对齐 VS Code 桌面版的 `onExit`。
    pub hot_exit: bool,
    /// B235：预览**正文内容区**的宽度档位（`standard` / `wide` / `full`，默认 `full`）。
    ///
    /// ⚠️ 这是**正文居中宽度**（原先硬编码在 `preview.css` 的 `max-width: 860px`），
    ///    不是源码与预览两栏的分屏比例 —— 那个由拖拽分隔条管，仍是另一件事。
    /// 存**档位名**而不是 px：换分辨率/缩放后同一档的观感才稳定，也便于以后调值。
    pub preview_width: String,
    /// 大纲（TOC）抽屉宽度（px，160–640，默认 240）。前端拖拽分隔条后回写。
    pub toc_width: f64,
    /// B194：大纲（左侧栏）是否展开（默认 false，与前端 index.html 的 `hidden` 初值一致）。
    ///
    /// 与 `toc_width` 同属设置而非会话：它是**窗口级外观状态**（关掉再开应保持原样），
    /// 不跟着某份文档走。
    pub toc_open: bool,
    /// B312：展开区摊开的是**哪一块**（`"toc"` 大纲 / `"recent"` 最近打开，默认 `"toc"`）。
    ///
    /// 与 `toc_open` 是一对：那颗管「开没开」，这颗管「开着的是谁」。后端不校验取值
    /// —— 未知值由前端回落成 `"toc"`，理由同 `keymap_preset`（枚举是前端概念，
    /// 放到后端反而要跟着前端改）。旧配置文件缺这一格 ⇒ `#[serde(default)]` 给 `"toc"`。
    pub drawer_view: String,
    /// B198：整个左栏（按钮列 + 展开区 + 中间缝）是否**收起**（默认 false = 左栏在）。
    ///
    /// 与 `toc_open` 是两层、互不撤销：`sidebar_off` 管「左栏在不在」，
    /// `toc_open` 管「卡片里的展开区开没开」—— 整栏收起时展开区的开合值照旧留着，
    /// 重新露出时回到用户上次的样子。
    pub sidebar_off: bool,
    /// B314 → B424：**旧的单根字段**，只为把老配置读上来而留，前端不再认识它
    /// （`src/ipc/api.ts` 的 `Settings` 里已删）。
    ///
    /// 权威从这一格换到 `folder_roots`。`load` 里做一次迁移（老配置单根 ⇒ 多根的第一项）。
    /// ⚠️ 前端不再带这一格 ⇒ 任何一次落盘都会把它抹掉（容器级 `#[serde(default)]` 给空串，
    /// 加上 `skip_serializing_if` 就写不出文件）。这正是要的效果：否则「用户把目录全移除了」
    /// 之后，下一次启动那格老值又把目录复活（B392 / B304 那一族：空表与缺格是两件事）。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub folder_root: String,
    /// B424（用户「资源管理器支持打开多个目录」）：**全部**文件夹根，顺序 = 侧栏从上到下
    /// （空表 = 没开文件夹）。
    ///
    /// 与 `toc_open` / `drawer_view` 同一层：窗口级外观状态归设置，不归某份文档的会话。
    /// 只存根、不存展开态 —— 展开态是这一轮浏览的临时足迹，存下来下次启动要先画半屏
    /// 再挨个读每层目录，得不偿失。旧配置缺这格 ⇒ 容器级 `#[serde(default)]` 给空表。
    #[serde(default)]
    pub folder_roots: Vec<String>,
    /// B426（用户「搜索的排除设置和忽略文件要能在设置窗口中进行设置」）：**应用级**排除模式，
    /// 逗号 / 换行分隔的 glob。定位照 VS Code 的 `search.exclude`：它与搜索面板「⋯」里那框
    /// **叠加**（那框是这一次搜索的临时追加，VS Code 也只把它存进视图状态、不写设置）。
    /// 后端不解释内容，只存取 —— 合法性与合并都在前端 `search/store.ts` 的 `mergeGlobs`。
    #[serde(default)]
    pub search_exclude: String,
    /// B426：「忽略文件」= 递归读 `.gitignore` / `.ignore`（VS Code `search.useIgnoreFiles`）。
    /// ⚠️ `Option<bool>`：`None` = **老配置里没这一格** ⇒ 消费方按「开」处理。
    /// 直接收成 `bool` 会把缺键读成 false，等于给用户悄悄把忽略清单停了（B392 那一族）。
    #[serde(default)]
    pub search_use_ignore_files: Option<bool>,
    /// B452-5（用户拍板：PlantUML 走在线服务器，vditor 同款）：那台服务器的地址。
    ///
    /// 空串 = 用前端内置默认（`src/markdown/diagrams.ts` 的 `PLANTUML_SERVER_DEFAULT`）。
    /// 后端不校验 URL 合法性（照 `search_exclude` 的口径：内容语义归前端），也不给它单开
    /// `Option` 一档 —— 这里「没记过」与「用户清空」要落到同一个地方（默认那台），
    /// 与 B392 那一族（缺键读成 false 会**改变行为**）不是同一件事。
    #[serde(default)]
    pub plantuml_server: String,
    /// 快捷键覆盖表：命令 id → 键位串（空串 = 显式解绑）。
    /// 后端不解释内容，只负责存取；合法性由前端 keymap 模块过滤。
    pub keymap: HashMap<String, String>,
    /// 键位预设 id（"default" | "notepadpp" | "vscode"）。
    /// 优先级：keymap 覆盖 > keymap_preset > 命令默认值。未知值由前端回落默认，
    /// 后端不校验——预设是前端概念，放到后端枚举反而要跟着前端改。
    pub keymap_preset: String,
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
            theme_family: "2026".into(),
            default_eol: "CRLF".into(),
            default_encoding: "UTF-8".into(),
            default_lang: String::new(),
            recent_files: Vec::new(),
            font_size: 14.0,
            font_family: String::new(),
            code_font_family: String::new(),
            ui_font_family: String::new(),
            editor_line_height: 1.5,
            word_wrap: true,
            show_invisibles: false,
            // B68：两个开关各管一件事，默认值对齐 VS Code 桌面版
            // （自动保存关、热退出开）。别顺手把 autosave 改回 true——
            // 自动保存会写脏用户的文件，热退出只写自己的备份区。
            autosave: false,
            hot_exit: true,
            // B235：默认「全宽」—— 用户明确要的是不限宽，正文铺满预览区。
            preview_width: "full".into(),
            toc_width: 240.0,
            toc_open: false,
            drawer_view: "toc".into(),
            sidebar_off: false,
            folder_root: String::new(),
            folder_roots: Vec::new(),
            // B426：默认「不额外排除、跟随忽略文件」。`None` 是「没记过」，前端按开处理 ——
            // 写 `Some(true)` 会让落盘文件凭空多一格且与缺键等价（两套口径，B304 那一族）。
            search_exclude: String::new(),
            search_use_ignore_files: None,
            // B452-5：空串 = 用前端内置那台默认服务器（与「没记过」同一档，见字段注释）。
            plantuml_server: String::new(),
            keymap: HashMap::new(),
            keymap_preset: "default".into(),
            tab_action_reserve_space: true,
            log_level: String::new(),
        }
    }
}

/// 配置根目录：发布版默认 `%APPDATA%\LitePad`，dev 构建默认 `%APPDATA%\LitePad-dev`，
/// 两者都可用 **`LITEPAD_CONFIG_DIR`** 整体覆盖。
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
        cfg!(debug_assertions),
    )
}

/// 纯函数版（不读全局环境，便于断言）：覆盖优先，且**空串不算覆盖**
/// （环境变量被设成空是很常见的手滑，静默当成"指向当前目录"会写得到处都是）。
///
/// B408：dev 构建（`npm run tauri dev` / 直接 cargo build）默认落 `LitePad-dev` ——
/// 开发时的会话、设置、最近打开、日志、备份都**不碰已安装版**的 `%APPDATA%\LitePad`。
/// 这样开发实例可以和用户正在用的安装版同时开着，互不覆盖。
fn pick_config_dir(
    override_dir: Option<std::ffi::OsString>,
    appdata: Option<std::ffi::OsString>,
    dev_build: bool,
) -> Option<PathBuf> {
    match override_dir {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => appdata
            .map(|d| PathBuf::from(d).join(if dev_build { "LitePad-dev" } else { "LitePad" })),
    }
}

/// 配置文件路径。当前构建仅面向 Windows，默认落在 APPDATA。
pub fn settings_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join("settings.json"))
}

/// B424：老配置的**单根**读上来时迁成多根的第一项。
///
/// 只在读的时候做一次：`folder_roots` 已经有内容（哪怕是空表落不下去的那种「用户全移除了」
/// —— 那种情况老字段也已经没了）就不动它，迁移不许覆盖用户后来的选择。
fn migrated(mut s: Settings) -> Settings {
    if s.folder_roots.is_empty() && !s.folder_root.is_empty() {
        s.folder_roots = vec![std::mem::take(&mut s.folder_root)];
    }
    s
}

/// 读取配置；任何异常都静默回落默认值，绝不让配置损坏导致启动失败。
///
/// ⚠️ 「静默」只针对调用方：这里仍然记一条 warn（B144）。之前是连日志都没有的 ——
/// 用户抱怨「设置怎么老是被重置」，查了半天才发现是 `settings.json` 被人手改坏了。
pub fn load() -> Settings {
    if let Some(path) = settings_path() {
        match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<Settings>(&content) {
                Ok(settings) => return migrated(settings),
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
    /// B169：同步滚动开关（按文档记，B152）。恢复时经**唯一写点** `setDocSyncMode` 写回
    /// 前端 `docSyncModes`；它管的不只是标题栏那颗键的点亮态 —— 协调器每一发广播都要先问它。
    ///
    /// ⚠️ 类型必须是 `Option<bool>`：`None` = 「这份文档从没记过」，前端按**开着**缺省
    /// （`core/app-state.ts` 的 `docSyncOn`），`Some(false)` = 用户明确关掉过（B297：两头都要写）。
    /// 收成 `bool` 时缺键会经容器级 `#[serde(default)]` 反序列化成 `false`（B392），
    /// 旧版会话升上来 ⇒ 同步滚动**静默变关**，而且显示与行为一致，用户只当「同步不灵了」。
    /// Rust 只透传这三态，缺省口径由前端定。
    #[serde(alias = "sync_mode")]
    pub sync_mode: Option<bool>,
    /// B302：这一格上次被看到时的共享坐标 `v`（源码行号 + 小数，与宽度无关）。
    ///
    /// `None` ＝「这一格从没被看到过」，与 `Some(1.0)`（就停在顶部）是两件事：恢复时先取
    /// 自己这一份，取不到才借同文档别的实例那一份。Rust 只透传，换算全在前端。
    #[serde(alias = "scroll_v")]
    pub scroll_v: Option<f64>,
    /// B461：这一条记录是哪种标签 —— `Some("diff")` = 差异编辑器，`None` = 普通编辑器标签。
    ///
    /// ⚠️ 必须是 `Option`（B392 同一课）：旧会话压根没这个键，收成 `String` 会让缺键变成
    /// 空串甚至读失败；前端只认显式的 `"diff"`（`diff/model.ts` 的 `diffKindOf`）。
    /// **不挂** `skip_serializing_if`：普通标签也要显式落 `null`，「没记过」与「记了是普通
    /// 标签」在盘上分得开，下一次改判据时才有据可依。Rust 只透传，不解释取值。
    pub kind: Option<String>,
    /// B461：B 档差异的左栏文件路径（右栏就是 `path` 那份文档）；A 档与普通标签都是 `None`。
    /// 后端不读它、不校验它，原样透传给前端。
    pub diff_left_path: Option<String>,
    /// 预览标签（VS Code 的 preview tab）：资源管理器单击打开的那一张，下一次单击会原位
    /// 替换它（前端画斜体）。
    ///
    /// ⚠️ 必须是 `Option<bool>`：旧会话压根没这个键（B392 同一课），收成 `bool` 会被容器级
    /// `#[serde(default)]` 读成 `false` —— 恰好也是「永久标签」的缺省口径，但「没记过」与
    /// 「记了不是预览」就分不开了。Rust 只透传，不解释取值。
    pub preview: Option<bool>,
    /// 这份「有未保存修改」的内容对应的**已保存磁盘版本**（mtime 毫秒 + 字节数）。
    ///
    /// 热退出副本里只有改过之后的正文，恢复出来的脏文档因此没有基线、没法「与上次保存
    /// 比较」。记下这一对版本：恢复时盘上若还停在这一版，盘上正文就是上次保存的正文。
    /// `None` = 旧会话没记过 / 文档从未落过盘 —— 前端保持「基线未知」，不拿空正文冒充。
    #[serde(alias = "disk_mtime_ms")]
    pub disk_mtime_ms: Option<i64>,
    #[serde(alias = "disk_size")]
    pub disk_size: Option<u64>,
    /// B193：仅 `satellite_tabs` 段使用 —— 该标签当时属于哪个卫星窗口（label 作分组键）。
    /// `None` = 旧会话没写过这个字段，整批当作同一组。
    #[serde(alias = "owner")]
    pub owner: Option<String>,
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
            sync_mode: None,
            scroll_v: None,
            kind: None,
            diff_left_path: None,
            preview: None,
            disk_mtime_ms: None,
            disk_size: None,
            owner: None,
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
/// ⚠️ 静默是对调用方而言，日志照样记（B144）：B143 那个坑（前端写出的小数让整份
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
                Some(r"C:\Roaming".into()),
                false
            ),
            Some(PathBuf::from(r"E:\p\.tmp\shot\config"))
        );
    }

    #[test]
    fn config_dir_empty_override_is_not_an_override() {
        // 环境变量被设成空串是常见手滑，静默当成「指向当前目录」会写得到处都是。
        assert_eq!(
            pick_config_dir(Some("".into()), Some(r"C:\Roaming".into()), false),
            Some(PathBuf::from(r"C:\Roaming").join("LitePad"))
        );
    }

    #[test]
    fn config_dir_without_appdata_is_none() {
        assert_eq!(pick_config_dir(None, None, false), None);
    }

    /// B408：dev 构建默认用 `LitePad-dev`，与已安装版的 `LitePad` 分开；
    /// 显式覆盖仍然最优先（截图/台子把一切写进 `.tmp` 的口子不能丢）。
    #[test]
    fn config_dir_dev_build_uses_separate_leaf() {
        assert_eq!(
            pick_config_dir(None, Some(r"C:\Roaming".into()), true),
            Some(PathBuf::from(r"C:\Roaming").join("LitePad-dev"))
        );
        assert_eq!(
            pick_config_dir(
                Some(r"E:\p\.tmp\shot\config".into()),
                Some(r"C:\Roaming".into()),
                true
            ),
            Some(PathBuf::from(r"E:\p\.tmp\shot\config"))
        );
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

    /// 预览标签（VS Code 的 preview tab）：`preview` 键两头都要活着。
    ///
    /// 这个字段纯透传，最容易犯的错是「前端加了、Rust 结构体没加」—— serde 会把多余字段
    /// 丢掉，落盘一次就没了，于是重启后斜体预览标签悄悄变成永久标签。
    #[test]
    fn session_carries_preview_flag() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "preview": true },
                { "path": "b.md" }
            ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;

        let state: SessionState = serde_json::from_str(json).expect("应能读入 preview");
        assert_eq!(state.panels[0].tabs[0].preview, Some(true));
        assert_eq!(
            state.panels[0].tabs[1].preview, None,
            "没记过的标签必须保持 None，不能读成 false"
        );

        let out = serde_json::to_string(&state).unwrap();
        assert!(out.contains("\"preview\":true"), "落盘要带 preview：{out}");
    }

    /// B302：会话要带每格自己的视口位置 `scrollV`（共享坐标 `v`）。
    ///
    /// 两头都要钉：`scrollV`（camelCase）读得进来、落得出去；而**缺省必须是 `None`**——
    /// `Some(1.0)`（停在顶部）与 `None`（从没记过）在恢复端是两条不同的路（文档级兜底只在
    /// `None` 时启用）。旧会话没有这个字段也归 `None`，不能读成 1。
    #[test]
    fn session_carries_per_tab_scroll_v() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "docId": 1, "scrollV": 42.5 },
                { "path": "b.md", "docId": 2, "scrollV": null },
                { "path": "c.md", "docId": 3 }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;
        let state: SessionState =
            serde_json::from_str(json).expect("scrollV 应能按 camelCase 读入");
        assert_eq!(state.panels[0].tabs[0].scroll_v, Some(42.5));
        assert_eq!(
            state.panels[0].tabs[1].scroll_v, None,
            "显式 null（从没记过）与有值必须分得开"
        );
        assert_eq!(
            state.panels[0].tabs[2].scroll_v, None,
            "旧会话没有这个字段 ⇒ None，不能读成停在顶部"
        );

        let out = serde_json::to_string(&state).unwrap();
        assert!(out.contains("\"scrollV\""), "落盘应为 scrollV：{out}");
        assert!(!out.contains("scroll_v"), "不应落 snake_case：{out}");
    }

    /// B461：差异标签的两格会话字段。四件事都要钉住：
    ///  ① 旧会话缺 `kind` / `diffLeftPath` ⇒ 透传回前端是 `null`（不许变成 `"diff"`，
    ///     也不许整格消失 —— 前端 `diffKindOf` 只认显式的 `"diff"`）；
    ///  ② A 档记 `kind:"diff"` + `diffLeftPath:null`，B 档记那条左栏路径，各自原样回来；
    ///  ③ 落盘字段名是 camelCase（前端按同名读写），且 `null` **显式落盘**；
    ///  ④ 后端不解释取值：认不出的串原样透传，由前端回落成普通标签。
    #[test]
    fn session_carries_diff_kind_and_left_path() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "docId": 1 },
                { "path": "a.md", "docId": 1, "kind": "diff", "diffLeftPath": null },
                { "path": "b.md", "docId": 2, "kind": "diff", "diffLeftPath": "E:\\cmp\\left.md" },
                { "path": "c.md", "docId": 3, "kind": "weird" }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;
        let state: SessionState =
            serde_json::from_str(json).expect("差异两格应能按 camelCase 读入");
        let wire = |i: usize| -> serde_json::Value {
            serde_json::to_value(&state.panels[0].tabs[i]).unwrap()
        };
        assert_eq!(state.panels[0].tabs[0].kind, None, "旧会话缺键 ⇒ None");
        assert_eq!(
            wire(0)["kind"],
            serde_json::json!(null),
            "缺键也要显式落 null"
        );
        assert_eq!(
            wire(0)["diffLeftPath"],
            serde_json::json!(null),
            "缺键也要显式落 null（不许 skip_serializing_if 把整格抹掉）"
        );
        assert_eq!(wire(1)["kind"], serde_json::json!("diff"));
        assert_eq!(
            wire(1)["diffLeftPath"],
            serde_json::json!(null),
            "A 档没有左栏路径"
        );
        assert_eq!(
            wire(2)["diffLeftPath"],
            serde_json::json!("E:\\cmp\\left.md")
        );
        assert_eq!(
            wire(3)["kind"],
            serde_json::json!("weird"),
            "后端不校验取值，认不出的串原样透传（前端回落普通标签）"
        );

        let out = serde_json::to_string(&state).unwrap();
        assert!(
            out.contains("\"diffLeftPath\""),
            "落盘应为 camelCase：{out}"
        );
        assert!(!out.contains("diff_left_path"), "不应落 snake_case：{out}");
        assert_eq!(TabSession::default().kind, None);
        assert_eq!(TabSession::default().diff_left_path, None);
    }

    /// 会话要带「这份脏内容对应的已保存磁盘版本」（mtime 毫秒 + 字节数）。
    ///
    /// 恢复端靠它判断盘上还是不是上次保存的那一份：对得上才能把盘上正文当基线，
    /// 对不上（关闭期间被外部改过）基线就作废。旧会话缺这两个键 ⇒ `None`（基线未知）。
    #[test]
    fn session_carries_saved_disk_version() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "docId": 1, "diskMtimeMs": 1700000000123, "diskSize": 42 },
                { "path": "b.md", "docId": 2, "diskMtimeMs": null, "diskSize": null },
                { "path": "c.md", "docId": 3 }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;
        let state: SessionState =
            serde_json::from_str(json).expect("磁盘版本应能按 camelCase 读入");
        assert_eq!(state.panels[0].tabs[0].disk_mtime_ms, Some(1700000000123));
        assert_eq!(state.panels[0].tabs[0].disk_size, Some(42));
        assert_eq!(
            state.panels[0].tabs[1].disk_mtime_ms, None,
            "显式 null 透传"
        );
        assert_eq!(
            state.panels[0].tabs[2].disk_mtime_ms, None,
            "旧会话缺键 ⇒ None（基线未知），不能读成 0"
        );

        let out = serde_json::to_string(&state).unwrap();
        assert!(out.contains("\"diskMtimeMs\""), "落盘应为 camelCase：{out}");
        assert!(out.contains("\"diskSize\""), "落盘应为 camelCase：{out}");
        assert!(!out.contains("disk_mtime_ms"), "不应落 snake_case：{out}");
        assert_eq!(TabSession::default().disk_mtime_ms, None);
        assert_eq!(TabSession::default().disk_size, None);
    }

    /// B392：`syncMode` **缺键不许读成「关着」**。
    ///
    /// 前端口径是「没记过 = 开」（`core/app-state.ts` 的 `docSyncOn`），而恢复时
    /// `setDocSyncMode(docId, st.syncMode !== false)` 是这篇文档同步开关的**唯一写点**。
    /// Rust 侧若把缺键收成 `false`，旧版会话升上来 ⇒ 同步滚动**静默变关**：协调器帧在
    /// `isOn` 那道闸直接 return，界面上开关与行为此刻还一致（两边都关），用户只会觉得
    /// 「同步怎么不灵了」。B391 spike 的真机台第一轮那批 FAIL 全是这么造出来的。
    ///
    /// 判据问的是**透传给前端的那份线形状**（前端只看得见 JSON），不是 Rust 字段类型。
    #[test]
    fn legacy_session_without_sync_mode_is_not_read_as_off() {
        let json = r#"{
          "panels": [
            { "tabs": [
                { "path": "a.md", "docId": 1 },
                { "path": "b.md", "docId": 2, "syncMode": false },
                { "path": "c.md", "docId": 3, "syncMode": true },
                { "path": "d.md", "docId": 4, "sync_mode": false }
              ], "active": 0 }
          ],
          "layout": { "kind": "leaf", "panelId": 0 },
          "activePanel": 0
        }"#;
        let state: SessionState = serde_json::from_str(json).expect("会话应能按 camelCase 读入");
        let wire = |i: usize| -> serde_json::Value {
            serde_json::to_value(&state.panels[0].tabs[i]).unwrap()
        };
        assert_ne!(
            wire(0)["syncMode"],
            serde_json::json!(false),
            "缺键（没记过）透传回前端不许变成一个 false —— 前端拿到 false 就是关"
        );
        assert_eq!(
            wire(1)["syncMode"],
            serde_json::json!(false),
            "记了 false 必须还是关着（B297：两头都要写，否则用户关掉的开关自己翻回去）"
        );
        assert_eq!(wire(2)["syncMode"], serde_json::json!(true));
        assert_eq!(
            wire(3)["syncMode"],
            serde_json::json!(false),
            "旧版 snake_case 的 sync_mode 仍要认"
        );
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

    /// B312：老配置缺 `drawer_view` 必须回落 `"toc"`（容器级 `#[serde(default)]`），
    /// 否则 load() 整体失败、用户全部偏好一起丢。
    #[test]
    fn settings_without_drawer_view_falls_back_to_toc() {
        let json = r#"{ "theme": "dark" }"#;

        let s: Settings = serde_json::from_str(json).expect("缺 drawer_view 也应能读入");
        assert_eq!(s.drawer_view, "toc", "缺失应回落大纲");
        assert_eq!(Settings::default().drawer_view, "toc");
    }

    /// B426（用户「搜索的排除设置和忽略文件要能在设置窗口中进行设置」）：
    /// 新增的两格都必须**缺得起** —— 老配置缺键不能整体读不上来。
    /// ⚠️ `search_use_ignore_files` 用 `Option<bool>`：缺键 = 没记过 ⇒ 消费方按「开」处理，
    ///    读成 `false` 就是把用户的忽略清单静默停掉（B392 同一课的第二次）。
    #[test]
    fn settings_search_exclude_and_ignore_files_default() {
        let json = r#"{ "theme": "dark" }"#;
        let s: Settings = serde_json::from_str(json).expect("缺 search_* 两格也应能读入");
        assert_eq!(s.search_exclude, "");
        assert_eq!(s.search_use_ignore_files, None, "没记过 ≠ 关着");
        assert_eq!(Settings::default().search_use_ignore_files, None);

        let typed = Settings {
            search_exclude: "dist/**, *.tmp".into(),
            search_use_ignore_files: Some(false),
            ..Settings::default()
        };
        let text = serde_json::to_string(&typed).expect("存得出去");
        let back: Settings = serde_json::from_str(&text).expect("读得上来");
        assert_eq!(back.search_exclude, "dist/**, *.tmp");
        assert_eq!(back.search_use_ignore_files, Some(false));
    }

    /// B452-5：PlantUML 服务器地址。老配置缺这一格必须读得上来且落回「空串 = 用内置默认那台」；
    /// 用户填的那串原样存回去（后端不解释 URL）。
    #[test]
    fn settings_plantuml_server_default_and_round_trip() {
        let s: Settings =
            serde_json::from_str(r#"{ "theme": "dark" }"#).expect("缺 plantuml_server 也应能读入");
        assert_eq!(s.plantuml_server, "", "缺格 = 空串 ⇒ 前端用默认服务器");
        assert_eq!(Settings::default().plantuml_server, "");

        let typed = Settings {
            plantuml_server: "https://my.server/plantuml".into(),
            ..Settings::default()
        };
        let back: Settings =
            serde_json::from_str(&serde_json::to_string(&typed).expect("存得出去"))
                .expect("读得上来");
        assert_eq!(back.plantuml_server, "https://my.server/plantuml");
    }

    /// B312：落盘字段名必须是 drawer_view（前端 Settings 按同名读写）。
    /// 后端**不校验**取值 —— `"recent"` 原样存，未知串由前端回落 `"toc"`，理由同 keymap_preset。
    #[test]
    fn settings_drawer_view_round_trip() {
        let s = Settings {
            drawer_view: "recent".into(),
            ..Settings::default()
        };
        let out = serde_json::to_string(&s).unwrap();
        assert!(
            out.contains("\"drawer_view\":\"recent\""),
            "落盘字段应为 snake_case drawer_view：{out}"
        );
    }

    /// B314 → B424：资源管理器的根。四件事都要钉住：
    ///  ① 老配置缺 `folder_roots` ⇒ 空表（不许整体读失败，否则用户全部偏好一起丢）；
    ///  ② 只有老单根那一格 ⇒ `migrated` 把它挪成第一项，并且**清掉老字段**（两格说同一件
    ///     事就是「该信哪一格」的开始）；
    ///  ③ 两格都有 ⇒ 迁移不许覆盖用户后来的选择；
    ///  ④ 「把目录全移除了」落的是空表 ⇒ 读回来还是空表，老值不许把它复活（B392 那一族：
    ///     空表与缺格是两件事，但这里两格都得是空才算真没开）。
    #[test]
    fn settings_folder_roots_round_trip_and_migrates_legacy_single_root() {
        let bare: Settings =
            serde_json::from_str(r#"{ "theme": "dark" }"#).expect("缺 folder_roots 也应能读入");
        assert!(bare.folder_roots.is_empty(), "缺失应回落空表（没开文件夹）");
        assert!(Settings::default().folder_roots.is_empty());

        let legacy = migrated(Settings {
            folder_root: r"C:\笔记".into(),
            ..Settings::default()
        });
        assert_eq!(
            legacy.folder_roots,
            vec![r"C:\笔记".to_string()],
            "老单根要迁成第一项"
        );
        assert_eq!(legacy.folder_root, "", "迁完必须清掉老字段");

        let both = migrated(Settings {
            folder_root: r"C:\旧".into(),
            folder_roots: vec![r"C:\甲".into(), r"C:\乙".into()],
            ..Settings::default()
        });
        assert_eq!(
            both.folder_roots,
            vec![r"C:\甲".to_string(), r"C:\乙".to_string()],
            "已经有列表了就不该再问老字段"
        );

        let cleared = serde_json::to_string(&Settings::default()).unwrap();
        assert!(
            !cleared.contains("\"folder_root\":"),
            "空串的老字段不该再落盘（注意别拿 folder_roots 也含这段子串当证据）：{cleared}"
        );
        let back: Settings = serde_json::from_str(&cleared).unwrap();
        assert!(
            migrated(back).folder_roots.is_empty(),
            "移除全部目录不许被老值复活"
        );

        let one = serde_json::to_string(&Settings {
            folder_roots: vec![r"C:\甲".into()],
            ..Settings::default()
        })
        .unwrap();
        assert!(
            one.contains("\"folder_roots\":[\"C:\\\\甲\"]"),
            "落盘字段应为 snake_case folder_roots：{one}"
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
        assert!(
            s.default_lang.is_empty(),
            "B372：新建文档默认类型默认不指定（VS Code files.defaultLanguage 默认空）"
        );

        // 老配置文件里没有 hot_exit —— 必须回落 true 而不是让整个配置读失败。
        let legacy = r#"{ "theme": "dark", "autosave": true }"#;
        let old: Settings = serde_json::from_str(legacy).expect("缺 hot_exit 也应能读入");
        assert!(old.hot_exit, "缺失 hot_exit 应回落 true");
        assert!(
            old.default_lang.is_empty(),
            "缺失 default_lang 应回落空串（旧配置前向兼容）"
        );
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
