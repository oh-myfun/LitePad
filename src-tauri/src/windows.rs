//! 多窗口（B71 ④）：卫星窗口的创建、身份查询与生命周期登记。
//!
//! ## 为什么这一层放在 Rust
//!
//! LitePad 的**文档状态本来就归 Rust**（`AppState.docs`，进程级共享），所以多窗口不需要
//! 复制任何状态 —— 两个窗口天然看到同一批 doc id。Rust 侧只需要补三件事：
//!
//! 1. **建窗**：前端不拿 `core:webview:allow-create-webview-window`，建窗能力只留在 Rust。
//! 2. **身份**：每个窗口启动时问一次「我是谁、我承载什么」。答案里带一份**不透明 payload**，
//!    由源窗口原样塞进来、卫星窗口原样拿走 —— Rust 不解释它的结构，避免把前端标签快照的
//!    字段契约抄到后端来（改一个字段要动两边）。
//! 3. **登记**：label → payload 的映射，窗口销毁时清掉，防止长时间运行后越攒越多。
//!
//! ## 为什么载荷走命令参数而不是「卫星就绪后回问源窗口」
//!
//! 回问式握手有天然竞态：源窗口发完建窗命令后才挂监听，而卫星窗口可能在监听挂上之前
//! 就已经 `emit` 完自己的 ready（WebView 冷启有时比一次 IPC 往返还快）。把载荷**随命令
//! 一起交给 Rust 存着**，卫星启动时直接取，就不存在「谁先谁后」的问题 —— 待传内容在
//! 建窗命令返回前就已经落到位了。
//!
//! ## 窗口标签约定
//!
//! `main` = 主窗口；`sat-<n>` = 卫星窗口（n 是进程内自增序号）。`capabilities/default.json`
//! 里按 `sat-*` 通配授权，所以**不要**把前缀改成别的。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::utils::config::WindowConfig;
use tauri::window::Color;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// 主窗口标签。`capabilities` 与前端身份判定都依赖它。
pub const MAIN_LABEL: &str = "main";

/// 卫星窗口标签前缀（capabilities 按 `sat-*` 通配授权）。
pub const SAT_PREFIX: &str = "sat-";

/// 卫星窗口序号。只增不减；label 只要在**存活窗口**中唯一即可，不复用旧号反而更省心。
static SAT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 新建卫星窗口的初始尺寸与下限。比主窗口小一档：卫星窗口的定位是「把一份文档拎出来
/// 并排看」，不是第二个全功能工作面。
const SAT_WIDTH: f64 = 900.0;
const SAT_HEIGHT: f64 = 640.0;
const SAT_MIN_WIDTH: f64 = 420.0;
const SAT_MIN_HEIGHT: f64 = 300.0;

/// 卫星窗口的预渲染底色。必须与 `main.rs` 的 `BG_DARK` 一致：卫星窗口同样会先由
/// Chromium 用纯白填充，深色主题下就是启动白屏。这里固定用深色 —— 读取用户设置需要
/// 落盘 IO，而建窗前的几十毫秒里窗口已经在绘制了，深色是错得最轻的一侧（浅色主题下
/// 表现为「暗色一闪」，比白屏刺眼程度低得多）。
const SAT_BG: Color = Color(0x1b, 0x1d, 0x1f, 0xff);

/// label → 待交给该窗口的载荷。
#[derive(Default)]
pub struct WindowRegistry {
    payloads: Mutex<HashMap<String, serde_json::Value>>,
}

impl WindowRegistry {
    fn put(&self, label: &str, payload: serde_json::Value) {
        if let Ok(mut map) = self.payloads.lock() {
            map.insert(label.to_string(), payload);
        }
    }

    /// 取走某窗口的载荷。**取走**而不是读取：载荷是「一次性投递」，卫星窗口只会问一次，
    /// 留着只会占内存（里面可能有大文档的正文快照）。
    fn take(&self, label: &str) -> Option<serde_json::Value> {
        self.payloads.lock().ok()?.remove(label)
    }

    /// 载荷是否还没被认领。只被单元测试用到（生产路径上卫星窗口启动就取走），
    /// 所以只在测试构建里编进来，免得给 release 留一个死代码警告。
    #[cfg(test)]
    fn has(&self, label: &str) -> bool {
        self.payloads
            .lock()
            .map(|m| m.contains_key(label))
            .unwrap_or(false)
    }

