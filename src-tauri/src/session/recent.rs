//! B305 · 最近打开名单的内核（纯逻辑，不碰窗口与 IPC）。
//!
//! 盘上位置：`<配置目录>/recents.json`，形如
//! `{ "limit": 20, "entries": [ { "path", "name", "closedAt" } ] }`，线上格式 camelCase
//! （与前端 `src/ipc/api.ts` 的 `RecentEntry` 一一对应）。
//!
//! ⚠️ 名单**不在 `settings.json` 里**：那张表没有权威窗口，每个窗口都能整表覆写它
//! （`src/toc.ts` 里三处 `saveSettings`），把名单放进去等于「别人一次无关的设置写入
//! 就把名单冲掉」。会话那份归主窗口写（`session/persist.ts`），但设置没有这层归属。
//!
//! 「文件被关掉了」不是某个关闭动作的属性，而是**它从所有窗口的可见集合里消失了** ——
//! 所以记账的输入是 `OpenSets`（每个窗口报了哪些路径可见），而不是「谁调了 closeTab」。
//! 于是子窗口关标签、关整个子窗口、标签拖出去又关掉这些路径全都不必各写一遍。

use std::collections::{HashMap, HashSet};
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

/// 一条「刚被关掉」的记录。`path` 是**记下它时那条原始路径**（显示用），`closed_at` 是
/// 毫秒时间戳（相对时间由前端换算，Rust 不碰本地化文案）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub closed_at: i64,
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

/// 把「这些路径刚从所有窗口的可见集合里消失」落进名单。返回 `true` = 名单变了。
///
/// 同键已在册 ⇒ 顶到最前并换时间戳，**不新增第二条**，且显示仍留第一次那条写法。
pub fn record_closed(r: &mut Recents, vanished: &[(String, String)], now_ms: i64) -> bool {
    // 上限 0 = 用户明确要「不再记录」。这里不记，而不是「记了再裁」——后者会让名单
    // 在两次同步之间闪出一条又消失。
    if r.limit == 0 || vanished.is_empty() {
        return false;
    }
    for (key, display) in vanished {
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
                closed_at: now_ms,
            },
        );
    }
    if r.entries.len() > r.limit {
        r.entries.truncate(r.limit);
    }
    true
}

