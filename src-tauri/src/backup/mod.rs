//! 热退出（Hot Exit）备份：把未保存的工作副本写进「备份区」。
//!
//! 备份区 = `session::config_dir()` 下的 `backups/`，默认 `%APPDATA%\LitePad\backups`；
//! 设了 `LITEPAD_CONFIG_DIR` 就整体迁移（截图脚本靠它把一切写进项目内 `.tmp/shot/config`）。
//!
//! 对应 VS Code 的 `WorkingCopyBackupService` + `WorkingCopyBackupTracker`。
//! 与「自动保存」的区别是本质的，别把两者混为一谈：
//!
//! - **自动保存**（`files.autoSave`）把内容写回**原文件**，脏标记随之清除；
//! - **热退出**（`files.hotExit`）把内容写进**独立副本**，原文件一个字节都不动，
//!   因此关窗时不需要弹「未保存的内容将丢失」的确认框，下次启动再把副本
//!   还原成未保存标签。
//!
//! VS Code 里「关窗不弹确认框」是 Hot Exit 的职责而不是 Auto Save 的：
//! `files.hotExit` 取 `off` 时的官方说明原文就是
//! "A prompt will show when attempting to close a window with editors that
//! have unsaved changes."
//!
//! # 副本文件格式
//!
//! 一个文档一个文件，头部 + 正文，**没有外部索引**——崩溃后仍可直接读回来：
//!
//! ```text
//! LitePadBackup/1\n
//! {"id":"…","path":"…","name":"…","encoding":"…","eol":"…","mixedEol":false}\n
//! <正文：UTF-8、LF 归一化>
//! ```
//!
//! 头部单独占一行 JSON 而不是二进制前缀，是为了能用编辑器直接打开副本排查问题。
//! 正文一律存 UTF-8（即内存表示），文档原本声明的编码记在头部、还原时交回前端，
//! 于是副本与 GBK / UTF-16 之类的原编码无关。
//!
//! # 为什么文件名是外部给的 ID 而不是路径哈希
//!
//! VS Code 用 `hashIdentifier(resource)` 当文件名，因为它要先枚举备份区、
//! 再从副本内容里的 preamble 反解出「这份副本属于谁」。LitePad 只有单窗口单会话，
//! `session.json` 本身就是天然索引，所以直接由前端生成一次性的随机 ID（UUID），
//! 一个 ID 对应一个文档、跨会话稳定。副作用是备份区不需要再按 scheme 分子目录。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::core::atomic_write;

/// 副本头部魔数 + 格式版本。改格式必须同时改这里与回归测试的期望。
pub const MAGIC: &str = "LitePadBackup/1";

/// 备份区根目录：`%APPDATA%\LitePad\backups`（随 `LITEPAD_CONFIG_DIR` 一起迁移）。
///
/// ⚠️ 必须跟着 `session::config_dir()` 走，不能自己再拼一遍 APPDATA：
/// 截图脚本把配置目录指向项目内时，热退出副本若仍写回用户目录，就等于
/// 「不碰用户目录」这件事只做了一半（副本会留下真实的会话残留）。
pub fn backup_root() -> Option<PathBuf> {
    crate::session::config_dir().map(|d| d.join("backups"))
}

/// 备份 ID 白名单校验：ASCII 字母数字与连字符，长度 1–64。
///
/// ⚠️ 这是**安全边界**，不是格式洁癖：ID 由前端生成后直接参与拼路径，
/// 一旦放行 `../`、`..\` 或 `/`，副本就能写到备份区之外去。
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 指定备份区目录下的副本路径；ID 非法返回 None。
pub fn backup_path_in(root: &Path, id: &str) -> Option<PathBuf> {
    if !is_valid_id(id) {
        return None;
    }
    Some(root.join(id))
}

/// 正式备份区里的副本路径。
pub fn backup_path(id: &str) -> Option<PathBuf> {
    backup_path_in(&backup_root()?, id)
}

/// 副本头部：还原一个未保存标签所需的全部元数据。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupMeta {
    pub id: String,
    /// 原路径；未命名文档为空串
    pub path: String,
    pub name: String,
    pub encoding: String,
    pub eol: String,
    /// 打开时原文件是否混合行尾（还原后状态栏提示要与关闭前一致）
    #[serde(alias = "mixed_eol")]
    pub mixed_eol: bool,
}

/// 完整副本：头部 + 正文（LF 归一化的文本）。
#[derive(Debug, Clone)]
pub struct Backup {
    pub meta: BackupMeta,
    pub text: String,
}