    fn forget(&self, label: &str) {
        if let Ok(mut map) = self.payloads.lock() {
            map.remove(label);
        }
    }

    /// 窗口销毁时的清理（对外暴露：`main.rs` 的窗口事件回调要用）。
    /// 与 `forget` 分开命名是为了让调用点读起来就是「清掉还没被认领的载荷」，
    /// 而不是「忘了这张表里有这个窗口」。
    pub fn forget_pending(&self, label: &str) {
        self.forget(label);
    }
}

/// 前端启动时的「我是谁」应答。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPayload {
    /// `"main"` | `"satellite"`
    pub kind: String,
    pub label: String,
    /// 仅卫星窗口非空：源窗口塞进来的标签快照（结构由前端定义，Rust 只透传）
    pub payload: serde_json::Value,
}

/// 判定窗口身份。前缀判据与 `capabilities` 的 `sat-*` 必须一致。
pub fn kind_of(label: &str) -> &'static str {
    if label == MAIN_LABEL {
        "main"
    } else {
        "satellite"
    }
}

/// 前端启动时问一次：我是主窗口还是卫星窗口、我承载什么。
///
/// `win` 由 Tauri 注入为**调用方所在窗口**，所以卫星窗口拿不到别人的载荷。
#[tauri::command]
pub fn window_payload(
    win: tauri::WebviewWindow,
    registry: State<'_, WindowRegistry>,
) -> Result<WindowPayload, String> {
    let label = win.label().to_string();
    let kind = kind_of(&label);
    let payload = if kind == "main" {
        serde_json::Value::Null
    } else {
        registry.take(&label).unwrap_or(serde_json::Value::Null)
    };
    Ok(WindowPayload {
        kind: kind.to_string(),
        label,
        payload,
    })
}

/// 挑出「本进程所有 WebView 都必须照抄的那份附加浏览器参数」（B72）。
///
/// ## 为什么这不是「顺手对齐一下」而是建窗成功的前提
///
/// Windows 上同一进程内的 WebView2 **环境按用户数据目录复用**，而 Tauri 会给每个
/// WebView 兜底同一个目录（`%LOCALAPPDATA%\<identifier>`，见
/// `tauri/src/manager/webview.rs` 的「in `windows`, we need to force a data_directory」）。
/// WebView2 的硬规则是：**共用同一用户数据目录的实例，`CoreWebView2EnvironmentOptions`
/// 必须完全一致，否则新建 WebView 直接失败**（`0x8007139F` ERROR_INVALID_STATE，
/// 见 MS Learn `CoreWebView2Environment` 备注与 WebView2Feedback#257）。
///
/// 主窗口的参数来自 `tauri.conf.json` 的 `app.windows[0].additionalBrowserArgs`
/// （我们有 `--disable-gpu`）；而运行期 `WebviewWindowBuilder::new(...)` **不会**继承
/// 这份配置，不显式传就落到 wry 的内置默认值（少了 `--disable-gpu`）→ 参数不一致 →
/// 卫星窗口的 WebView 建不出来 → `build()` 报错，前端只看到「新窗口没能打开」。
/// 这就是 B72 的真实根因：拖出去没有任何窗口出现。
///
/// 取值**读运行时配置**而不是抄一份字符串常量：抄一份就会随 tauri.conf.json 漂移，
/// 而一旦漂移就是「卫星窗口整个打不开」这种致命又难查的故障（正是我们要防的形态）。
fn pick_browser_args(windows: &[WindowConfig]) -> Option<String> {
    // 主窗口那份说了算（它是进程里第一个建起来的 WebView，环境由它定型）；
    // 配置里没有 main 条目时退而取第一条 —— 任何一条都比「什么都不传」强。
    windows
        .iter()
        .find(|w| w.label == MAIN_LABEL)
        .or_else(|| windows.first())
        .and_then(|w| w.additional_browser_args.clone())
}

pub(crate) fn shared_browser_args(app: &AppHandle) -> Option<String> {
    pick_browser_args(&app.config().app.windows)
}

