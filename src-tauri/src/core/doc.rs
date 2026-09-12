//! 文档元数据与文件级别的守卫。

use std::path::Path;

use super::codec::Encoding;
use super::eol::Eol;

/// M0 的打开上限。大文件分级降级策略属于 M4，届时这里改成阈值表。
pub const MAX_OPEN_BYTES: u64 = 20 * 1024 * 1024;

/// 打开文档在 Rust 侧的「真实状态」。
/// 前端只持有文本 buffer 与视图状态，避免双份真相（见方案 3 设计原则 1）。
///
/// `id` 是标签唯一标识（应用生命周期内自增），前端按 id 寻址文档，
/// 避免 Vec 索引在关闭标签后漂移。未关联磁盘路径时 `path` 为空。
///
/// M2 的会话恢复、自动保存、外部修改检测将直接读取这些字段。
#[derive(Debug, Clone)]
pub struct Doc {
    pub id: u64,
    pub path: std::path::PathBuf,
    pub encoding: Encoding,
    pub eol: Eol,
    pub readonly: bool,
}

/// 前 8 KB 内出现 NUL 基本可以判定为二进制。
pub fn is_probably_binary(bytes: &[u8]) -> bool {
    let end = bytes.len().min(8192);
    bytes[..end].contains(&0u8)
}

/// 只读检测（NTFS 只读属性）。
pub fn is_readonly(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(meta) => meta.permissions().readonly(),
        Err(_) => false,
    }
}
