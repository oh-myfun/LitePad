//! B314 · 资源管理器的 IPC 层：一次只读**一层**目录，外加「新建文件 / 新建目录」。
//!
//! 职责边界（照 `recents.rs` 那一刀）：**判定归这里，缓存归前端 store**。
//! 本模块不持状态、不记展开态、不知道「当前打开的是哪个文件夹」—— 那些都是视图的事。
//! 它只回答三句话：这一层有什么、这个名字能不能用、按这个名字建一个空文件/空目录。
//!
//! ⚠️ 两个刻意的选择：
//!   · **懒加载**：`list_dir` 只读传入的那一层，绝不递归。根选在 `D:\` 或某个
//!     `node_modules` 上时，一次递归能把进程卡死，而一次 read_dir 最多几毫秒。
//!   · **名字在这里校验，不在前端拼路径**：`create_*` 收的是 `dir` + `name` 两段。
//!     前端递一个已经拼好的全路径的话，`..`、`\\`、盘符这些就得靠前端记得滤 ——
//!     而在系统边界上「别人传进来的名字」必须由收下它的那一方校验（口径同 `save_file`
//!     只认自己发过的路径，其余一律不猜）。

use std::fs;
use std::path::Path;

use serde::Serialize;

/// 一层最多回多少条。懒加载已经保证不会递归，这个上限只挡「单层几万个文件」那种
/// 把一条 IPC 撑成几十 MB 的目录；超了就回 `truncated`，前端提示「只显示前 2000 条」。
const MAX_ENTRIES: usize = 2000;

/// Windows 上任何目录里都不该出现在用户面前的两坨系统噪声。
/// 只滤这两个，别的**一律照实显示**（包括点文件）—— VS Code 的资源管理器也是这样，
/// 过滤越多，用户越难理解「我明明有那个文件，列表里怎么没有」。
fn is_system_noise(name: &str) -> bool {
    let up = name.to_uppercase();
    up.starts_with("$RECYCLE") || up.starts_with("SYSTEM VOLUME INFORMATION") || up == "SYSVOL"
}

/// 一层目录里的一条。字段一律 camelCase（口径同 `TabInfo` / `OpenedFile`，
/// 前端按同名读，跨语言拼错不会有任何报错）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    /// 只剩最后一段的名字（不是路径），界面直接显示它
    pub name: String,
    /// 绝对路径，前端拿它做 key、也拿它去开文件
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    /// 文件字节数；目录为 0（树的展开箭头不靠它）
    pub size: u64,
    /// 修改时间毫秒；取不到 metadata 时为 0
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub entries: Vec<FsEntry>,
    /// 真被 `MAX_ENTRIES` 裁过才算 true —— 前端据此提示，不拿「条数刚好 2000」当证据
    pub truncated: bool,
}

/// 自然序比较：数字段按数值比、其余按大小写无关的字符序比。
///
/// 为什么不是 `a.cmp(b)`：笔记目录里 `第2篇.md` / `第10篇.md` 这种命名一多，
/// 字节序会把 10 排在 2 前头，用户读作「排序坏了」。VS Code 默认档（`explorer.sortOrder`
/// = mixed）也是这个规则。
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (ai, bi): (Vec<char>, Vec<char>) = (
        a.to_lowercase().chars().collect(),
        b.to_lowercase().chars().collect(),
    );
    let (mut x, mut y) = (0usize, 0usize);
    while x < ai.len() && y < bi.len() {
        let (ca, cb) = (ai[x], bi[y]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            // 整段数字一次吃掉，按 u128 比（前导零让「007」与「7」相等时再按字面比）
            let sx = x;
            while x < ai.len() && ai[x].is_ascii_digit() {
                x += 1;
            }
            let sy = y;
            while y < bi.len() && bi[y].is_ascii_digit() {
                y += 1;
            }
            let da: String = ai[sx..x].iter().collect();
            let db: String = bi[sy..y].iter().collect();
            let na: u128 = da.parse().unwrap_or(u128::MAX);
            let nb: u128 = db.parse().unwrap_or(u128::MAX);
            if na != nb {
                return na.cmp(&nb);
            }
            if da.len() != db.len() {
                return da.len().cmp(&db.len());
            }
        } else {
            if ca != cb {
                return ca.cmp(&cb);
            }
            x += 1;
            y += 1;
        }
    }
    // 一方是另一方的前缀 ⇒ 短的在前
    (ai.len() - x).cmp(&(bi.len() - y))
}

/// 排序口径：**目录在前**，同组内自然序。两个规则都是 VS Code 默认档。
fn sort_entries(entries: &mut Vec<FsEntry>) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
}

