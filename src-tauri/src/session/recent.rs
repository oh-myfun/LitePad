//! B305 · 最近打开名单的内核（纯逻辑，不碰窗口与 IPC）。
//!
//! 盘上位置：`<配置目录>/recents.json`，形如
//! `{ "limit": 50, "entries": [ { "path", "name", "openedAt" } ] }`，线上格式 camelCase
//! （与前端 `src/ipc/api.ts` 的 `RecentEntry` 一一对应）。
//!
//! ⚠️ 名单**不在 `settings.json` 里**：那张表没有权威窗口，每个窗口都能整表覆写它
//! （`src/toc.ts` 里三处 `saveSettings`），把名单放进去等于「别人一次无关的设置写入
//! 就把名单冲掉」。会话那份归主窗口写（`session/persist.ts`），但设置没有这层归属。
//!
//! B308 把语义翻正：**打开过就在册，以 LRU 维护**（用户口径「不再考虑文件是否目前正
//! 打开着，只要是打开过的都放到列表里」）。B308 收尾又钉死**记的是哪一件事**：
//! 「用户打开了一份文件」这个**动作**，不是「某条路径从可见集合里冒出来」那个**结果**——
//! 会话恢复会让文件冒出来，但没人“打开”它（用户裁决「恢复不算打开」）。
//!   · 名单里可以同时躺着正开着的文件；重新打开不再把它从名单里划掉；
//!   · 同一路径再打开 ⇒ 顶到最前并刷新时间戳，绝不占第二格；
//!   · 超过上限挤掉尾巴；`limit = 0` 是「不再记录」而不是「记了再裁」。
//! 于是这条链上不需要任何 per-window 的账：记入源是动作，一次一发，`note_opened(path)`。
//! 旧机制（并集推导、「退出时仍开着的不算」旗标、窗口销毁钩子、per-window 可见集合差集）
//! 全部退场——它们存在的唯一理由就是把「集合的变化」当成「用户的意图」。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::commands::normalize_path;
use crate::core::{
    atomic_write,
    logging::{self, Level},
};

/// 默认保留条数。设置页「最近打开保留数量」的候选档位与它同一处口径（0/10/20/50/100），
/// 其中写着「（默认）」的那一档必须就是这个数（`tests/recents-settings.test.ts` 钉着）。
pub const DEFAULT_LIMIT: usize = 50;

/// 一条记录的是**哪一类东西**。B332：名单里从此两类并存，各按各的上限算。
///
/// ⚠️ `#[serde(default)]`（挂在字段上）是给旧盘用的：`recents.json` 里没这个键的条目一律读成
///   `File`，于是旧名单零迁移 —— 不写这条，旧文件会整个反序列化失败，而 `load()` 的兜底是
///   「任何异常回落空名单」，用户看到的就是「升级之后最近打开全没了」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecentKind {
    File,
    Folder,
}

impl Default for RecentKind {
    fn default() -> Self {
        RecentKind::File
    }
}

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
    #[serde(default)]
    pub kind: RecentKind,
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
/// `kind` 跟着这一次动作走（同一路径先当文件夹记下、后来它变成同名文件再打开 ⇒ 自愈成新的一类；
/// 名单里它仍只占一格）。
pub fn touch_opened(
    r: &mut Recents,
    opened: &[(String, String)],
    kind: RecentKind,
    now_ms: i64,
) -> bool {
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
                kind,
            },
        );
    }
    trim_per_bucket(r);
    true
}

/// 按桶各裁 `limit` 条：表只有一张、额度有两份，桶内顺序（新→旧）不动。
///
/// ⚠️ 不许退回成 `entries.truncate(limit)`：那是「两类合起来算」，用户连开几个文件就把
/// 上午在看的那个目录挤出名单了（症状是「文件夹那条自己不见了」）。
/// `slot`：Folder 记第 1 格、File 记第 0 格（`bool as usize`），省一个 HashMap。
fn trim_per_bucket(r: &mut Recents) {
    if r.limit == 0 {
        r.entries.clear();
        return;
    }
    let mut kept = [0usize; 2];
    r.entries.retain(|e| {
        let slot = usize::from(e.kind == RecentKind::Folder);
        kept[slot] += 1;
        kept[slot] <= r.limit
    });
}

/// 单条清除（行上那颗 ✕）。传 key（由调用方 `key_of` 现算），不比对原串。
pub fn forget(r: &mut Recents, key: &str) -> bool {
    let before = r.entries.len();
    r.entries.retain(|e| key_of(&e.path) != key);
    r.entries.len() != before
}

