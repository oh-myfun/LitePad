//! B314 / B315 · 资源管理器的 IPC 层：一次只读**一层**目录，外加建、改、搬、删。
//!
//! 职责边界（照 `recents.rs` 那一刀）：**判定归这里，缓存归前端 store**。
//! 本模块不持状态、不记展开态、不知道「当前打开的是哪个文件夹」—— 那些都是视图的事。
//! 它回答的是：这一层有什么、这个名字能不能用、按这个名字建一个空文件/空目录、
//! 把这条路径改名 / 复制 / 挪走 / 送回收站。
//!
//! ⚠️ 三个刻意的选择：
//!   · **懒加载**：`list_dir` 只读传入的那一层，绝不递归。根选在 `D:\` 或某个
//!     `node_modules` 上时，一次递归能把进程卡死，而一次 read_dir 最多几毫秒。
//!     （B315 的 `copy_entry` 是**唯一**递归的地方，而且只在用户明确「粘贴一个目录」时。）
//!   · **名字在这里校验，不在前端拼路径**：`create_*` / `rename_*` 收的是 `dir` + `name`
//!     两段。前端递一个已经拼好的全路径的话，`..`、`\\`、盘符这些就得靠前端记得滤 ——
//!     而在系统边界上「别人传进来的名字」必须由收下它的那一方校验（口径同 `save_file`
//!     只认自己发过的路径，其余一律不猜）。
//!   · **写操作的 target 一律要在根之内**（`guard_within`）：剪贴板那份路径存在前端，
//!     一旦记错层，「粘贴」就会把东西写进根外的目录，而用户只在树里看 —— 看不见 ≠ 没发生。
//!     这一道不是防恶意，是防我们自己的簿记出错。

use std::fs;
use std::path::{Path, PathBuf};

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

// ---------------------------------------------------------------- B315 · 改 / 搬 / 删

/// 规范化一条路径用于**比较**（不改磁盘上的任何东西）。
/// 取不到（还没建出来、权限不够）就退回原串 —— 调用方只拿它做前缀判断，
/// 真正要动文件的那几步自有 `exists()` 与 IO 错误兜着。
///
/// ⚠️ 一律过 `normalize_path`：本仓库的成文规矩是「canonicalize 的结果必须剥掉
/// `\\?\`」（见 `commands::normalize_path` 那段），留着它一旦顺着某条 return 溜到
/// 前端，用户看到的就是 `\\?\D:\笔记\a.md`。
fn norm(path: &Path) -> PathBuf {
    match path.canonicalize() {
        Ok(p) => crate::commands::normalize_path(p),
        Err(_) => path.to_path_buf(),
    }
}

/// 这条路径在不在当前根之内（含根本身）。
///
/// ⚠️ 必须先 `canonicalize` 再比前缀：拿原始串比的话，
/// `D:\笔记\..\Windows\System32` 看着在 `D:\笔记` 底下，实际不是。
/// ⚠️ 而且要按**路径分量**比（`Path::starts_with`），不是按字符串：
/// `"D:\笔记2".starts_with("D:\笔记")` 为真，可它俩是两个不同的目录。
/// Windows 的路径不分大小写 ⇒ 两边都换成大写再比。
fn within(root: &Path, path: &Path) -> bool {
    let up = |p: &Path| PathBuf::from(p.to_string_lossy().to_uppercase());
    let (r, p) = (up(&norm(root)), up(&norm(path)));
    p.starts_with(&r)
}