/// 序列化成一个副本文件的完整字节。
pub fn encode(meta: &BackupMeta, text: &str) -> Vec<u8> {
    // 头部必须单行：to_string 不产生换行，to_string_pretty 会（那会把正文的行号算错）。
    let head = serde_json::to_string(meta).unwrap_or_else(|_| "{}".to_string());
    let mut out = Vec::with_capacity(MAGIC.len() + head.len() + text.len() + 2);
    out.extend_from_slice(MAGIC.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(head.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(text.as_bytes());
    out
}

/// 解析副本字节；魔数不符 / 头部 JSON 坏掉一律返回 None。
///
/// 返回 None 的含义是「没有可用副本」而不是「出错了」：调用方据此退回按原
/// 路径打开原文件。一个坏副本绝不能让整个会话恢复失败。
pub fn decode(bytes: &[u8]) -> Option<Backup> {
    // 严格 UTF-8：头部是 ASCII，正文是我们自己按 UTF-8 写进去的。
    let all = std::str::from_utf8(bytes).ok()?;
    let rest = all.strip_prefix(MAGIC)?.strip_prefix('\n')?;
    let (head, body) = rest.split_once('\n')?;
    let meta: BackupMeta = serde_json::from_str(head).ok()?;
    Some(Backup {
        meta,
        text: body.to_string(),
    })
}

/// 写入指定备份区目录；目录不存在则创建。
pub fn write_to(root: &Path, meta: &BackupMeta, text: &str) -> Result<(), String> {
    let path = backup_path_in(root, &meta.id).ok_or_else(|| format!("非法备份 ID：{}", meta.id))?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    atomic_write::atomic_write(&path, &encode(meta, text)).map_err(|e| e.to_string())
}

/// 从指定备份区目录读取。
pub fn read_from(root: &Path, id: &str) -> Option<Backup> {
    let bytes = fs::read(backup_path_in(root, id)?).ok()?;
    decode(&bytes)
}

/// 写入正式备份区。
pub fn write(meta: &BackupMeta, text: &str) -> Result<(), String> {
    let root = backup_root().ok_or_else(|| "无法定位 %APPDATA% 目录".to_string())?;
    write_to(&root, meta, text)
}

/// 从正式备份区读取。
pub fn read(id: &str) -> Option<Backup> {
    read_from(&backup_root()?, id)
}

/// 丢弃副本。文件不存在视为成功。
///
/// 「丢弃」必须幂等：保存时、文档转干净时、关闭标签时都会调，
/// 同一次编辑里重复调是常态，报错只会刷屏。
pub fn discard(id: &str) -> Result<(), String> {
    let Some(path) = backup_path(id) else {
        return Ok(());
    };
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 备份区里现存的全部 ID（非法文件名直接忽略）。目录不存在时返回空表。
pub fn list_ids_in(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|id| is_valid_id(id))
        .collect()
}

/// 纯函数：哪些现存 ID 属于该清理的孤儿（不在 `keep` 里）。
/// 抽出来是为了能脱离文件系统做单测。
pub fn orphans(all: &[String], keep: &[String]) -> Vec<String> {
    all.iter()
        .filter(|id| !keep.iter().any(|k| k == *id))
        .cloned()
        .collect()
}

/// 清理孤儿副本，返回删除个数。
///
/// ⚠️ 调用方必须先确认会话**读成功了**：会话文件坏掉时 `keep` 会是空表，
/// 那时候无条件清理等于把用户全部未保存内容删掉。宁可漏删，不可错删。
pub fn discard_orphans_in(root: &Path, keep: &[String]) -> Result<usize, String> {
    let mut removed = 0;
    for id in orphans(&list_ids_in(root), keep) {
        let Some(path) = backup_path_in(root, &id) else {
            continue;
        };
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(removed)
}

/// 清理正式备份区里的孤儿副本。
pub fn discard_orphans(keep: &[String]) -> Result<usize, String> {
    match backup_root() {
        Some(root) => discard_orphans_in(&root, keep),
        None => Ok(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> BackupMeta {
        BackupMeta {
            id: "2f1c9b7a-0000-4e11-9a55-abcdef123456".into(),
            path: "C:\\demo\\note.md".into(),
            name: "note.md".into(),
            encoding: "UTF-8".into(),
            eol: "CRLF".into(),
            mixed_eol: false,
        }
    }

    /// 基础不变量：写进去什么，读出来必须一模一样（含末尾空行与 CR 之外的怪字符）。
    #[test]
    fn round_trip_preserves_meta_and_text() {
        let text = "# 标题\n\n正文 with ünïcode 😀\n\ntrailing newline\n";
        let bytes = encode(&meta(), text);
        let back = decode(&bytes).expect("自家写的副本必须能读回");
        assert_eq!(back.meta, meta());
        assert_eq!(back.text, text, "正文必须逐字节还原（含末尾换行）");
    }

    /// 空文档也要能还原：不能把「空正文」与「格式坏了」混为一谈。
    #[test]
    fn empty_text_round_trips() {
        let back = decode(&encode(&meta(), "")).expect("空正文也是合法副本");
        assert_eq!(back.meta, meta());
        assert_eq!(back.text, "");
    }

    /// 正文本身可以包含魔数、`{` 这类字符，不能被误判成头部。
    /// 头部只占前两行，正文可以有任意多行——这是「行切分」而非「扫描」的原因。
    #[test]
    fn body_may_contain_magic_and_braces() {
        let text = format!("{MAGIC}\n{{\"id\":\"假的\"}}\nLitePadBackup/2\n");
        let back = decode(&encode(&meta(), &text)).expect("正文含魔数也应能读回");
        assert_eq!(back.text, text);
        assert_eq!(back.meta.id, meta().id, "不能被正文里的假头部顶掉");
    }

    /// 魔数不符 / 头部截断 / 根本不是文本：一律 None，交给调用方退回原文件。
    #[test]
    fn bad_input_yields_none() {
        assert!(decode(b"").is_none(), "空文件不是副本");
        assert!(decode(b"LitePadBackup/2\n{}\n").is_none(), "版本不符应拒绝");
        assert!(
            decode(b"LitePadBackup/1\n").is_none(),
            "只有魔数没有头部分隔行"
        );
        assert!(
            decode(b"LitePadBackup/1\nnot json\nx").is_none(),
            "头部不是 JSON"
        );
        assert!(decode(b"random bytes\x00\x01").is_none());

        // 头部是合法 JSON 但字段全缺 → 采取「宽容读入 + 默认值」，
        // 与 Settings/TabSession 的 #[serde(default)] 同一策略：
        // 多一个可读副本永远好过多一个被丢弃的副本。
        let bare = decode(b"LitePadBackup/1\n{}\nbody").expect("空 JSON 头部应宽容接受");
        assert_eq!(bare.meta.id, "", "缺 id 回落空串");
        assert_eq!(bare.text, "body");
    }

    /// 头部字段线上格式必须是 camelCase（与前端 BackupMeta 对齐），
    /// 且必须含 mixedEol —— 丢了它，还原后状态栏的混合行尾提示会消失。
    #[test]
    fn header_is_single_line_camel_case() {
        let mut m = meta();
        m.mixed_eol = true;
        let bytes = encode(&m, "x");
        let head = std::str::from_utf8(&bytes).unwrap().lines().nth(1).unwrap();
        assert!(
            head.contains("\"mixedEol\":true"),
            "头部应为 camelCase：{head}"
        );
        assert!(!head.contains("mixed_eol"), "不该落盘 snake_case：{head}");
        // 头部必须单行，否则正文的行号会被算错
        assert!(!head.contains('\n'));
        // 旧版可能落过 snake_case，仍要能读
        let legacy = format!("{MAGIC}\n{{\"id\":\"a\",\"mixed_eol\":true}}\nbody");
        let back = decode(legacy.as_bytes()).expect("旧 snake_case 头部要兼容");
        assert!(back.meta.mixed_eol);
        assert_eq!(back.text, "body");
    }

    /// ID 白名单是安全边界：路径穿越必须被挡在 `backup_path_in` 之外。
    #[test]
    fn id_validation_blocks_path_traversal() {
        assert!(is_valid_id("2f1c9b7a-0000-4e11"));
        assert!(is_valid_id("ABC123"));

        for bad in [
            "", "..", "../evil", "..\\evil", "a/b", "a\\b", "C:evil", "a b", "a.m", "a\nb",
        ] {
            assert!(!is_valid_id(bad), "{bad:?} 必须被判非法");
            assert!(
                backup_path_in(Path::new("C:\\root"), bad).is_none(),
                "{bad:?} 不能拼出路径"
            );
        }

        // 长度上限：64 位以内放行，65 位拒绝
        assert!(is_valid_id(&"a".repeat(64)));
        assert!(!is_valid_id(&"a".repeat(65)));
    }

    /// 孤儿判定：只删不在 keep 里的，且保序可预期。
    #[test]
    fn orphans_keeps_referenced_ids() {
        let all: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let keep: Vec<String> = ["b"].iter().map(|s| s.to_string()).collect();
        assert_eq!(orphans(&all, &keep), vec!["a".to_string(), "c".to_string()]);
        // keep 为空 = 全部是孤儿（调用方必须已确认会话读成功！）
        assert_eq!(orphans(&all, &[]).len(), 3);
        // keep 里有不存在的 ID 也不该 panic
        let keep2: Vec<String> = ["zzz"].iter().map(|s| s.to_string()).collect();
        assert_eq!(orphans(&all, &keep2).len(), 3);
    }

    /// 真机走一遍写→读→清理，确认目录会被创建、副本会被认出来。
    #[test]
    fn write_read_discard_on_temp_dir() {
        let root = std::env::temp_dir().join(format!("litepad-backup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let m = meta();
        write_to(&root, &m, "hello\nworld\n").expect("写副本应成功（目录会自动创建）");
        assert!(root.join(&m.id).is_file(), "副本文件应落在备份区里");

        let back = read_from(&root, &m.id).expect("刚写的副本应能读回");
        assert_eq!(back.text, "hello\nworld\n");
        assert_eq!(list_ids_in(&root), vec![m.id.clone()]);

        // 非法 ID 读不到；孤儿清理只删不在 keep 里的
        assert!(read_from(&root, "../x").is_none());
        let other = "other-id".to_string();
        write_to(
            &root,
            &BackupMeta {
                id: other.clone(),
                ..m.clone()
            },
            "y",
        )
        .unwrap();
        assert_eq!(discard_orphans_in(&root, &[m.id.clone()]).unwrap(), 1);
        assert!(root.join(&m.id).is_file(), "被引用的副本必须留着");
        assert!(!root.join(&other).is_file(), "孤儿副本应被清掉");

        let _ = fs::remove_dir_all(&root);
    }
}
