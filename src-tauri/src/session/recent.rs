//! B305 · 最近打开名单的内核（纯逻辑，不碰窗口与 IPC）。
//!
//! 盘上位置：`<配置目录>/recents.json`，形如
//! `{ "limit": 20, "entries": [ { "path", "name", "openedAt" } ] }`，线上格式 camelCase
//! （与前端 `src/ipc/api.ts` 的 `RecentEntry` 一一对应）。
//!
//! ⚠️ 名单**不在 `settings.json` 里**：那张表没有权威窗口，每个窗口都能整表覆写它
//! （`src/toc.ts` 里三处 `saveSettings`），把名单放进去等于「别人一次无关的设置写入
//! 就把名单冲掉」。会话那份归主窗口写（`session/persist.ts`），但设置没有这层归属。
//!
//! B308 把语义翻正：**打开过就在册，以 LRU 维护**（用户口径「不再考虑文件是否目前正
//! 打开着，只要是打开过的都放到列表里」）。所以记账的输入是「哪条路径**刚出现**」，
//! 而不是「哪条路径消失了」——
//!   · 名单里可以同时躺着正开着的文件；重新打开不再把它从名单里划掉；
//!   · 同一路径再出现 ⇒ 顶到最前并刷新时间戳，绝不占第二格；
//!   · 超过上限挤掉尾巴；`limit = 0` 是「不再记录」而不是「记了再裁」。
//! 这一改也删掉了旧机制那一整套：并集推导、「退出时仍开着的不算」旗标、窗口销毁钩子
//! （它们存在的唯一理由是把「消失」认成「关闭」）。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::commands::normalize_path;
use crate::core::{
    atomic_write,
    logging::{self, Level},
};

/// 默认保留条数。设置页「最近打开保留数量」的候选档位与它同一处口径（0/10/20/50/100）。
pub const DEFAULT_LIMIT: usize = 20;

/// 一条「打开过」的记录。`path` 是**第一次记下它时那条原始路径**（显示用），
/// `opened_at` 是最后一次打开的毫秒时间戳（相对时间由前端换算，Rust 不碰本地化文案）。
///
/// ⚠️ `alias = "closedAt"` 是给 B305 那版名单读旧盘用的：字段改过名，没有这条别名，
/// 老文件里的时间戳会按缺省读成 0 ⇒ 真机上满屏「1970年1月1日」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    #[serde(alias = "closedAt")]
    pub opened_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Recents {
    pub limit: usize,
    /// `entries[0]` 是最新的一条。
    pub entries: Vec<RecentEntry>,
}

impl Default for Recents {
    fn default() -> Self {
        Recents {
            limit: DEFAULT_LIMIT,
            entries: Vec::new(),
        }
    }
}

pub fn recents_path() -> Option<PathBuf> {
    super::config_dir().map(|d| d.join("recents.json"))
}

/// 读名单；**任何异常都回落空名单**。名单坏了不该让应用起不来（与 `session::load` 同口径），
/// 但静默只对调用方，日志照样留一条 warn（损坏形状只有读盘那侧看得见）。
pub fn load() -> Recents {
    let Some(path) = recents_path() else {
        return Recents::default();
    };
    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<Recents>(&content) {
            Ok(r) => r,
            Err(e) => {
                logging::log(
                    Level::Warn,
                    "recents",
                    &format!("名单反序列化失败，按空名单继续：{e} ← {}", path.display()),
                );
                Recents::default()
            }
        },
        Err(e) => {
            logging::log(
                Level::Debug,
                "recents",
                &format!("读不到名单文件（按首次启动处理）：{e}"),
            );
            Recents::default()
        }
    }
}