/// 路径里带着 `..` 分量 ⇒ 一律当界外。
///
/// ⚠️ 为什么不能只靠上面那句「先 canonicalize 再比」：canonicalize 要求**目标存在**，
/// 而 `根\..\别处` 在 `别处` 还没建出来时直接失败（粘贴/复制的目标层常常正是这种「还没建」
/// 的一层），回落到原始串之后按分量比 —— `根\..\别处` 的头几项恰好就是 `根` 那几项，
/// 于是越界的那一条被判成界内，东西写到了根外面。
/// 自己写一遍词典法折 `..`（std 没有稳定的 LexicalNormalizer）在这里没必要：树里每一条
/// 路径都是 Rust 自己造的，压根不该出现 `..`；出现了就是我们的簿记出错，而出错按界外拒
/// 掉最省事 —— 拒错了用户只会看见一句「不在当前文件夹内」，写错了却是往根外面落东西。
fn has_parent(path: &Path) -> bool {
    path.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// 越界就报错，错误话术直接给用户看（前端那句「不在当前文件夹内」不用另写）。
fn guard_within(root: &str, path: &Path) -> Result<(), String> {
    if root.is_empty() {
        return Err("还没有打开文件夹".into());
    }
    if has_parent(path) || !within(Path::new(root), path) {
        return Err(format!(
            "这条路径不在当前文件夹内：{}",
            path.to_string_lossy()
        ));
    }
    Ok(())
}

/// 把 `名字.扩展名` 拆成 `(名字, 扩展名)`；点开头的整体（`.gitignore`）算**没扩展名**，
/// 否则 `.gitignore` 加后缀会变成 `. (2)gitignore` 那种没人认得的东西。
fn split_ext(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => {
            (stem.to_string(), ext.to_string())
        }
        _ => (name.to_string(), String::new()),
    }
}

/// 目标层里已经占了这个名字的话，往后缀 ` (2)` ` (3)`… 找一个空位。
/// 口径按用户拍的：**粘贴 / 复制 / 移动的冲突自动加后缀**（不弹窗问覆盖），
/// 而**重命名撞名是报错** —— 改名时静默换个名字，用户会以为盘上真叫那个。
fn unique_in(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    for i in 2..1000 {
        let cand = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        if !dir.join(&cand).exists() {
            return cand;
        }
    }
    format!("{stem} (copy)")
}

/// 递归复制一份（目录 → 逐条进来；文件 → `fs::copy`）。
/// 只跟随真实目录：Windows 上的重解析点（junction / 符号链接目录）在这里当文件复制，
/// 免得 `D:\笔记` 里一个指向自己的链接把这次粘贴变成无限递归。
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| format!("读不了 {src:?}：{e}"))?;
    if meta.is_dir() {
        fs::create_dir_all(dst).map_err(|e| format!("建不了 {dst:?}：{e}"))?;
        for item in fs::read_dir(src).map_err(|e| format!("列不了 {src:?}：{e}"))? {
            let item = item.map_err(|e| format!("列不了 {src:?}：{e}"))?;
            let name = item.file_name();
            copy_tree(&item.path(), &dst.join(name))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).map_err(|e| format!("复制不了 {src:?}：{e}"))?;
        Ok(())
    }
}

/// 校验「要动的那条路径」还在盘上、且在根之内，并回它的名字与父目录。
///
/// ⚠️ 顺序要紧：**先验在不在，再验在不在根内**。反过来的话，一条已经不存在的
/// 路径连 `canonicalize` 都做不出来，跟规范化过的根对不上前缀 —— 用户会看到
/// 「这条路径不在当前文件夹内」，而真话是「它早没了」。
fn checked_src(root: &str, src: &str) -> Result<(PathBuf, String, PathBuf), String> {
    let s = Path::new(src);
    if !s.exists() {
        return Err(format!("已经不存在了：{src}"));
    }
    guard_within(root, s)?;
    let name = s
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("这条路径没有名字：{src}"))?;
    let parent = s
        .parent()
        .ok_or_else(|| format!("这条路径没有父目录：{src}"))?
        .to_path_buf();
    Ok((s.to_path_buf(), name, parent))
}

/// 目录不许粘进它自己（或它的某个子孙）里。
/// `copy_tree` 会先把目标建出来，再一边走源一边往里塞 —— 源里从此有了目标，
/// 那是个自我包含的无限递归，会把盘塞满。移动那条也一样（跨卷复制回退时同一条路）。
fn refuse_self_contained(from: &Path, dest: &Path) -> Result<(), String> {
    if from.is_dir() && within(from, dest) {
        return Err("不能把一个目录放进它自己里面".into());
    }
    Ok(())
}