/// 打开即从名单消失（含会话恢复、跨窗口取回、点名单那一行）。
pub fn prune_open(r: &mut Recents, open_keys: &HashSet<String>) -> bool {
    let before = r.entries.len();
    r.entries.retain(|e| !open_keys.contains(&key_of(&e.path)));
    r.entries.len() != before
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

/// 每扇窗口「此刻看得见哪些路径」的账：`窗口 label → (身份键 → 显示路径)`。
///
/// 只数**可见**实例（隐藏实例不上报，与 `broadcastDocPresence` 的 B171/B173 口径一致）——
/// 标签被拖去卫星窗口后主窗口留的那份隐藏副本不算「还开着」。
#[derive(Debug, Default)]
pub struct OpenSets {
    map: HashMap<String, HashMap<String, String>>,
}

impl OpenSets {
    /// 某窗口报上最新的可见集合。返回**从并集里消失**的 `(键, 显示路径)`。
    /// 排序过，便于断言与日志对齐。
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
        Self::vanished(&self.map, &prev)
    }

    /// 窗口没了（`WindowEvent::Destroyed`）：清掉它那条账，返回随之从并集消失的路径。
    /// 崩溃的窗口靠这条收口（label 残留会把本该记录的路径一直压住）。
    pub fn drop_window(&mut self, window: &str) -> Vec<(String, String)> {
        match self.map.remove(window) {
            Some(prev) => Self::vanished(&self.map, &prev),
            None => Vec::new(),
        }
    }

    pub fn union_keys(&self) -> HashSet<String> {
        self.map.values().flat_map(|m| m.keys().cloned()).collect()
    }

    fn vanished(
        map: &HashMap<String, HashMap<String, String>>,
        prev: &HashMap<String, String>,
    ) -> Vec<(String, String)> {
        if prev.is_empty() {
            return Vec::new();
        }
        let union: HashSet<&String> = map.values().flat_map(|m| m.keys()).collect();
        let mut out: Vec<(String, String)> = prev
            .iter()
            .filter(|(k, _)| !union.contains(k))
            .map(|(k, d)| (k.clone(), d.clone()))
            .collect();
        out.sort();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造 `record_closed` 的一条输入（key 由 `key_of` 现算，与生产同一口径）。
    fn van(p: &str) -> (String, String) {
        (key_of(p), p.to_string())
    }
    fn s(p: &str) -> String {
        p.to_string()
    }

    #[test]
    fn record_closed_puts_newest_first_and_dedupes_by_key() {
        let mut r = Recents::default();
        assert!(record_closed(&mut r, &[van(r"C:\d\a.md")], 1_000));
        assert!(record_closed(&mut r, &[van(r"C:\d\b.md")], 2_000));
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].path, r"C:\d\b.md", "新关的必须顶到最前");
        assert_eq!(r.entries[0].name, "b.md", "显示名取自路径最后一段");

        assert!(
            record_closed(&mut r, &[van(r"C:\d\a.md")], 3_000),
            "同一文件再关一次要换时间戳"
        );
        assert_eq!(r.entries.len(), 2, "同一路径不许占两格");
        assert_eq!(r.entries[0].path, r"C:\d\a.md");
        assert_eq!(r.entries[0].closed_at, 3_000);
    }

    #[test]
    fn limit_zero_stops_recording() {
        let mut r = Recents {
            limit: 0,
            entries: Vec::new(),
        };
        assert!(
            !record_closed(&mut r, &[van(r"C:\d\a.md")], 1_000),
            "上限 0 = 不再记录"
        );
        assert!(r.entries.is_empty());
    }

    #[test]
    fn apply_limit_trims_oldest_off_the_tail() {
        let mut r = Recents::default();
        record_closed(
            &mut r,
            &[van(r"C:\d\1.md"), van(r"C:\d\2.md"), van(r"C:\d\3.md")],
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
    fn prune_open_drops_entries_that_came_back() {
        // 打开即从名单消失（含会话恢复、跨窗口取回、点名单那一行）。
        let mut r = Recents::default();
        record_closed(&mut r, &[van(r"C:\d\a.md"), van(r"C:\d\b.md")], 1_000);
        let open: HashSet<String> = [key_of(r"C:\d\a.md")].into_iter().collect();
        assert!(prune_open(&mut r, &open));
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].path, r"C:\d\b.md");
        assert!(!prune_open(&mut r, &open), "没剪动就返回 false");
    }

    #[test]
    fn forget_and_clear_report_whether_the_list_changed() {
        let mut r = Recents::default();
        record_closed(&mut r, &[van(r"C:\d\a.md")], 1_000);
        assert!(forget(&mut r, &key_of(r"C:\d\a.md")));
        assert!(r.entries.is_empty());
        assert!(!forget(&mut r, &key_of(r"C:\d\a.md")), "不在册的不算变更");
        record_closed(&mut r, &[van(r"C:\d\a.md")], 2_000);
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
        record_closed(&mut r, &[van(r"C:\Dir\A.md")], 1_000);
        record_closed(&mut r, &[van(r"c:\dir\a.md")], 2_000);
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
    fn open_sets_reports_vanished_only_when_the_last_window_loses_it() {
        let mut o = OpenSets::default();
        let a = s(r"C:\d\a.md");
        let b = s(r"C:\d\b.md");
        assert!(o.update("main", &[a.clone()]).is_empty());
        assert!(o.update("sat-1", &[a.clone(), b.clone()]).is_empty());
        // main 把 a 关了：sat-1 还看得见 ⇒ 不算「关掉了」
        let gone = o.update("main", &[]);
        assert!(gone.is_empty(), "另一扇还开着的不许记：{:?}", gone);
        let gone = o.update("sat-1", &[]);
        let mut keys: Vec<String> = gone.iter().map(|(k, _)| k.clone()).collect();
        keys.sort();
        assert_eq!(keys, vec![key_of(&a), key_of(&b)]);
        assert_eq!(o.union_keys().len(), 0);
    }

    #[test]
    fn drop_window_reports_only_paths_no_other_window_has() {
        let mut o = OpenSets::default();
        o.update("main", &[s(r"C:\d\a.md")]);
        o.update("sat-1", &[s(r"C:\d\b.md")]);
        let gone = o.drop_window("sat-1");
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].1, r"C:\d\b.md");
        assert_eq!(o.union_keys(), [key_of(r"C:\d\a.md")].into_iter().collect());
        assert!(
            o.drop_window("sat-1").is_empty(),
            "重复清同一 label 不该再报一遍"
        );
    }

    #[test]
    fn drop_missing_removes_gone_files_and_reports_the_change() {
        let mut r = Recents::default();
        record_closed(&mut r, &[van(r"C:\d\a.md"), van(r"C:\d\b.md")], 1_000);
        let changed = drop_missing(&mut r, |p| p != r"C:\d\b.md");
        assert!(changed);
        assert_eq!(r.entries.len(), 1);
        assert_eq!(r.entries[0].path, r"C:\d\a.md");
        assert!(!drop_missing(&mut r, |_| true), "全在就不算变更");
    }

    #[test]
    fn recents_serde_uses_camel_case_and_defaults_when_fields_missing() {
        let json = r#"{"limit":5,"entries":[{"path":"a.md","name":"a.md","closedAt":17}]}"#;
        let r: Recents = serde_json::from_str(json).expect("closedAt 必须按 camelCase 读入");
        assert_eq!(r.limit, 5);
        assert_eq!(r.entries[0].closed_at, 17);

        let partial: Recents = serde_json::from_str("{}").expect("缺字段不许整体失败");
        assert_eq!(partial.limit, DEFAULT_LIMIT, "缺 limit 回落默认档");
        assert!(partial.entries.is_empty());

        let out = serde_json::to_string(&r).unwrap();
        assert!(out.contains("\"closedAt\""), "落盘应为 camelCase：{out}");
        assert!(!out.contains("closed_at"), "不该落盘 snake_case：{out}");
    }
}