pub fn save(r: &Recents) -> Result<(), String> {
    let path = recents_path().ok_or_else(|| {
        "无法定位配置目录（需要 %APPDATA%，或显式给 LITEPAD_CONFIG_DIR）".to_string()
    })?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(r).map_err(|e| e.to_string())?;
    atomic_write::atomic_write(&path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

/// 路径最后一段（`\` 与 `/` 都算分隔符）。只用于显示名，不参与身份判定。
pub fn file_name_of(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or("").to_string()
}

/// 名单条目的**身份键**：canonicalize → 剥 `\\?\` verbatim 前缀 → Windows 上小写。
///
/// ⚠️ 为什么必须绕这一圈：`open_file` 用 canonical 结果判重，却把**原始输入路径**返回给
/// 前端（`commands/mod.rs:450`），于是同一个文件可能以 `C:\Dir\A.md` 与 `c:\dir\a.md`
/// 两种写法进名单 —— 不收敛就会出现「同一个文件占两格、清掉一格另一格还在」。
/// 文件已被外部删除时 canonicalize 失败，退回原串：条目照样记得下来，下次列名单由
/// `drop_missing` 剔掉。
pub fn key_of(path: &str) -> String {
    let raw = PathBuf::from(path);
    let canonical = normalize_path(fs::canonicalize(&raw).unwrap_or(raw));
    let key = canonical.to_string_lossy().to_string();
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

/// 把「这些路径刚被打开」落进名单（LRU）。返回 `true` = 名单变了。
///
/// 同键已在册 ⇒ 顶到最前并换时间戳，**不新增第二条**，显示仍留第一次那条写法。
pub fn touch_opened(r: &mut Recents, opened: &[(String, String)], now_ms: i64) -> bool {
    // 上限 0 = 用户明确要「不再记录」。这里不记，而不是「记了再裁」——后者会让名单
    // 在两次同步之间闪出一条又消失。
    if r.limit == 0 || opened.is_empty() {
        return false;
    }
    for (key, display) in opened {
        // 先摘出位置再改：把 `position(..)` 直接写进 match 的受检表达式里，迭代器的借用会
        // 活到整条 match 结束，分支里的 `remove` 就借不过去了。
        let at = r.entries.iter().position(|e| key_of(&e.path) == *key);
        let (path, name) = match at {
            // 同键已在册：沿用第一次记下的那条写法与显示名，只换时间戳、换位置。
            Some(i) => {
                let old = r.entries.remove(i);
                (old.path, old.name)
            }
            None => (display.clone(), file_name_of(display)),
        };
        r.entries.insert(
            0,
            RecentEntry {
                path,
                name,
                opened_at: now_ms,
            },
        );
    }
    if r.entries.len() > r.limit {
        r.entries.truncate(r.limit);
    }
    true
}

/// 单条清除（行上那颗 ✕）。传 key（由调用方 `key_of` 现算），不比对原串。
pub fn forget(r: &mut Recents, key: &str) -> bool {
    let before = r.entries.len();
    r.entries.retain(|e| key_of(&e.path) != key);
    r.entries.len() != before
}

pub fn clear(r: &mut Recents) -> bool {
    if r.entries.is_empty() {
        return false;
    }
    r.entries.clear();
    true
}

/// 改上限：立刻按新档裁剪（变小 ⇒ 裁最旧；0 ⇒ 清空）。
pub fn apply_limit(r: &mut Recents, limit: usize) -> bool {
    let limit_changed = r.limit != limit;
    r.limit = limit;
    let before = r.entries.len();
    if limit == 0 {
        r.entries.clear();
    } else if before > limit {
        r.entries.truncate(limit);
    }
    limit_changed || r.entries.len() != before
}

/// 剔掉磁盘上已经不存在的条目（文件被外部删除/挪走的自愈）。
/// `exists` 注入进来是为了可测 —— 单测不许依赖真机上存在哪些文件。
pub fn drop_missing(r: &mut Recents, exists: impl Fn(&str) -> bool) -> bool {
    let before = r.entries.len();
    r.entries.retain(|e| exists(&e.path));
    r.entries.len() != before
}

/// 每扇窗口「上一次报过哪些开着的标签」：`窗口 label → (身份键 → 显示路径)`。
///
/// 它现在只为**出现**那一半服务：这一窗口的新集合里、上一次没记过的键 = 「刚被打开」。
/// 只数可见实例（隐藏实例不上报，与 `broadcastDocPresence` 的 B171/B173 口径一致）。
///
/// ⚠️ 不需要「窗口没了把这条账清掉」那个钩子：卫星 label 是进程内自增（`windows.rs:23`，
/// `sat-<n>` 从不回收），不会被新窗口复用 ⇒ 残留那份集合顶多让一条本来就在册的路径
/// 少报一次，不会把「新打开」吞成「老早见过」。
#[derive(Debug, Default)]
pub struct OpenSets {
    map: HashMap<String, HashMap<String, String>>,
}

impl OpenSets {
    /// 某窗口报上最新的可见集合。返回**这次新出现的** `(键, 显示路径)`，排序过便于断言。
    ///
    /// 第一次报（这窗口本来没有账）算「全都新出现」—— 会话恢复那批就是这么进名单的。
    pub fn update(&mut self, window: &str, paths: &[String]) -> Vec<(String, String)> {
        let mut next: HashMap<String, String> = HashMap::new();
        for p in paths {
            let k = key_of(p);
            next.entry(k).or_insert_with(|| p.clone());
        }
        let prev = self
            .map
            .insert(window.to_string(), next.clone())
            .unwrap_or_default();
        let mut out: Vec<(String, String)> = next
            .iter()
            .filter(|(k, _)| !prev.contains_key(*k))
            .map(|(k, d)| (k.clone(), d.clone()))
            .collect();
        out.sort();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造 `touch_opened` 的一条输入（key 由 `key_of` 现算，与生产同一口径）。
    fn op(p: &str) -> (String, String) {
        (key_of(p), p.to_string())
    }
    fn s(p: &str) -> String {
        p.to_string()
    }

    #[test]
    fn touch_opened_puts_newest_first_and_dedupes_by_key() {
        let mut r = Recents::default();
        assert!(touch_opened(&mut r, &[op(r"C:\d\a.md")], 1_000));
        assert!(touch_opened(&mut r, &[op(r"C:\d\b.md")], 2_000));
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].path, r"C:\d\b.md", "新关的必须顶到最前");
        assert_eq!(r.entries[0].name, "b.md", "显示名取自路径最后一段");

        assert!(
            touch_opened(&mut r, &[op(r"C:\d\a.md")], 3_000),
            "同一文件再关一次要换时间戳"
        );
        assert_eq!(r.entries.len(), 2, "同一路径不许占两格");
        assert_eq!(r.entries[0].path, r"C:\d\a.md");
        assert_eq!(r.entries[0].opened_at, 3_000);
    }

    #[test]
    fn limit_zero_stops_recording() {
        let mut r = Recents {
            limit: 0,
            entries: Vec::new(),
        };
        assert!(
            !touch_opened(&mut r, &[op(r"C:\d\a.md")], 1_000),
            "上限 0 = 不再记录"
        );
        assert!(r.entries.is_empty());
    }

    #[test]
    fn apply_limit_trims_oldest_off_the_tail() {
        let mut r = Recents::default();
        touch_opened(
            &mut r,
            &[op(r"C:\d\1.md"), op(r"C:\d\2.md"), op(r"C:\d\3.md")],
            1_000,
        );
        assert_eq!(r.entries.len(), 3);
        assert!(apply_limit(&mut r, 2));
        assert_eq!(r.entries.len(), 2);
        assert_eq!(
            r.entries[1].path, r"C:\d\2.md",
            "裁的是尾巴（最旧），不是头部"
        );
        assert!(!apply_limit(&mut r, 2), "没裁动就不许说名单变了");
        assert!(apply_limit(&mut r, 0), "0 档必须清空");
        assert!(r.entries.is_empty());
    }

    #[test]
    fn forget_and_clear_report_whether_the_list_changed() {
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\d\a.md")], 1_000);
        assert!(forget(&mut r, &key_of(r"C:\d\a.md")));
        assert!(r.entries.is_empty());
        assert!(!forget(&mut r, &key_of(r"C:\d\a.md")), "不在册的不算变更");
        touch_opened(&mut r, &[op(r"C:\d\a.md")], 2_000);
        assert!(clear(&mut r));
        assert!(
            !clear(&mut r),
            "已经空了再清不算变更（不许为此多写一次盘、多发一次广播）"
        );
    }

    #[test]
    fn windows_paths_differing_only_in_case_or_verbatim_prefix_share_one_entry() {
        // Rust 侧 open_file 用 canonicalize 的结果判重，返回给前端的却是**原始输入路径**
        // （commands/mod.rs:450）⇒ 同一文件可能以两种写法进名单。键必须收敛到一格。
        assert_eq!(
            key_of(r"\\?\C:\Dir\A.md"),
            key_of(r"C:\Dir\A.md"),
            "verbatim 前缀不参与身份"
        );
        assert_eq!(
            key_of(r"c:\dir\a.md"),
            key_of(r"C:\DIR\A.md"),
            "Windows 路径大小写不敏感"
        );
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\Dir\A.md")], 1_000);
        touch_opened(&mut r, &[op(r"c:\dir\a.md")], 2_000);
        assert_eq!(r.entries.len(), 1, "两种写法不许占两格");
        assert_eq!(
            r.entries[0].path, r"C:\Dir\A.md",
            "显示留在第一次记下的那条写法"
        );
    }

    #[test]
    fn file_name_of_handles_both_separators_and_bare_name() {
        assert_eq!(file_name_of(r"C:\d\a.md"), "a.md");
        assert_eq!(file_name_of("/x/y/b.md"), "b.md");
        assert_eq!(file_name_of("c.md"), "c.md");
        assert_eq!(file_name_of(""), "");
    }

    #[test]
    fn open_sets_reports_only_paths_newly_appear_in_that_window() {
        // B308 的方向：出现即记。差的是**这一扇窗口自己**上一次的集合，不是所有窗口的并集。
        let mut o = OpenSets::default();
        let a = s(r"C:\d\a.md");
        let b = s(r"C:\d\b.md");
        // 第一次报 = 全都新出现（会话恢复那批就是这么进名单的）。
        let fresh: Vec<String> = o
            .update("main", &[a.clone()])
            .iter()
            .map(|(k, _)| k.clone())
            .collect();
        assert_eq!(fresh, vec![key_of(&a)], "首报必须记下来");
        // 同一批再报一遍（切标签、刷新界面）⇒ 一条都不许多记。
        assert!(o.update("main", &[a.clone()]).is_empty(), "重复报不许重记");
        // 新开一个标签 ⇒ 只报新出现那条。
        let added = o.update("main", &[a.clone(), b.clone()]);
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].1, b, "回的是显示路径");
        // 关掉 b 再开回来 ⇒ 又算一次出现（LRU 要顶到最前）。
        assert!(
            o.update("main", &[a.clone()]).is_empty(),
            "消失不是事件，不该报东西"
        );
        let back = o.update("main", &[a.clone(), b.clone()]);
        assert_eq!(
            back.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>(),
            vec![key_of(&s(r"C:\d\b.md"))]
        );
    }

    #[test]
    fn each_window_keeps_its_own_seen_set() {
        // 卫星窗口独立记账：主窗口早就开着的文件，被拎去卫星窗口算「那边新出现」，
        // 于是它在另一扇被打开也会顶一次 —— 这正是 LRU 要的。
        let mut o = OpenSets::default();
        let a = s(r"C:\d\a.md");
        assert_eq!(o.update("main", &[a.clone()]).len(), 1);
        assert_eq!(
            o.update("sat-1", &[a.clone()]).len(),
            1,
            "换了窗口就得算一次出现"
        );
        assert!(o.update("sat-1", &[a.clone()]).is_empty());
    }

    #[test]
    fn reopen_moves_the_same_entry_to_the_front_and_keeps_it() {
        // 「打开过就在册」：重新打开**不**把条目划掉（旧语义那条 `prune_open` 已删），
        // 只把它顶到最前并换时间戳。
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\d\a.md"), op(r"C:\d\b.md")], 1_000);
        assert_eq!(r.entries[0].path, r"C:\d\b.md");
        assert!(touch_opened(&mut r, &[op(r"C:\d\a.md")], 2_000));
        assert_eq!(r.entries.len(), 2, "还在开着也得留在名单里");
        assert_eq!(r.entries[0].path, r"C:\d\a.md", "再打开要顶到最前");
        assert_eq!(r.entries[0].opened_at, 2_000);
    }

    #[test]
    fn drop_missing_removes_gone_files_and_reports_the_change() {
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\d\a.md"), op(r"C:\d\b.md")], 1_000);
        let changed = drop_missing(&mut r, |p| p != r"C:\d\b.md");
        assert!(changed);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].path, r"C:\d\a.md");
        assert!(!drop_missing(&mut r, |_| true), "全在就不算变更");
    }

    #[test]
    fn recents_serde_uses_camel_case_and_defaults_when_fields_missing() {
        let json = r#"{"limit":5,"entries":[{"path":"a.md","name":"a.md","openedAt":17}]}"#;
        let r: Recents = serde_json::from_str(json).expect("openedAt 必须按 camelCase 读入");
        assert_eq!(r.limit, 5);
        assert_eq!(r.entries[0].opened_at, 17);

        let partial: Recents = serde_json::from_str("{}").expect("缺字段不许整体失败");
        assert_eq!(partial.limit, DEFAULT_LIMIT, "缺 limit 回落默认档");
        assert!(partial.entries.is_empty());

        let out = serde_json::to_string(&r).unwrap();
        assert!(out.contains("\"openedAt\""), "落盘应为 camelCase：{out}");
        assert!(!out.contains("opened_at"), "不该落盘 snake_case：{out}");
    }

    #[test]
    fn an_old_closed_at_file_still_loads_with_its_timestamp() {
        // B305 那版落盘的是 `closedAt`。改名后没有这条 alias，用户升完级会看到满屏
        // 「1970年1月1日」——时间戳按缺省读成 0，名单看着像坏了。
        let json = r#"{"limit":5,"entries":[{"path":"a.md","name":"a.md","closedAt":42}]}"#;
        let r: Recents = serde_json::from_str(json).expect("旧盘的 closedAt 必须认下来");
        assert_eq!(r.entries[0].opened_at, 42);
        // 再写一次就换成新键（一次性的迁移，不留两份）。
        let out = serde_json::to_string(&r).unwrap();
        assert!(out.contains("\"openedAt\""), "{out}");
        assert!(!out.contains("closedAt"), "旧键不许跟着复制一份：{out}");
    }
}