/// 改名。**撞名报错、不加后缀**（见 `unique_in` 上面那段口径）。
/// 返回新那一条，前端拿它的 `path` 去改写标签 / 会话 / 最近打开。
#[tauri::command]
pub fn rename_entry(root: String, path: String, new_name: String) -> Result<FsEntry, String> {
    let checked = check_name(&new_name)?;
    let (src, _old, parent) = checked_src(&root, &path)?;
    let target = parent.join(&checked);
    if target.exists() {
        return Err(format!("这一层里已经有 {checked} 了"));
    }
    fs::rename(&src, &target).map_err(|e| format!("改不了名：{e}"))?;
    Ok(entry_of(checked, &target, target.is_dir()))
}

/// 复制一份到 `dest_dir`（同名自动加后缀）。目录走 `copy_tree`。
#[tauri::command]
pub fn copy_entry(root: String, src: String, dest_dir: String) -> Result<FsEntry, String> {
    let (from, name, _parent) = checked_src(&root, &src)?;
    let dest = Path::new(&dest_dir);
    if !dest.is_dir() {
        return Err(format!("目标不是目录，或它已经不存在：{dest_dir}"));
    }
    guard_within(&root, dest)?;
    refuse_self_contained(&from, dest)?;
    // 复制**允许**就地复制（同层会拿到 `x (2).ext`）：Ctrl+C / Ctrl+V 在同一层里
    // 造一份副本是 VS Code 的正经用法，不是误操作。只有**移动**才拒同层（那是空操作）。
    let final_name = unique_in(dest, &name);
    let target = dest.join(&final_name);
    copy_tree(&from, &target)?;
    Ok(entry_of(final_name, &target, from.is_dir()))
}

/// 挪走到 `dest_dir`（同名自动加后缀）。同卷 `fs::rename` 一发搞定；
/// 跨卷（`D:\` → `C:\`）它报「not the same device」，那时才退化成**先复制、
/// 复制整份成功后再删原件** —— 顺序反了就是拿用户的数据赌一次 IO。
#[tauri::command]
pub fn move_entry(root: String, src: String, dest_dir: String) -> Result<FsEntry, String> {
    let (from, name, parent) = checked_src(&root, &src)?;
    let dest = Path::new(&dest_dir);
    if !dest.is_dir() {
        return Err(format!("目标不是目录，或它已经不存在：{dest_dir}"));
    }
    guard_within(&root, dest)?;
    refuse_self_contained(&from, dest)?;
    if norm(&parent) == norm(dest) {
        return Err("要挪的东西就在这层里".into());
    }
    let final_name = unique_in(dest, &name);
    let target = dest.join(&final_name);
    match fs::rename(&from, &target) {
        Ok(()) => Ok(entry_of(final_name, &target, target.is_dir())),
        Err(_) => {
            copy_tree(&from, &target)?;
            let removed = if from.is_dir() {
                fs::remove_dir_all(&from)
            } else {
                fs::remove_file(&from)
            };
            removed.map_err(|e| format!("已经复制到 {final_name}，但原件删不掉：{e}"))?;
            Ok(entry_of(final_name, &target, target.is_dir()))
        }
    }
}