/// 一条路径被改名 / 挪走 ⇒ **就地改写**那一格：不新增、不换位置、不改时间戳。
///
/// 目录改名会牵到它下面每一条在册文件 ⇒ 命中规则是「同一条」或「以它为前缀」，
/// 尾巴保留条目自己那一份写法（大小写不动 —— 名单里显示的就是用户当初那一条）。
/// 前端那份 `rewritePath`（`src/explorer/paths.ts`）与此同规则，两处各自实现是
/// 跨语言的必然：文档在 JS 手里，名单在 Rust 手里。
pub fn retitle(r: &mut Recents, old: &str, new: &str) -> bool {
    let flat = |s: &str| s.replace('/', "\\");
    let oldp = flat(old).trim_end_matches('\\').to_string();
    let newp = flat(new);
    if oldp.is_empty() || newp.is_empty() {
        return false;
    }
    let prefix = format!("{oldp}\\");
    let mut changed = false;
    for e in r.entries.iter_mut() {
        let path = flat(&e.path);
        // ⚠️ 按字节切前缀必须走 `split_at_checked`：中文路径里一个字符占 3 字节，
        // 而 `prefix.len()` 是从**另一条**路径算出来的 —— 两条的字符边界不一定对得上。
        // 直接 `&path[..prefix.len()]` 会 panic 在「byte index is not a char boundary」，
        // 而它炸的时机是用户在资源管理器里改了一个中文名（名单里只要躺着一条同层的中文，
        // 整发 IPC 就回不来，界面上表现为「改了名而标签没动」）。
        // 落在非边界上 ⇒ 那一段本来就**不可能**与 prefix 相等（UTF-8 的后续字节恒 ≥0x80，
        // 而 ASCII 大小写折叠只在 <0x80 上有意义），跳过就是正确答案。
        let tail = if path.eq_ignore_ascii_case(&oldp) {
            ""
        } else if let Some((head, rest)) = path.split_at_checked(prefix.len()) {
            if head.eq_ignore_ascii_case(&prefix) {
                rest
            } else {
                continue;
            }
        } else {
            continue;
        };
        e.path = if tail.is_empty() {
            newp.clone()
        } else {
            format!("{newp}\\{tail}")
        };
        e.name = file_name_of(&e.path);
        changed = true;
    }
    changed
}

pub fn clear(r: &mut Recents) -> bool {
    if r.entries.is_empty() {
        return false;
    }
    r.entries.clear();
    true
}

/// 改上限：立刻按新档裁剪（每桶各裁 `limit` 条；0 ⇒ 整张表清空）。
pub fn apply_limit(r: &mut Recents, limit: usize) -> bool {
    let limit_changed = r.limit != limit;
    r.limit = limit;
    let before = r.entries.len();
    trim_per_bucket(r);
    limit_changed || r.entries.len() != before
}

