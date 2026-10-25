//! B385 · 文件关联（设置页「文件关联」分类）：把「双击某扩展名 → 用 LitePad 打开」
//! 做成**运行时可开关**的注册表读写，免管理员（全部落在 HKCU）。
//!
//! 口径（Windows）：
//! - ProgID：`Software\Classes\LitePad.Assoc.<ext>`
//!     - 默认值 = 「LitePad <EXT> 文件」（资源管理器「打开方式」里显示的名字）
//!     - `DefaultIcon` = `"<当前 exe>",0`
//!     - `shell\open\command` = `"<当前 exe>" "%1"` —— 关联指向**当时注册它的那个
//!       exe**（安装版注册的指向安装版、开发构建注册的指向开发构建），换二进制后
//!       重新开关一次即可修正。
//! - 扩展名键：`Software\Classes\.<ext>`
//!     - `OpenWithProgids` 下加一个以 ProgID 为名的空值 ⇒ 出现在资源管理器
//!       「打开方式」的候选里；
//!     - 默认值改指我们的 ProgID ⇒ **在没有 UserChoice 的机器上**就是默认打开方式。
//!       旧默认值先存进 ProgID 的 `LitePad.Prev`，撤销时原样还回去。
//! - ⚠️ Win10+ 资源管理器实际优先读 `FileExts\.<ext>\UserChoice`（哈希保护，
//!   微软官方不支持程序化写）——那层我们不动。所以「开了但双击还是别的程序」
//!   是正常现象，设置页有「打开系统默认应用设置」让用户做最终确认。
//!
//! ⚠️ 职责边界（照 explorer.rs 那一刀）：判定与写入都收在这里，前端只管开关的
//! 状态展示。双击接住文件靠 `assoc_args_to_open`，它的扩展名名单也以本模块的
//! 注册表枚举为准 —— 用户关联了 .txt，双击 .txt 才能进得来。
//!
//! 注册表键名只有本模块知道；`PROGID_PREFIX` / `PREV_VALUE` 两个常量是前端与
//! 单元测试之外唯一的命名出处。

use std::collections::HashSet;
use std::os::windows::process::CommandExt;

use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

/// 我们 ProgID 的统一前缀：`LitePad.Assoc.<ext>`。枚举本机关联名单就靠这个前缀。
const PROGID_PREFIX: &str = "LitePad.Assoc.";

/// 撤销关联时「记着旧默认值」的存放处（ProgID 键下的一个 REG_SZ 值）。
const PREV_VALUE: &str = "LitePad.Prev";

/// 固定候选（B385 二轮扩容：常见**文本**格式全家桶 —— 关联只对这些有意义，
/// 二进制格式不在其列）。用户自定义的扩展名注册后由枚举带出来，不存前端设置
/// —— 注册表是唯一权威。
pub const CANDIDATE_EXTS: &[&str] = &[
    "md",
    "markdown",
    "txt",
    "log",
    "csv",
    "tsv",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "less",
    "js",
    "ts",
    "py",
    "rs",
    "go",
    "java",
    "c",
    "cpp",
    "h",
    "cs",
    "sh",
    "bat",
    "cmd",
    "ps1",
    "sql",
];

/// 一条关联的当前状态（字段 camelCase，口径同 `FsEntry`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssocEntry {
    /// 不带点的扩展名（"md"）。
    pub ext: String,
    /// 我们的 ProgID 是否注册在册（= 设置页开关的「开」）。
    pub registered: bool,
    /// `Classes\.<ext>` 的默认值是否指向我们的 ProgID（= 系统层面的默认打开方式
    /// 归我们 —— UserChoice 存在时它可能仍是 false，见模块头）。
    pub is_default: bool,
}

/// 扩展名清洗：去首点、小写；只留 `[0-9a-z_+~-]`，长度 1–16。
/// 返回 None = 前端别把这种东西送进注册表（"`.md .txt`"、空串、带路径分隔符…）。
pub fn normalize_ext(ext: &str) -> Option<String> {
    let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if e.is_empty() || e.len() > 16 {
        return None;
    }
    // Windows 扩展名实际允许的字符比这宽，但关联入口没必要收下「看得懂但说不清」的
    // 名字；名单里都是普通文本格式，这一档足够，也顺便挡住路径分隔符与通配符。
    if !e
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '+' | '-' | '~'))
    {
        return None;
    }
    Some(e)
}

fn progid_of(ext: &str) -> String {
    format!("{PROGID_PREFIX}{ext}")
}

/// HKCU\Software\Classes，读写都要。
fn classes_key() -> Result<RegKey, String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Classes", KEY_READ | KEY_WRITE)
        .map_err(|e| format!("打开注册表 Software\\Classes 失败：{e}"))
}