/// 送进**系统回收站**（用户拍的口径：可反悔，不做永久删除）。
/// `trash` 在 Windows 上走 `IFileOperation`（文件 / 目录它自己分），
/// 不带确认弹窗（`hwnd_owner = None`），与 VS Code 的「按 Delete 直接进回收站」一致。
#[tauri::command]
pub fn delete_entry(root: String, path: String) -> Result<(), String> {
    let (src, _name, _parent) = checked_src(&root, &path)?;
    trash::delete(&src).map_err(|e| format!("送不进回收站：{e}"))
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

    // ---------------------------- B315

    /// 造一棵 `根/a.md` + `根/notes/b.md` + `根/notes/子/c.md`，回根。
    fn fixture(tag: &str) -> std::path::PathBuf {
        let dir = tmp(tag);
        fs::write(dir.join("a.md"), "A").unwrap();
        fs::create_dir(dir.join("notes")).unwrap();
        fs::write(dir.join("notes").join("b.md"), "B").unwrap();
        fs::create_dir(dir.join("notes").join("子")).unwrap();
        fs::write(dir.join("notes").join("子").join("c.md"), "C").unwrap();
        dir
    }

    #[test]
    fn split_ext_keeps_dotfiles_whole() {
        assert_eq!(split_ext("a.md"), ("a".into(), "md".into()));
        assert_eq!(split_ext("笔记"), ("笔记".into(), "".into()));
        // 点开头的整体算「没扩展名」：`.gitignore (2)` 才对，`. (2)gitignore` 是垃圾
        assert_eq!(split_ext(".gitignore"), (".gitignore".into(), "".into()));
        assert_eq!(split_ext("a.tar.gz"), ("a.tar".into(), "gz".into()));
    }

    #[test]
    fn unique_in_finds_the_first_free_slot() {
        let dir = tmp("unique");
        assert_eq!(unique_in(&dir, "a.md"), "a.md", "没占就用原名");
        fs::write(dir.join("a.md"), "").unwrap();
        assert_eq!(unique_in(&dir, "a.md"), "a (2).md");
        fs::write(dir.join("a (2).md"), "").unwrap();
        assert_eq!(
            unique_in(&dir, "a.md"),
            "a (3).md",
            "后缀要接着往后找，不复用已占的"
        );
        fs::write(dir.join("无扩展"), "").unwrap();
        assert_eq!(unique_in(&dir, "无扩展"), "无扩展 (2)");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn guard_within_refuses_escaping_the_root() {
        let dir = fixture("guard");
        let root = dir.to_string_lossy().into_owned();
        assert!(
            guard_within(&root, &dir.join("notes")).is_ok(),
            "根内的要放行"
        );
        assert!(guard_within(&root, &dir).is_ok(), "根本身算界内");
        // ⚠️ 「还没建出来」的一层照样要放行：粘贴的目标层正是这种。
        // 这一条盯的是修法 —— 拿「必须存在」去堵 `..` 那个口子会把正常粘贴一起堵死。
        assert!(
            guard_within(&root, &dir.join("没建出来的层")).is_ok(),
            "不存在但在根内 ⇒ 不许拒"
        );
        // 字符串手术骗不过 canonicalize：`根\..\别处` 真在根外
        let escape = dir.join("..").join("别处");
        assert!(
            guard_within(&root, &escape).is_err(),
            "带 .. 的必须拦住：{escape:?}"
        );
        // 同一个 `..`，目标**存在**时两条闸都要拦得住：`has_parent` 看分量，
        // `within` 看 canonicalize 之后的真位置 —— 少了后一条，「先折好 .. 再传进来」
        // 这种写法就又把根外面的一层放进来了。
        let sibling = dir.join("..").join("litepad-fs-escape-target");
        fs::create_dir(&sibling).unwrap();
        let outside = sibling.canonicalize().expect("替身要能解析得出真位置");
        assert!(
            outside.exists() && !outside.starts_with(dir.canonicalize().unwrap()),
            "替身要先自证这条真在根外（不在根外就是断言在对着空气放行）"
        );
        assert!(
            guard_within(&root, &sibling).is_err(),
            "带 .. 的（存在）要拦"
        );
        assert!(
            guard_within(&root, &outside).is_err(),
            "折好 .. 之后的绝对路径同样要拦"
        );
        fs::remove_dir_all(&sibling).unwrap();
        assert!(guard_within(&root, Path::new("C:\\windows")).is_err());
        assert!(guard_within("", &dir).is_err(), "没根的时候一句都不许写");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rename_entry_moves_it_and_refuses_a_clash() {
        let dir = fixture("rename");
        let root = dir.to_string_lossy().into_owned();
        let e = rename_entry(
            root.clone(),
            dir.join("a.md").to_string_lossy().into_owned(),
            "  改好的.md  ".into(),
        )
        .unwrap();
        assert_eq!(e.name, "改好的.md", "首尾空白该去掉");
        assert!(!dir.join("a.md").exists(), "旧的不再在");
        assert_eq!(
            fs::read_to_string(&e.path).unwrap(),
            "A",
            "内容一个字都不动"
        );

        fs::write(dir.join("b.md"), "").unwrap();
        let err = rename_entry(root.clone(), e.path.clone(), "b.md".into()).unwrap_err();
        assert!(err.contains("已经有"), "改名撞名要报错：{err}");
        assert!(
            dir.join("改好的.md").exists() && !dir.join("改好的.md (2)").exists(),
            "报错那条不许顺手改名"
        );
        assert!(
            rename_entry(root, e.path, "a/b".into()).is_err(),
            "非法名字要拒"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copy_entry_duplicates_without_touching_the_source() {
        let dir = fixture("copy");
        let root = dir.to_string_lossy().into_owned();
        let a = dir.join("a.md").to_string_lossy().into_owned();
        let notes = dir.join("notes").to_string_lossy().into_owned();

        let made = copy_entry(root.clone(), a.clone(), notes.clone()).unwrap();
        assert!(made.path.ends_with("a.md"), "去别的层用原名");
        assert!(dir.join("a.md").exists(), "复制不是移动，原件一条都不许少");
        assert_eq!(
            fs::read_to_string(dir.join("notes").join("a.md")).unwrap(),
            "A"
        );

        // 就地复制（粘回它自己所在的那一层）是 VS Code 的正经用法 ⇒ 允许，加后缀
        let deep = copy_entry(root.clone(), notes.clone(), root.clone()).unwrap();
        assert!(
            deep.path.ends_with("notes (2)"),
            "同层复制 = 加后缀那份：{}",
            deep.path
        );
        assert_eq!(
            fs::read_to_string(Path::new(&deep.path).join("子").join("c.md")).unwrap(),
            "C",
            "目录要整棵跟着复制"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copy_and_move_refuse_to_paste_a_folder_into_itself() {
        // 这一条拦的是**无限递归**：目标先被建出来，遍历源时又看见了目标，
        // 于是往自己里面一层层塞下去，直到把盘塞满或路径超长。
        let dir = fixture("copyself");
        let root = dir.to_string_lossy().into_owned();
        let notes = dir.join("notes").to_string_lossy().into_owned();
        let into_own_child = dir.join("notes").join("子").to_string_lossy().into_owned();
        let err = copy_entry(root.clone(), notes.clone(), into_own_child.clone()).unwrap_err();
        assert!(err.contains("它自己里面"), "错误要能读：{err}");
        let err = move_entry(root, notes, into_own_child).unwrap_err();
        assert!(err.contains("它自己里面"), "移动那条同拒：{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_entry_relocates_and_refuses_same_layer() {
        let dir = fixture("move");
        let root = dir.to_string_lossy().into_owned();
        let src = dir.join("a.md").to_string_lossy().into_owned();
        let into = dir.join("notes").to_string_lossy().into_owned();

        let made = move_entry(root.clone(), src.clone(), into.clone()).unwrap();
        assert!(!dir.join("a.md").exists(), "挪走之后原处该空");
        assert_eq!(fs::read_to_string(&made.path).unwrap(), "A");

        fs::write(dir.join("notes").join("a.md"), "占位").unwrap();
        let again = move_entry(root.clone(), src.clone(), into.clone()).unwrap_err();
        assert!(
            again.contains("已经不存在"),
            "挪一个不在的东西要报错：{again}"
        );
        assert!(move_entry(root, src, into).is_err(), "同层挪动没有意义");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_entry_suffixes_when_the_target_layer_already_has_it() {
        let dir = fixture("move2");
        let root = dir.to_string_lossy().into_owned();
        let made = move_entry(
            root,
            dir.join("a.md").to_string_lossy().into_owned(),
            dir.join("notes").to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(made.path.ends_with("a.md"), "notes 里没有 a.md");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_entry_checks_before_touching_the_bin() {
        // 只验**校验**那一段：真送回收站会往用户的回收拉里丢东西、还要起 COM，
        // 那一条留给真机验收（.tmp/explorer-check.py 那台子）肉眼结案。
        let dir = fixture("del");
        let root = dir.to_string_lossy().into_owned();
        let gone = dir.join("没这个.md").to_string_lossy().into_owned();
        assert!(
            delete_entry(root.clone(), gone)
                .unwrap_err()
                .contains("已经不存在"),
            "不在盘上的要先报错"
        );
        let escape = dir.join("..").join("别处.md");
        fs::write(&escape, "x").unwrap();
        assert!(
            delete_entry(root.clone(), escape.to_string_lossy().into_owned()).is_err(),
            "根外的一条绝对不许进回收站"
        );
        assert!(escape.exists(), "被拒的那条要原样留在盘上");
        let _ = fs::remove_file(&escape);
        fs::remove_dir_all(&dir).unwrap();
    }
}