/// 剔掉磁盘上已经不存在的条目（文件被外部删除/挪走的自愈）。
/// `exists` 注入进来是为了可测 —— 单测不许依赖真机上存在哪些文件。
pub fn drop_missing(r: &mut Recents, exists: impl Fn(&str) -> bool) -> bool {
    let before = r.entries.len();
    r.entries.retain(|e| exists(&e.path));
    r.entries.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造 `touch_opened` 的一条输入（key 由 `key_of` 现算，与生产同一口径）。
    fn op(p: &str) -> (String, String) {
        (key_of(p), p.to_string())
    }

    #[test]
    fn touch_opened_puts_newest_first_and_dedupes_by_key() {
        let mut r = Recents::default();
        assert!(touch_opened(
            &mut r,
            &[op(r"C:\d\a.md")],
            RecentKind::File,
            1_000
        ));
        assert!(touch_opened(
            &mut r,
            &[op(r"C:\d\b.md")],
            RecentKind::File,
            2_000
        ));
        assert_eq!(r.entries.len(), 2);
        assert_eq!(r.entries[0].path, r"C:\d\b.md", "新关的必须顶到最前");
        assert_eq!(r.entries[0].name, "b.md", "显示名取自路径最后一段");

        assert!(
            touch_opened(&mut r, &[op(r"C:\d\a.md")], RecentKind::File, 3_000),
            "同一文件再关一次要换时间戳"
        );
        assert_eq!(r.entries.len(), 2, "同一路径不许占两格");
        assert_eq!(r.entries[0].path, r"C:\d\a.md");
        assert_eq!(r.entries[0].opened_at, 3_000);
    }

    #[test]
    fn folders_and_files_each_get_their_own_allowance() {
        // 用户拍板「各算各的」：limit 那一颗是**每类**的上限，两类互不挤占。
        // 合起来算的写法在这一单会露馅：连开三个文件夹就把最早那个挤没了，
        // 而用户看到的症状是「我上午在看的那个目录不见了」。
        let mut r = Recents {
            limit: 2,
            entries: Vec::new(),
        };
        touch_opened(&mut r, &[op(r"C:\work")], RecentKind::Folder, 1_000);
        touch_opened(&mut r, &[op(r"C:\d\a.md")], RecentKind::File, 2_000);
        touch_opened(&mut r, &[op(r"C:\other")], RecentKind::Folder, 3_000);
        touch_opened(&mut r, &[op(r"C:\d\b.md")], RecentKind::File, 4_000);
        touch_opened(&mut r, &[op(r"C:\d\c.md")], RecentKind::File, 5_000);

        let folders: Vec<&RecentEntry> = r
            .entries
            .iter()
            .filter(|e| e.kind == RecentKind::Folder)
            .collect();
        let files: Vec<&RecentEntry> = r
            .entries
            .iter()
            .filter(|e| e.kind == RecentKind::File)
            .collect();
        assert_eq!(folders.len(), 2, "文件开得再多也不该把文件夹挤出名单");
        assert_eq!(files.len(), 2, "反过来也一样：文件夹不配吃掉文件的额度");
        assert_eq!(files[0].path, r"C:\d\c.md", "桶内仍按最近打开排");
        assert!(
            !r.entries.iter().any(|e| e.path == r"C:\d\a.md"),
            "要挤也只挤同桶里最旧的那条"
        );
    }

    #[test]
    fn apply_limit_trims_each_bucket_separately() {
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\one")], RecentKind::Folder, 1);
        touch_opened(&mut r, &[op(r"C:\two")], RecentKind::Folder, 2);
        touch_opened(&mut r, &[op(r"C:\a.md")], RecentKind::File, 3);
        touch_opened(&mut r, &[op(r"C:\b.md")], RecentKind::File, 4);
        assert!(apply_limit(&mut r, 1));
        assert_eq!(
            r.entries
                .iter()
                .map(|e| e.path.as_str())
                .collect::<Vec<_>>(),
            vec![r"C:\b.md", r"C:\two"],
            "降到 1 档 ⇒ 每桶各留最新一条，不是整张表只留一条"
        );
    }

    #[test]
    fn old_disk_without_kind_reads_as_file() {
        // ⚠️ 这条钉的是 `#[serde(default)]` 那一行：读不出来的话 `load()` 的兜底是
        // 「任何异常回落空名单」，用户看到的症状是「升级之后最近打开全没了」。
        let json = r#"{"limit":50,"entries":[{"path":"C:\\d\\a.md","name":"a.md","openedAt":1}]}"#;
        let r: Recents = serde_json::from_str(json).expect("旧盘（没有 kind 这一格）必须读得出来");
        assert_eq!(r.entries[0].kind, RecentKind::File);
    }

    #[test]
    fn reopening_the_same_path_adopts_the_newest_kind() {
        // 同一个键只占一格；类型跟着这一次动作走（那个目录后来被换成同名文件时能自愈）。
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\d\notes")], RecentKind::Folder, 1_000);
        touch_opened(&mut r, &[op(r"C:\d\notes")], RecentKind::File, 2_000);
        assert_eq!(r.entries.len(), 1, "不许占两格");
        assert_eq!(r.entries[0].kind, RecentKind::File);
        assert_eq!(r.entries[0].opened_at, 2_000);
    }

    #[test]
    fn retitle_rewrites_in_place_for_file_and_folder() {
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\d\a.md")], RecentKind::File, 1_000);
        touch_opened(&mut r, &[op(r"C:\d\notes\b.md")], RecentKind::File, 2_000);
        touch_opened(&mut r, &[op(r"C:\other.md")], RecentKind::File, 3_000);
        // 此刻顺序：other(3000) / notes\b(2000) / a(1000)

        assert!(retitle(&mut r, r"C:\d\notes", r"C:\d\笔记"));
        assert_eq!(
            r.entries[1].path, r"C:\d\笔记\b.md",
            "目录改名要牵到它里面每一条在册的"
        );
        assert_eq!(r.entries[1].name, "b.md", "显示名跟着新路径的最后一段");
        assert_eq!(r.entries[1].opened_at, 2_000, "就地改写不许顺手顶到最前");
        assert_eq!(
            r.entries[0].path, r"C:\other.md",
            "不相干的那条一个字都不动"
        );
        assert_eq!(
            r.entries[2].path, r"C:\d\a.md",
            "同层另一条也不动（不是前缀）"
        );
        assert_eq!(r.entries.len(), 3, "改写不是新增");

        assert!(
            !retitle(&mut r, r"C:\d\notes", r"C:\d\笔记"),
            "已经没命中的话要回 false（没人该为一次空改写盘）"
        );
        assert!(retitle(&mut r, r"C:\d\a.md", r"C:\d\z.md"));
        assert_eq!(r.entries[2].path, r"C:\d\z.md", "单条文件改名走同一条路");
    }

    /// 中文名单里改一个**英文名**：前缀的字节数落在邻居那条的汉字中间。
    ///
    /// ⚠️ 这一条钉的是 `retitle` 里按字节切前缀那一句。`C:\d\a.md\` 是 9 字节，
    /// 而 `C:\d\笔记\b.md` 的「记」占 8..11 —— 直接 `&path[..9]` 会 panic 在
    /// 「not a char boundary」。炸的样子是整发 IPC 回不来，界面上只剩
    /// 「我改了个名，标签没动」，而名单里只要躺着一条中文名就每次都炸。
    #[test]
    fn retitle_survives_a_neighbor_with_other_multibyte_widths() {
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\d\笔记\b.md")], RecentKind::File, 1_000);
        touch_opened(&mut r, &[op(r"C:\d\a.md")], RecentKind::File, 2_000);
        assert_eq!(
            r.entries[0].path, r"C:\d\a.md",
            "替身要先自证顺序（改错了对象等于没测）"
        );
        assert!(retitle(&mut r, r"C:\d\a.md", r"C:\d\z.md"));
        assert_eq!(r.entries[0].path, r"C:\d\z.md");
        assert_eq!(
            r.entries[1].path, r"C:\d\笔记\b.md",
            "不相干那条一个字都不动"
        );
    }

    #[test]
    fn retitle_matches_case_insensitively_and_keeps_the_tail_writing() {
        let mut r = Recents::default();
        touch_opened(&mut r, &[op(r"C:\Dir\Sub\A.md")], RecentKind::File, 1);
        assert!(retitle(&mut r, r"c:\dir\sub", r"C:\dir\SUB2"));
        assert_eq!(
            r.entries[0].path, r"C:\dir\SUB2\A.md",
            "命中按忽略大小写，尾巴保留条目自己那一份写法"
        );
    }

    #[test]
    fn limit_zero_stops_recording() {
        let mut r = Recents {
            limit: 0,
            entries: Vec::new(),
        };
        assert!(
            !touch_opened(&mut r, &[op(r"C:\d\a.md")], RecentKind::File, 1_000),
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
            RecentKind::File,
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
        touch_opened(&mut r, &[op(r"C:\d\a.md")], RecentKind::File, 1_000);
        assert!(forget(&mut r, &key_of(r"C:\d\a.md")));
        assert!(r.entries.is_empty());
        assert!(!forget(&mut r, &key_of(r"C:\d\a.md")), "不在册的不算变更");
        touch_opened(&mut r, &[op(r"C:\d\a.md")], RecentKind::File, 2_000);
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
        touch_opened(&mut r, &[op(r"C:\Dir\A.md")], RecentKind::File, 1_000);
        touch_opened(&mut r, &[op(r"c:\dir\a.md")], RecentKind::File, 2_000);
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
    fn reopen_moves_the_same_entry_to_the_front_and_keeps_it() {
        // 「打开过就在册」：重新打开**不**把条目划掉（旧语义那条 `prune_open` 已删），
        // 只把它顶到最前并换时间戳。
        let mut r = Recents::default();
        touch_opened(
            &mut r,
            &[op(r"C:\d\a.md"), op(r"C:\d\b.md")],
            RecentKind::File,
            1_000,
        );
        assert_eq!(r.entries[0].path, r"C:\d\b.md");
        assert!(touch_opened(
            &mut r,
            &[op(r"C:\d\a.md")],
            RecentKind::File,
            2_000
        ));
        assert_eq!(r.entries.len(), 2, "还在开着也得留在名单里");
        assert_eq!(r.entries[0].path, r"C:\d\a.md", "再打开要顶到最前");
        assert_eq!(r.entries[0].opened_at, 2_000);
    }

    #[test]
    fn drop_missing_removes_gone_files_and_reports_the_change() {
        let mut r = Recents::default();
        touch_opened(
            &mut r,
            &[op(r"C:\d\a.md"), op(r"C:\d\b.md")],
            RecentKind::File,
            1_000,
        );
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