/// 新建卫星窗口，返回它的 label（源窗口据此定位窗口，供「移回主窗口」等后续动作使用）。
///
/// 建窗必须回到主线程：Windows 上创建原生窗口/WebView 只能在事件循环线程做，而命令是在
/// IPC 协议处理器线程上跑的。因此这里用 `run_on_main_thread` 把建窗动作投递回去 ——
/// **不等待结果**，理由见下。
///
/// ⚠️ 不等待的代价是「建窗失败只能事后告知」。但 `run_on_main_thread` 本身只在事件循环
/// 已经退出时才报错（那时应用正在关闭，提示也没意义），而窗口构建失败在正常环境里几乎
/// 只可能是 label 撞车 —— 序号自增已经排除。为此在 IPC 线程上阻塞等一个 channel，
/// 换来的是「命令响应卡住主线程」的风险，不划算。
///
/// `x` / `y` 是可选落点（逻辑像素）：拖出窗口松手时用（见 `spot_of` 的合法性判据）。
#[tauri::command]
pub async fn open_satellite_window(
    app: AppHandle,
    title: String,
    payload: serde_json::Value,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let label = format!(
        "{SAT_PREFIX}{}",
        SAT_SEQ.fetch_add(1, Ordering::Relaxed) + 1
    );
    let spot = spot_of(x, y);

    // 先登记载荷再建窗：卫星窗口一旦开始加载就可能立刻调 window_payload，
    // 登记晚一步就会拿到 null（表现为「新窗口是空的」）。
    if let Some(reg) = app.try_state::<WindowRegistry>() {
        reg.put(&label, payload);
    } else {
        return Err("窗口登记表未初始化".into());
    }

    let build_label = label.clone();
    let build_app = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = build_satellite(&build_app, &build_label, &title, spot) {
            // 建窗失败要把登记撤掉，否则这张表会一直挂着一个永远不会被认领的载荷
            if let Some(reg) = build_app.try_state::<WindowRegistry>() {
                reg.forget(&build_label);
            }
            let _ = tauri::Emitter::emit(
                &build_app,
                "satellite-failed",
                serde_json::json!({ "label": build_label, "message": e.to_string() }),
            );
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(label)
}

/// 「两个都给、且都是有限数」才算一个有效落点。
///
/// 为什么这么挑：落点来自前端按指针位置算出来的坐标，任何一半缺失（前端算不出屏幕
/// 坐标时会传 null）或算出 NaN/∞（缩放因子或窗口位置拿到异常值）都会让窗口被摆到
/// 不可预期的位置，甚至整块跑到屏幕外。宁可让系统按默认规则摆，也不能摆丢。
fn spot_of(x: Option<f64>, y: Option<f64>) -> Option<(f64, f64)> {
    match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some((x, y)),
        _ => None,
    }
}

fn build_satellite(
    app: &AppHandle,
    label: &str,
    title: &str,
    spot: Option<(f64, f64)>,
) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(SAT_WIDTH, SAT_HEIGHT)
        .min_inner_size(SAT_MIN_WIDTH, SAT_MIN_HEIGHT)
        .background_color(SAT_BG)
        // 文件拖入走的是 WebView2 原生拖放（与主窗口一致），关掉会让「拖文件进窗口打开」失效
        .drag_and_drop(true);
    // ⚠️ 必须与主窗口逐字一致，否则 WebView2 拒绝创建（原因见 `pick_browser_args`）。
    // 这一段缺失就是 B72「卫星窗口打不开」的根因，别删。
    if let Some(args) = shared_browser_args(app) {
        builder = builder.additional_browser_args(&args);
    }
    // 指定了落点就落在落点上：拖出窗口松手时新窗口出现在松手处，「拖到另一块屏幕上
    // 接着看」才成立。没给就交给系统按默认规则摆放。
    if let Some((x, y)) = spot {
        builder = builder.position(x, y);
    }
    builder.build()?;
    Ok(())
}