/// 校验并规范化用户给的名字。返回**去掉首尾空白之后**的名字。
///
/// 拒的都是 Windows 真不能用的（`<>:"/\|?*`、控制字符、结尾点与空格、`.` / `..`），
/// 不是「我觉得不好看」：在这一层拦住，前端就能直接把用户输入透传过来，
/// 不必各自记一份「哪些字符不许出现」（记漏一处就是一个穿越口子）。
fn check_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("名字不能为空".into());
    }
    if name == "." || name == ".." {
        return Err("名字不能是 . 或 ..".into());
    }
    if name
        .chars()
        .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("名字里不能有 / \\ : * ? \" < > | 这些字符".into());
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err("名字里有不可见控制字符".into());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("Windows 不允许名字以点或空格结尾".into());
    }
    if name.chars().count() > 255 {
        return Err("名字太长了".into());
    }
    Ok(name.to_string())
}

/// 把 `FsEntry` 从磁盘上的真实路径造出来。`path` 必须已经存在。
fn entry_of(name: String, path: &Path, is_dir: bool) -> FsEntry {
    let meta = fs::metadata(path).ok();
    FsEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir,
        size: meta
            .as_ref()
            .map(|m| if is_dir { 0 } else { m.len() })
            .unwrap_or(0),
        mtime_ms: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    }
}

/// 读一层目录。**只读这一层**（见模块头部那条懒加载理由）。
///
/// 目录项取不到 metadata（断掉的符号链接、被别的进程锁住的重组点）就跳过那一条，
/// 而不是让整次列举失败 —— 一棵树里一个坏条目不该把整个文件夹看不了。
#[tauri::command]
pub fn list_dir(path: String) -> Result<DirListing, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("不是目录，或它已经不存在：{path}"));
    }
    let read = fs::read_dir(p).map_err(|e| format!("读不了这个文件夹：{e}"))?;
    let mut out: Vec<FsEntry> = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if is_system_noise(&name) {
            continue;
        }
        let target = item.path();
        let is_dir = target.is_dir();
        // 断掉的符号链接这类「既不是目录、又读不到 metadata」的条目：跳过这一条，
        // 别让它把整个文件夹判成看不了。
        if !is_dir && fs::metadata(&target).is_err() {
            continue;
        }
        out.push(entry_of(name, &target, is_dir));
    }
    sort_entries(&mut out);
    Ok(cap(out, MAX_ENTRIES))
}

/// 按上限裁一刀，越界才把 `truncated` 置上。
/// 拆成纯函数是为了能拿 `limit = 3` 验这条判据 —— 拿真 2000 个文件去撞上限的测试
/// 既慢又只测了「没裁」那一半。
fn cap(entries: Vec<FsEntry>, limit: usize) -> DirListing {
    let truncated = entries.len() > limit;
    let mut kept = entries;
    if truncated {
        kept.truncate(limit);
    }
    DirListing {
        entries: kept,
        truncated,
    }
}

/// 在 `dir` 下建一个**空文件**。已存在一律拒绝（不覆盖 —— 覆盖用户手里的东西
/// 从来不是「新建」该有的行为）。
#[tauri::command]
pub fn create_file(dir: String, name: String) -> Result<FsEntry, String> {
    let checked = check_name(&name)?;
    let parent = Path::new(&dir);
    if !parent.is_dir() {
        return Err(format!("父目录不存在：{dir}"));
    }
    let target = parent.join(&checked);
    if target.exists() {
        return Err(format!("{} 已经存在", target.to_string_lossy()));
    }
    fs::File::create(&target).map_err(|e| format!("建不了这个文件：{e}"))?;
    Ok(entry_of(checked, &target, false))
}

/// 在 `dir` 下建一层新目录。只建**一段**（`create_dir_all` 在这里是错的：
/// 名字里冒出 `a\b` 就能顺手建出两层，而 `check_name` 已经把分隔符拒了，
/// 用单层创建等于把那道校验变成结构上的必然）。
#[tauri::command]
pub fn create_dir(dir: String, name: String) -> Result<FsEntry, String> {
    let checked = check_name(&name)?;
    let parent = Path::new(&dir);
    if !parent.is_dir() {
        return Err(format!("父目录不存在：{dir}"));
    }
    let target = parent.join(&checked);
    if target.exists() {
        return Err(format!("{} 已经存在", target.to_string_lossy()));
    }
    fs::create_dir(&target).map_err(|e| format!("建不了这个目录：{e}"))?;
    Ok(entry_of(checked, &target, true))
}