/// 我们的 ProgID 是否在册（= 开关的「开」）。
/// 判据是 `shell\open\command` 子键在 —— 只有键名残留不算注册成功。
fn is_registered(classes: &RegKey, ext: &str) -> bool {
    classes
        .open_subkey_with_flags(
            format!("{}\\shell\\open\\command", progid_of(ext)),
            KEY_READ,
        )
        .is_ok()
}

/// `Classes\.<ext>` 的默认值是否指向我们的 ProgID。
fn is_default(classes: &RegKey, ext: &str) -> bool {
    classes
        .open_subkey(format!(".{ext}"))
        .and_then(|k| k.get_value::<String, _>(""))
        .map(|v| v == progid_of(ext))
        .unwrap_or(false)
}

/// 枚举本机**由我们注册过**的扩展名（HKCU\Software\Classes 下 PROGID_PREFIX 开头的键）。
/// 用户自定义关联不落前端设置，这张名单就是它们的全部出处。
pub fn registered_exts() -> Vec<String> {
    let Ok(classes) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Classes") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in classes.enum_keys().flatten() {
        if let Some(ext) = name.strip_prefix(PROGID_PREFIX) {
            if !ext.is_empty() {
                out.push(ext.to_ascii_lowercase());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// 双击接得住的扩展名集合：基座（md / markdown，装包注册的那两种）∪ 本机已注册的。
/// `assoc_args_to_open` 用它替掉原先写死的两个扩展名。
pub fn openable_exts() -> HashSet<String> {
    let mut set: HashSet<String> = ["md", "markdown"].iter().map(|s| s.to_string()).collect();
    set.extend(registered_exts());
    set
}

/// 注册关联：建 ProgID 子树 + `.ext` 的 OpenWithProgids + 改默认值（旧的先存）。
/// `exe` 取当前进程可执行文件 —— 关联永远指向注册它的那一份。
fn register(classes: &RegKey, ext: &str) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("取当前程序路径失败：{e}"))?
        .to_string_lossy()
        .into_owned();
    let progid = progid_of(ext);

    let (key, _) = classes
        .create_subkey(&progid)
        .map_err(|e| format!("创建 {progid} 失败：{e}"))?;
    key.set_value("", &format!("LitePad {} 文件", ext.to_uppercase()))
        .map_err(|e| format!("写 {progid} 默认值失败：{e}"))?;
    let (icon, _) = key
        .create_subkey("DefaultIcon")
        .map_err(|e| e.to_string())?;
    icon.set_value("", &format!("\"{exe}\",0"))
        .map_err(|e| e.to_string())?;
    let (cmd, _) = key
        .create_subkey("shell\\open\\command")
        .map_err(|e| e.to_string())?;
    cmd.set_value("", &open_command(&exe))
        .map_err(|e| e.to_string())?;

    // 旧默认值先记后改：撤销时还回去，不把用户原来指向的程序弄丢。
    let ext_key = classes
        .open_subkey_with_flags(format!(".{ext}"), KEY_READ | KEY_WRITE)
        .or_else(|_| classes.create_subkey(format!(".{ext}")).map(|(k, _)| k))
        .map_err(|e| format!("打开 .{ext} 失败：{e}"))?;
    let prev = ext_key.get_value::<String, _>("").ok();
    if let Some(prev) = prev {
        if prev != progid {
            key.set_value(PREV_VALUE, &prev)
                .map_err(|e| e.to_string())?;
        }
    }
    // OpenWithProgids 是 `.<ext>` 下的**子键**，候选以「值名」为准，每个 ProgID 一个空值。
    let (owp, _) = ext_key
        .create_subkey("OpenWithProgids")
        .map_err(|e| format!("创建 .{ext}\\OpenWithProgids 失败：{e}"))?;
    owp.set_value(&progid, &String::new())
        .map_err(|e| e.to_string())?;
    ext_key
        .set_value("", &progid)
        .map_err(|e| format!("把 .{ext} 默认值改指 {progid} 失败：{e}"))?;
    Ok(())
}

/// 撤销关联：删 ProgID 子树 + 从 OpenWithProgids 里摘掉自己 + 默认值还旧账。
fn unregister(classes: &RegKey, ext: &str) -> Result<(), String> {
    let progid = progid_of(ext);
    if let Ok(progid_key) = classes.open_subkey(&progid) {
        let prev: Option<String> = progid_key.get_value(PREV_VALUE).ok();
        if let Ok(ext_key) = classes.open_subkey_with_flags(format!(".{ext}"), KEY_READ | KEY_WRITE)
        {
            let cur: Option<String> = ext_key.get_value("").ok();
            if cur.as_deref() == Some(progid.as_str()) {
                match prev {
                    // 有关旧账就还原，别把用户原本的关联弄丢
                    Some(p) => {
                        let _ = ext_key.set_value("", &p);
                    }
                    None => {
                        let _ = ext_key.delete_value("");
                    }
                }
            }
            if let Ok(owp) = ext_key.open_subkey_with_flags("OpenWithProgids", KEY_WRITE) {
                let _ = owp.delete_value(&progid);
            }
        }
        classes
            .delete_subkey_all(&progid)
            .map_err(|e| format!("删除 {progid} 失败：{e}"))?;
    }
    Ok(())
}

/// `shell\open\command` 的标准拼法：路径带引号 + `"%1"` 占位（纯函数，可单测）。
fn open_command(exe: &str) -> String {
    format!("\"{exe}\" \"%1\"")
}

/// 候选名单 = 固定候选 ∪ 本机已注册的（自定义的从注册表长出来）。
fn candidate_exts() -> Vec<String> {
    let mut out: Vec<String> = CANDIDATE_EXTS
        .iter()
        .map(|s| s.to_string())
        .chain(registered_exts())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// 设置页「文件关联」分类的整表状态。
#[tauri::command]
pub fn assoc_list() -> Vec<AssocEntry> {
    match classes_key() {
        Ok(classes) => candidate_exts()
            .into_iter()
            .map(|ext| AssocEntry {
                is_default: is_default(&classes, &ext),
                registered: is_registered(&classes, &ext),
                ext,
            })
            .collect(),
        // 打不开注册表（理论上不会）就报「全没关」的空表，让设置页显示空态而不是炸
        Err(_) => candidate_exts()
            .into_iter()
            .map(|ext| AssocEntry {
                ext,
                registered: false,
                is_default: false,
            })
            .collect(),
    }
}

/// 开 / 关一个扩展名的关联。返回刷新后的该条状态（前端免得再查一次整表）。
#[tauri::command]
pub fn assoc_set(ext: String, on: bool) -> Result<AssocEntry, String> {
    let ext = normalize_ext(&ext).ok_or_else(|| format!("不支持的扩展名：{ext}"))?;
    let classes = classes_key()?;
    if on {
        register(&classes, &ext)?;
    } else {
        unregister(&classes, &ext)?;
    }
    Ok(AssocEntry {
        is_default: is_default(&classes, &ext),
        registered: is_registered(&classes, &ext),
        ext,
    })
}

/// 打开系统「默认应用」设置页：UserChoice 被别的程序占着时，最终档只能用户自己在
/// 那里拍（见模块头）。
#[tauri::command]
pub fn assoc_open_system_settings() -> Result<(), String> {
    // start 是 cmd 内建 ⇒ 必须经 cmd /c；"" 是 start 的窗口标题占位。
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:defaultapps"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：别闪一个黑框
        .spawn()
        .map_err(|e| format!("打开系统默认应用设置失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_ext_trims_dot_and_lowercases() {
        assert_eq!(normalize_ext(".MD").as_deref(), Some("md"));
        assert_eq!(normalize_ext("  Markdown ").as_deref(), Some("markdown"));
        assert_eq!(normalize_ext("txt").as_deref(), Some("txt"));
    }

    #[test]
    fn normalize_ext_rejects_junk() {
        assert!(normalize_ext("").is_none());
        assert!(normalize_ext(". .").is_none());
        assert!(normalize_ext("a/b").is_none());
        assert!(normalize_ext("a b").is_none());
        assert!(normalize_ext("*").is_none());
        // 16 字符上限
        assert!(normalize_ext("abcdefghijklmno").is_some());
        assert!(normalize_ext("abcdefghijklmnop").is_some());
        assert!(normalize_ext("abcdefghijklmnopq").is_none());
    }

    #[test]
    fn progid_naming_is_stable() {
        assert_eq!(progid_of("md"), "LitePad.Assoc.md");
        assert_eq!(progid_of("markdown"), "LitePad.Assoc.markdown");
    }

    #[test]
    fn command_line_quotes_path_and_arg() {
        assert_eq!(
            open_command(r"C:\Program Files\LitePad\litepad.exe"),
            "\"C:\\Program Files\\LitePad\\litepad.exe\" \"%1\""
        );
    }

    #[test]
    fn openable_exts_includes_base_and_registered() {
        // 基座永远在（装包注册的那两种），注册表枚举结果拼在后面。
        let set = openable_exts();
        assert!(set.contains("md") && set.contains("markdown"));
    }
}