/// 卫星窗口是否还挂着未取走的载荷（诊断用）。
///
/// 只在测试构建里编进来：生产路径上「有没有待认领载荷」没有任何调用者 ——
/// 卫星窗口启动就会取走，建窗失败那条路自己在事件回调里清。
#[cfg(test)]
pub fn has_pending_payload(app: &AppHandle, label: &str) -> bool {
    app.try_state::<WindowRegistry>()
        .map(|reg| reg.has(label))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 身份判定必须与 capabilities 的 `sat-*` 通配一致：前缀写错会让卫星窗口
    /// **拿不到任何权限**（连 emit/listen 都被 ACL 拒掉），表现为界面能画但一切失灵。
    #[test]
    fn window_kind_follows_label_prefix() {
        assert_eq!(kind_of(MAIN_LABEL), "main");
        assert_eq!(kind_of("sat-1"), "satellite");
        assert_eq!(kind_of("sat-42"), "satellite");
        // 边界：别的 label 一律当卫星（宁可不给主窗口特权，也不给陌生窗口）
        assert_eq!(kind_of("other"), "satellite");
    }

    /// 载荷是一次性投递：取走即删（里面可能装着整篇文档的正文）。
    #[test]
    fn payload_is_taken_once() {
        let reg = WindowRegistry::default();
        reg.put("sat-1", serde_json::json!({ "docs": [7] }));
        assert!(reg.has("sat-1"));
        assert_eq!(reg.take("sat-1").unwrap()["docs"][0], 7);
        assert!(!reg.has("sat-1"), "取走后不得残留");
        assert!(reg.take("sat-1").is_none());
    }

    /// 建窗失败后登记必须被撤掉（否则表里挂着一个永不认领的载荷）。
    #[test]
    fn forget_clears_entry() {
        let reg = WindowRegistry::default();
        reg.put("sat-9", serde_json::json!({}));
        reg.forget("sat-9");
        assert!(!reg.has("sat-9"));
        // 撤掉一个不存在的条目不得 panic
        reg.forget("sat-404");
    }

    /// label 序号只增不减，且不会因并发建窗撞号。
    #[test]
    fn satellite_labels_are_unique() {
        let a = SAT_SEQ.fetch_add(1, Ordering::Relaxed);
        let b = SAT_SEQ.fetch_add(1, Ordering::Relaxed);
        assert_ne!(a, b);
        assert!(format!("{SAT_PREFIX}{}", a + 1).starts_with(SAT_PREFIX));
    }

    /// 落点必须「两个都合法」才用：半个坐标、NaN、无穷一律退回系统默认摆放。
    #[test]
    fn spot_requires_both_finite_coords() {
        assert_eq!(spot_of(Some(100.0), Some(200.0)), Some((100.0, 200.0)));
        // 负坐标是合法的（多显示器时虚拟桌面可以往左上延伸）
        assert_eq!(spot_of(Some(-1920.0), Some(0.0)), Some((-1920.0, 0.0)));
        assert_eq!(spot_of(Some(100.0), None), None, "只有一个坐标不能当落点");
        assert_eq!(spot_of(None, Some(200.0)), None);
        assert_eq!(spot_of(None, None), None);
        assert_eq!(
            spot_of(Some(f64::NAN), Some(0.0)),
            None,
            "NaN 会把窗口摆到不可预期的位置"
        );
        assert_eq!(spot_of(Some(0.0), Some(f64::INFINITY)), None);
    }

    /// B72：卫星窗口必须照抄**主窗口那份**附加浏览器参数。
    ///
    /// 反例就是发布版的实际故障：卫星窗口不传 → 落到 wry 默认值（少了 `--disable-gpu`）
    /// → 与主窗口共用用户数据目录却参数不一致 → WebView2 拒绝创建 → 拖出去什么窗口都没有。
    #[test]
    fn browser_args_follow_the_main_window() {
        let mut main = WindowConfig::default();
        main.label = MAIN_LABEL.to_string();
        main.additional_browser_args = Some("--disable-gpu".into());

        let mut sat = WindowConfig::default();
        sat.label = "sat-1".into();
        sat.additional_browser_args = Some("--别的参数".into());

        // 有 main 时以 main 为准（卫星窗口自己那份配置说了不算）
        assert_eq!(
            pick_browser_args(&[main.clone(), sat.clone()]).as_deref(),
            Some("--disable-gpu")
        );
        // 配置里没有 main 条目 → 退而取第一条（有总比没有强）
        assert_eq!(pick_browser_args(&[sat]).as_deref(), Some("--别的参数"));
        // 谁都没配 → None。此时两个 WebView 都会落到 wry 的内置默认值，仍然一致
        assert_eq!(pick_browser_args(&[]), None);
        assert_eq!(pick_browser_args(&[WindowConfig::default()]), None);
    }
}