// ---------------------------------------------------------------- 用例

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个用例自己的临时目录（跑在同一个进程里，用测试名区分开）。
    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("litepad-fs-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("临时目录建不起来");
        dir
    }

    fn names(list: &[FsEntry]) -> Vec<&str> {
        list.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn natural_cmp_orders_digit_runs_by_value() {
        let mut v = vec!["第10篇.md", "第2篇.md", "第1篇.md"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec!["第1篇.md", "第2篇.md", "第10篇.md"],
            "数字段要按数值比"
        );
    }

    #[test]
    fn natural_cmp_is_case_insensitive_and_prefix_first() {
        let mut v = vec!["beta", "Alpha", "alpha1"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["Alpha", "alpha1", "beta"]);
    }

    #[test]
    fn list_dir_puts_directories_first() {
        let dir = tmp("order");
        fs::write(dir.join("b.md"), "x").unwrap();
        fs::create_dir(dir.join("zeta")).unwrap();
        fs::write(dir.join("a2.md"), "x").unwrap();
        fs::write(dir.join("a10.md"), "x").unwrap();
        fs::create_dir(dir.join("notes")).unwrap();

        let out = list_dir(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            names(&out.entries),
            vec!["notes", "zeta", "a2.md", "a10.md", "b.md"],
            "目录在前，同组自然序"
        );
        assert!(!out.truncated, "五条不该判成裁过");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_dir_reports_size_and_flag_for_file() {
        let dir = tmp("meta");
        fs::write(dir.join("note.md"), "12345").unwrap();
        let out = list_dir(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(out.entries.len(), 1);
        let e = &out.entries[0];
        assert_eq!(e.size, 5, "字节数要带上（新那格的提示用）");
        assert!(!e.is_dir);
        assert!(e.mtime_ms > 0, "mtime 该取到");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_dir_skips_windows_system_noise() {
        let dir = tmp("noise");
        fs::create_dir(dir.join("$RECYCLE.BIN")).unwrap();
        fs::create_dir(dir.join(".git")).unwrap();
        let out = list_dir(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(
            names(&out.entries),
            vec![".git"],
            "系统那坨藏掉，点文件照实显示"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_dir_on_a_file_is_an_error() {
        let dir = tmp("notdir");
        let file = dir.join("note.md");
        fs::write(&file, "x").unwrap();
        let err = list_dir(file.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("不是目录"), "错误要能读：{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cap_flags_only_when_actually_cut() {
        let dir = tmp("trunc");
        let made = |n: usize| -> Vec<FsEntry> {
            (0..n)
                .map(|i| entry_of(format!("f{i}.md"), &dir.join("x"), false))
                .collect()
        };
        assert!(!cap(made(3), 3).truncated, "刚好到顶不算裁过");
        assert_eq!(cap(made(3), 3).entries.len(), 3);
        let cut = cap(made(5), 3);
        assert!(cut.truncated, "越界才算裁过");
        assert_eq!(cut.entries.len(), 3, "留下的是前 limit 条");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn check_name_rejects_traversal_and_illegal_chars() {
        for bad in [
            "",
            "   ",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:\\windows",
            "a:b",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            "trail.",
        ] {
            assert!(check_name(bad).is_err(), "该拒：{bad:?}");
        }
        assert_eq!(
            check_name("  第3篇.md  ").unwrap(),
            "第3篇.md",
            "首尾空白去掉"
        );
        // 结尾空格是**去掉**而不是报错：`trim` 先走一步，用户多打的空格没有信息量；
        // 结尾的点**报错**不悄悄改 —— 那是用户真打出来的字符，而 Windows 确实不收。
        assert_eq!(check_name("trail ").unwrap(), "trail");
        assert!(check_name("trail.").is_err(), "结尾的点要让用户自己改");
    }

    #[test]
    fn create_file_writes_empty_and_refuses_overwrite() {
        let dir = tmp("create");
        let e = create_file(dir.to_string_lossy().into_owned(), "新笔记.md".into()).unwrap();
        assert!(!e.is_dir);
        assert_eq!(e.size, 0, "新建的是空文件");
        assert!(Path::new(&e.path).exists());

        let err = create_file(dir.to_string_lossy().into_owned(), "新笔记.md".into()).unwrap_err();
        assert!(err.contains("已经存在"), "重名要拒而不是覆盖：{err}");
        assert_eq!(fs::read_to_string(dir.join("新笔记.md")).unwrap(), "");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_dir_makes_one_level_only() {
        let dir = tmp("mkdir");
        let e = create_dir(dir.to_string_lossy().into_owned(), "子目录".into()).unwrap();
        assert!(e.is_dir);
        assert!(Path::new(&e.path).is_dir());
        // 名字里带分隔符在建目录那条路上同样必须过不去（否则顺手建了两层）
        assert!(create_dir(dir.to_string_lossy().into_owned(), "a\\b".into()).is_err());
        assert!(create_dir(dir.to_string_lossy().into_owned(), "../escape".into()).is_err());
        assert!(
            !dir.parent().unwrap().join("escape").exists(),
            "不许跑到外面建"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_into_missing_parent_fails() {
        let dir = tmp("noparent");
        let gone = dir.join("没这个");
        let err = create_file(gone.to_string_lossy().into_owned(), "a.md".into()).unwrap_err();
        assert!(err.contains("父目录不存在"), "错误要能读：{err}");
        fs::remove_dir_all(&dir).unwrap();
    }
}
